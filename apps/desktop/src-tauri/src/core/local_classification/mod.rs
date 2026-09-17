//! Local classification has no Cloud/CLI fallback and never writes reverse-prompt captions.
pub mod data;
pub mod runtime;
#[cfg(test)]
mod tests;

use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

use super::paths::LibraryPaths;
use crate::db::Database;

#[derive(Clone, Default, Serialize)]
pub struct Status {
    pub supported: bool,
    pub installed: bool,
    pub enabled: bool,
    pub busy: bool,
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub failed: usize,
    pub download_done: u64,
    pub download_total: u64,
    pub message: String,
    pub last_error: String,
    pub model: String,
}

pub struct LocalClassifier {
    pub root: PathBuf,
    gate: Arc<tokio::sync::Mutex<()>>,
    cancel: AtomicBool,
    status: Mutex<Status>,
}

impl LocalClassifier {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            gate: Arc::new(tokio::sync::Mutex::new(())),
            cancel: AtomicBool::new(false),
            status: Mutex::new(Status::default()),
        }
    }

    pub fn snapshot(&self, db: &Database) -> Result<Status, String> {
        let mut result = self.status.lock().unwrap().clone();
        result.supported = runtime::supported();
        result.installed = runtime::installed(&self.root);
        result.enabled = db.local_enabled().map_err(|e| e.to_string())?;
        result.model = data::MODEL_ID.into();
        if result.download_total == 0 {
            result.download_total = runtime::download_bytes();
        }
        Ok(result)
    }

    fn update(&self, app: &AppHandle, update: impl FnOnce(&mut Status)) {
        let status = {
            let mut state = self.status.lock().unwrap();
            update(&mut state);
            state.clone()
        };
        let _ = app.emit("local-classification://progress", status);
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    pub fn start(
        self: &Arc<Self>,
        app: AppHandle,
        db: Arc<Database>,
        library: Arc<LibraryPaths>,
        install: bool,
        tag: Option<String>,
        pending_only: bool,
    ) -> Result<(), String> {
        if !runtime::supported() {
            return Err(runtime::UNSUPPORTED_MESSAGE.into());
        }
        let guard = self
            .gate
            .clone()
            .try_lock_owned()
            .map_err(|_| "已有本地分类或下载任务在运行")?;
        if !install && !runtime::installed(&self.root) {
            return Err("请先安装本地分类模型".into());
        }
        if let Some(id) = &tag {
            if !db
                .local_labels()
                .map_err(|e| e.to_string())?
                .iter()
                .any(|l| l.id == *id && l.enabled)
            {
                return Err("标签不存在或已停用".into());
            }
        }
        self.cancel.store(false, Ordering::Relaxed);
        self.update(&app, |s| {
            *s = Status {
                busy: true,
                phase: if install { "downloading" } else { "loading" }.into(),
                ..Status::default()
            };
        });
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let _guard = guard;
            let result = if install {
                runtime::install(&this.root, &this.cancel, |name, done, total| {
                    this.update(&app, |s| {
                        s.message = match name {
                            "model.gguf" => "正在下载图像识别模型",
                            "mmproj.gguf" => "正在下载视觉组件",
                            _ => "正在下载运行组件",
                        }
                        .into();
                        s.download_done = done;
                        s.download_total = total;
                    });
                })
                .await
            } else {
                this.run(&app, &db, &library, tag, pending_only).await
            };
            let cancelled = this.cancel.load(Ordering::Relaxed);
            this.update(&app, |s| {
                s.busy = false;
                s.phase = if cancelled {
                    "stopped"
                } else if result.is_err() {
                    "error"
                } else {
                    "complete"
                }
                .into();
                s.message = if cancelled {
                    "已停止，已完成的结果已保留".into()
                } else {
                    result.err().unwrap_or_else(|| {
                        if install {
                            "本地模型已安装".into()
                        } else if s.failed > 0 {
                            format!("处理完成，{} 张未完成；可重试未识别素材", s.failed)
                        } else {
                            "处理完成".into()
                        }
                    })
                };
            });
            let _ = app.emit("library://assets-changed", ());
        });
        Ok(())
    }

    async fn image(db: &Database, library: &LibraryPaths, id: &str) -> Result<String, String> {
        let path = db
            .local_image_path(id)
            .map_err(|e| e.to_string())?
            .ok_or("图片已删除或缺少缩略图")?;
        let root = library.root.clone();
        tokio::task::spawn_blocking(move || runtime::image_data(std::path::Path::new(&path), &root))
            .await
            .map_err(|e| e.to_string())?
    }

    async fn run(
        &self,
        app: &AppHandle,
        db: &Database,
        library: &LibraryPaths,
        tag: Option<String>,
        pending_only: bool,
    ) -> Result<(), String> {
        let job_revision = db.local_revision().map_err(|e| e.to_string())?;
        let targets = db
            .local_targets(pending_only && tag.is_none())
            .map_err(|e| e.to_string())?;
        self.update(app, |s| {
            s.total = targets.len();
            s.message = "正在加载本地模型".into();
        });
        if targets.is_empty() {
            if let Some(tag) = tag {
                db.finish_local_label(&tag, job_revision)
                    .map_err(|e| e.to_string())?;
            }
            return Ok(());
        }
        let mut server = runtime::Server::start(&self.root, &self.cancel).await?;
        for (index, id) in targets.iter().enumerate() {
            if self.cancel.load(Ordering::Relaxed) {
                break;
            }
            self.update(app, |s| {
                s.phase = "classifying".into();
                s.message = "正在识别素材".into();
            });
            let result = self
                .classify_one(&server, db, library, id, tag.as_deref())
                .await;
            if self.cancel.load(Ordering::Relaxed) {
                break;
            }
            self.update(app, |s| {
                s.done = index + 1;
                if let Err(error) = &result {
                    s.failed += 1;
                    s.message = error.clone();
                    s.last_error = error.clone();
                }
            });
            if result.is_ok() {
                let _ = app.emit("library://assets-changed", ());
            }
        }
        server.stop().await;
        if !self.cancel.load(Ordering::Relaxed) && self.status.lock().unwrap().failed == 0 {
            if let Some(tag) = tag {
                db.finish_local_label(&tag, job_revision)
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    async fn classify_one(
        &self,
        server: &runtime::Server,
        db: &Database,
        library: &LibraryPaths,
        id: &str,
        tag: Option<&str>,
    ) -> Result<(), String> {
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
        let evaluated: Vec<_> = labels.iter().map(|l| l.id.clone()).collect();
        let image = Self::image(db, library, id).await?;
        let mut combined = data::Prediction {
            description: String::new(),
            tags: vec![],
            matches: vec![],
        };
        if tag.is_none() {
            let shortlist = &labels[..labels.len().min(8)];
            combined = server
                .predict(&image, shortlist, true, &[], &self.cancel)
                .await?;
            combined.matches.clear();
            combined.tags.retain(|name| {
                !labels
                    .iter()
                    .any(|label| label.name.eq_ignore_ascii_case(name))
            });
        }
        // Labels with manual examples are evaluated individually. All others are batched, with no vocabulary truncation.
        let mut plain = Vec::new();
        for label in labels {
            let examples = db
                .local_examples(&label.id, id)
                .map_err(|e| e.to_string())?;
            if examples.is_empty() {
                plain.push(label);
                continue;
            }
            let mut images = Vec::new();
            for (asset, positive) in examples {
                images.push((Self::image(db, library, &asset).await?, positive));
            }
            let prediction = server
                .predict(&image, &[label], false, &images, &self.cancel)
                .await?;
            combined.matches.extend(prediction.matches);
        }
        for chunk in plain.chunks(8) {
            let prediction = server
                .predict(&image, chunk, false, &[], &self.cancel)
                .await?;
            combined.matches.extend(prediction.matches);
        }
        if self.cancel.load(Ordering::Relaxed) {
            return Err("已停止分类".into());
        }
        if !db
            .apply_local_prediction(id, revision, &combined, tag.is_none(), &evaluated)
            .map_err(|e| e.to_string())?
        {
            return Err("标签已被人工修改，已忽略旧结果；请重试此素材".into());
        }
        Ok(())
    }
}

/// Also covers generated images and imports from every entry point. No inference runs without opt-in.
pub fn watch(app: AppHandle, db: Arc<Database>, paths: Arc<LibraryPaths>) {
    tauri::async_runtime::spawn(async move {
        let classifier = app.state::<Arc<LocalClassifier>>().inner().clone();
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;
            if !db.local_enabled().unwrap_or(false) || !runtime::installed(&classifier.root) {
                continue;
            }
            let tag = db.pending_local_label().ok().flatten();
            if tag.is_some() || db.local_targets(true).is_ok_and(|ids| !ids.is_empty()) {
                if classifier
                    .start(app.clone(), db.clone(), paths.clone(), false, tag, true)
                    .is_err()
                {
                    continue;
                }
                // A failed asset is retried on explicit action or app restart, not every 15 seconds.
                while classifier.status.lock().unwrap().busy {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
                let status = classifier.status.lock().unwrap().clone();
                if status.failed > 0 || status.phase == "error" {
                    let _ = db.set_local_enabled(false);
                    classifier.update(&app, |s| s.message.push_str("；自动处理已暂停"));
                    let _ = app.emit(
                        "local-classification://progress",
                        classifier.snapshot(&db).unwrap_or_default(),
                    );
                }
            }
        }
    });
}
