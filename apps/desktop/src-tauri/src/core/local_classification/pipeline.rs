//! Serial Jev analysis with an independent, bounded Cloud completion queue.
use super::{data, jev, CurrentAsset, JevProgress, LocalClassifier};
use crate::codex::understand::UnderstandProvider;
use crate::core::paths::LibraryPaths;
use crate::db::Database;
use futures_util::{future::BoxFuture, stream::FuturesUnordered, FutureExt, StreamExt};
use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::time::Duration;

const CLOUD_CONCURRENCY: usize = 4;

#[derive(Clone)]
pub(super) struct PendingClassification {
    pub id: String,
    pub revision: i64,
    pub prediction: data::Prediction,
    pub record_observation: bool,
    pub evaluated: Vec<String>,
    pub needs_discovery: bool,
    pub preview: Vec<jev::PreviewLabel>,
}

impl LocalClassifier {
    pub(super) async fn run_jev_queue(
        &self,
        db: &Database,
        library: &LibraryPaths,
        targets: &[String],
        tag: Option<&str>,
        judge: &jev::Judge,
        cloud: &dyn UnderstandProvider,
        notify: impl Fn(bool),
    ) -> bool {
        let mut waiting = VecDeque::<PendingClassification>::new();
        let mut analysis: FuturesUnordered<
            BoxFuture<'_, (String, Result<PendingClassification, String>)>,
        > = FuturesUnordered::new();
        let mut completions: FuturesUnordered<BoxFuture<'_, (String, Result<(), String>)>> =
            FuturesUnordered::new();
        let mut next = 0;
        let mut yielding = false;
        loop {
            if self.cancel.load(Ordering::Relaxed) {
                // Dropping the scoped futures cancels local waits; no detached writer survives.
                break;
            }
            // Finish in-flight Jev/Cloud work, then let an explorer capture take
            // the gate. The watcher will resume the remaining DB targets later.
            yielding |= self.should_yield();
            while completions.len() < CLOUD_CONCURRENCY {
                let Some(pending) = waiting.pop_front() else {
                    break;
                };
                completions.push(
                    async move {
                        let id = pending.id.clone();
                        (id, self.finish_jev(db, Some(cloud), pending).await)
                    }
                    .boxed(),
                );
            }
            if !yielding && analysis.is_empty() && next < targets.len() {
                let id = &targets[next];
                let asset = db.get_asset(id).ok().flatten();
                let current = CurrentAsset {
                    id: id.clone(),
                    name: asset
                        .as_ref()
                        .map(|a| a.name.clone())
                        .unwrap_or_else(|| "素材已移除".into()),
                    thumb_path: asset.and_then(|a| a.thumb_path),
                    position: next + 1,
                };
                {
                    let mut status = self.status.lock().unwrap();
                    status.current_asset = Some(current.clone());
                    status.jev_progress = Some(JevProgress {
                        asset: current,
                        report: None,
                        message: "正在等待 Jev 返回结果…".into(),
                    });
                }
                analysis.push(
                    async move {
                        let result = async {
                            let revision = db.local_revision().map_err(|e| e.to_string())?;
                            let labels: Vec<_> = db
                                .local_labels()
                                .map_err(|e| e.to_string())?
                                .into_iter()
                                .filter(|l| l.enabled && tag.map_or(true, |tag| l.id == tag))
                                .collect();
                            if tag.is_some() && labels.is_empty() {
                                return Err("标签已停用或删除".into());
                            }
                            self.prepare_jev(
                                judge,
                                db,
                                library,
                                id,
                                revision,
                                &labels,
                                tag.is_none(),
                            )
                            .await
                        }
                        .await;
                        (id.clone(), result)
                    }
                    .boxed(),
                );
                next += 1;
            }
            {
                let mut status = self.status.lock().unwrap();
                status.cloud_running = completions.len();
                status.cloud_queued = waiting.len();
                status.phase = "classifying".into();
                status.message = if analysis.is_empty() && !completions.is_empty() {
                    "Jev 分析已完成，正在等待 Cloud 补标签…"
                } else {
                    "正在识别素材"
                }
                .into();
            }
            notify(false);
            if analysis.is_empty() && completions.is_empty() {
                break;
            }
            tokio::select! {
                Some((id, result)) = analysis.next(), if !analysis.is_empty() => {
                    if self.cancel.load(Ordering::Relaxed) { break; }
                    {
                        let mut status = self.status.lock().unwrap();
                        status.jev_done += 1;
                        status.current_asset = None;
                    }
                    match result {
                        Ok(pending) if pending.needs_discovery => {
                            if let Some(progress) = self.status.lock().unwrap().jev_progress.as_mut() {
                                progress.message = format!("{}已加入 Cloud 补标签队列，Jev 继续分析下一张", if progress.report.is_none() { "没有启用标签，未调用 Jev；" } else { "没有真实标签达到 30%；" });
                            }
                            waiting.push_back(pending);
                        }
                        Ok(pending) => {
                            let result = self.finish_jev(db, None, pending).await;
                            self.complete_jev_asset(&id, &result);
                            notify(result.is_ok());
                        }
                        Err(error) => {
                            self.complete_jev_asset(&id, &Err(error));
                            notify(false);
                        }
                    }
                }
                Some((id, result)) = completions.next(), if !completions.is_empty() => {
                    if self.cancel.load(Ordering::Relaxed) { break; }
                    self.complete_jev_asset(&id, &result);
                    notify(result.is_ok());
                }
                _ = async {
                    while !self.cancel.load(Ordering::Relaxed) {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                } => break,
            }
        }
        // All work belongs to this run and must be dropped before the busy gate is released.
        drop(analysis);
        drop(completions);
        let mut status = self.status.lock().unwrap();
        status.current_asset = None;
        status.cloud_running = 0;
        status.cloud_queued = 0;
        if self.cancel.load(Ordering::Relaxed) {
            if let Some(progress) = status.jev_progress.as_mut() {
                progress.message = "已停止；已完成结果保留，未完成的补标签任务未写入".into();
            }
        }
        drop(status);
        notify(false);
        next == targets.len() && !self.cancel.load(Ordering::Relaxed)
    }

    fn complete_jev_asset(&self, id: &str, result: &Result<(), String>) {
        let mut status = self.status.lock().unwrap();
        status.done += 1;
        if let Some(progress) = status.jev_progress.as_mut().filter(|p| p.asset.id == id) {
            progress.message = match result {
                Ok(()) => "此图处理完成".into(),
                Err(error) => format!("此图未写入结果：{error}"),
            };
        }
        if let Err(error) = result {
            status.failed += 1;
            status.last_error = format!("素材 {id}：{error}");
        }
    }
}
