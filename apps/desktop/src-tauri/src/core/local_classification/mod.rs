//! Local classification has no Cloud/CLI fallback and never writes reverse-prompt captions.
pub mod data;
pub mod jev;
pub mod runtime;
#[cfg(test)]
mod tests;
pub mod vector;

use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
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
    pub acceleration: String,
    pub vector_supported: bool,
    pub vector_installed: bool,
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
        result.vector_supported = vector::vector_supported();
        result.vector_installed = vector::vector_installed(&self.root);
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
        jev_key: Option<String>,
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
                this.run(&app, &db, &library, tag, jev_key, pending_only)
                    .await
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

    /// Removes the vector pack. Refused while a classification or download
    /// holds the busy gate: a live embedding session must not lose its files
    /// (Windows cannot delete a loaded DLL mid-run).
    pub fn uninstall_vector(&self) -> Result<(), String> {
        let _guard = self
            .gate
            .clone()
            .try_lock_owned()
            .map_err(|_| "已有本地分类或下载任务在运行，请先停止再卸载")?;
        vector::uninstall(&self.root)
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

    /// Installs the optional vector pack. The download shares the busy gate so
    /// it cannot overlap a classification run.
    pub fn start_vector(self: &Arc<Self>, app: AppHandle) -> Result<(), String> {
        if !vector::vector_supported() {
            return Err("此平台暂无固定的向量模型运行组件，将继续使用内置视觉模型判断".into());
        }
        let guard = self
            .gate
            .clone()
            .try_lock_owned()
            .map_err(|_| "已有本地分类或下载任务在运行")?;
        self.cancel.store(false, Ordering::Relaxed);
        self.update(&app, |s| {
            *s = Status {
                busy: true,
                phase: "downloading".into(),
                ..Status::default()
            };
        });
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let _guard = guard;
            let result = vector::vector_install(&this.root, &this.cancel, |name, done, total| {
                this.update(&app, |s| {
                    s.message = match name {
                        "model_int8.onnx" => "正在下载向量匹配模型（约 834 MB）",
                        "tokenizer.json" => "正在下载向量分词器",
                        _ => "正在下载向量运行组件",
                    }
                    .into();
                    s.download_done = done;
                    s.download_total = total;
                });
            })
            .await;
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
                let installed = result.is_ok();
                s.message = if cancelled {
                    "已停止，已下载的文件会保留".into()
                } else {
                    result.err().unwrap_or_else(|| {
                        "向量匹配模型已安装，重新扫描后将由向量模型判断标签".into()
                    })
                };
                s.vector_installed = installed;
            });
        });
        Ok(())
    }

    async fn run(
        &self,
        app: &AppHandle,
        db: &Database,
        library: &LibraryPaths,
        tag: Option<String>,
        jev_key: Option<String>,
        pending_only: bool,
    ) -> Result<(), String> {
        let gate = match jev_key {
            Some(key) => Some(jev::Gate::new(key)?),
            None => None,
        };
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
        // Existing CPU installations reuse their weights and fetch only the small GPU runtime.
        let gpu_installed = runtime::gpu_installed(&self.root);
        let gpu_available = gpu_installed || runtime::nvidia_available(&self.cancel).await;
        if !gpu_installed && gpu_available {
            self.update(app, |s| {
                s.phase = "downloading".into();
                s.message = "正在补充 NVIDIA GPU 加速组件（约 645 MB）".into();
                s.download_done = 0;
                s.download_total = runtime::GPU_DOWNLOAD_BYTES;
            });
        }
        let gpu_install = if gpu_installed || !gpu_available {
            Ok(())
        } else {
            runtime::install_gpu(&self.root, &self.cancel, |_, done, total| {
                self.update(app, |s| {
                    s.phase = "downloading".into();
                    s.message = "正在补充 NVIDIA GPU 加速组件（约 645 MB）".into();
                    s.download_done = done;
                    s.download_total = total;
                });
            })
            .await
        };
        if self.cancel.load(Ordering::Relaxed) {
            return Err("已停止分类".into());
        }
        self.update(app, |s| {
            s.phase = "loading".into();
            s.message = "正在加载本地模型".into();
        });
        let mut server = runtime::Server::start(&self.root, &self.cancel).await?;
        self.update(app, |s| {
            s.acceleration = match gpu_install {
                Err(error) => format!("CPU · GPU 组件下载未完成，已回退 CPU：{error}"),
                Ok(()) => server.acceleration.clone(),
            };
        });
        // When the vector pack is installed its cosine judge replaces the VLM
        // yes/no matching; a load failure falls back to VLM matching instead
        // of failing the whole run.
        let mut vector = if vector::vector_installed(&self.root) {
            self.update(app, |s| {
                s.message = "正在加载向量匹配模型".into();
            });
            let root = self.root.clone();
            match tokio::task::spawn_blocking(move || vector::Matcher::load(&root)).await {
                Ok(Ok(matcher)) => Some(matcher),
                Ok(Err(error)) => {
                    self.update(app, |s| {
                        s.message = format!("向量模型加载失败，本轮回退内置视觉判断：{error}");
                    });
                    None
                }
                Err(error) => {
                    self.update(app, |s| {
                        s.message = format!("向量模型加载失败，本轮回退内置视觉判断：{error}");
                    });
                    None
                }
            }
        } else {
            None
        };
        for (index, id) in targets.iter().enumerate() {
            if self.cancel.load(Ordering::Relaxed) {
                break;
            }
            self.update(app, |s| {
                s.phase = "classifying".into();
                s.message = "正在识别素材".into();
            });
            let result = self
                .classify_one(
                    &server,
                    db,
                    library,
                    id,
                    tag.as_deref(),
                    gate.as_ref(),
                    vector.as_mut(),
                    tag.is_none() && !pending_only,
                )
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
        gate: Option<&jev::Gate>,
        mut vector: Option<&mut vector::Matcher>,
        rebuild: bool,
    ) -> Result<(), String> {
        let revision = db.local_revision().map_err(|e| e.to_string())?;
        let labels: Vec<data::Label> = db
            .local_labels()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|l| l.enabled && tag.map_or(true, |tag| l.id == tag))
            .collect();
        if tag.is_some() && labels.is_empty() {
            return Err("标签已停用或删除".into());
        }
        let image = Self::image(db, library, id).await?;
        let mut combined = data::Prediction {
            description: String::new(),
            tags: vec![],
            matches: vec![],
        };
        let mut evaluated: Vec<String> = Vec::new();
        let mut exampleless: Vec<String> = Vec::new();
        if tag.is_none() {
            // The sample only narrows the discovery vocabulary; matching still
            // walks the full enabled label set.
            let mut shortlist = labels.clone();
            discovery_sample(&mut shortlist, id);
            combined = server
                .predict(&image, &shortlist, true, &[], &self.cancel)
                .await?;
            // A discovered name that already exists is grounded in this image and
            // attaches the existing label directly, without a second blind judgment.
            combined.matches.clear();
            ground_discovered_names(&labels, &mut combined);
        }
        // Labels with manual examples are evaluated individually. Automatic passes
        // skip labels without examples instead of batch-voting them onto the image;
        // those labels are only judged in an explicit per-label run. A full re-scan
        // re-derives every automatic association, so stale ones are removed.
        // With the vector pack installed the judge is cosine similarity against
        // the label's text and example-image embeddings; the VLM only discovers
        // and names. Embedding runs are CPU-bound and parked off the executor.
        let asset_vector = if vector.is_some() {
            let path = db
                .local_image_path(id)
                .map_err(|e| e.to_string())?
                .ok_or("图片已删除或缺少缩略图")?;
            let id = id.to_string();
            tokio::task::block_in_place(|| {
                vector
                    .as_deref_mut()
                    .unwrap()
                    .embed_file(&id, std::path::Path::new(&path))
            })?
            .to_vec()
        } else {
            Vec::new()
        };
        for label in &labels {
            let examples = db
                .local_examples(&label.id, id)
                .map_err(|e| e.to_string())?;
            if examples.is_empty() && tag != Some(label.id.as_str()) {
                exampleless.push(label.id.clone());
                continue;
            }
            if let Some(matcher) = vector.as_deref_mut() {
                let mut positives = Vec::new();
                let mut negatives = Vec::new();
                for (asset, positive) in &examples {
                    let path = db
                        .local_image_path(asset)
                        .map_err(|e| e.to_string())?
                        .ok_or("示例素材已删除或缺少缩略图")?;
                    tokio::task::block_in_place(|| {
                        matcher.embed_file(asset, std::path::Path::new(&path))
                    })?;
                    if *positive {
                        positives.push(asset.clone());
                    } else {
                        negatives.push(asset.clone());
                    }
                }
                let matched = tokio::task::block_in_place(|| {
                    matcher.judge(&asset_vector, label, &positives, &negatives)
                })?;
                if matched {
                    combined.matches.push(label.id.clone());
                }
                evaluated.push(label.id.clone());
            } else {
                let mut images = Vec::new();
                for (asset, positive) in examples {
                    images.push((Self::image(db, library, &asset).await?, positive));
                }
                let prediction = server
                    .predict(
                        &image,
                        std::slice::from_ref(label),
                        false,
                        &images,
                        &self.cancel,
                    )
                    .await?;
                combined.matches.extend(prediction.matches);
                evaluated.push(label.id.clone());
            }
        }
        if rebuild {
            evaluated.extend(exampleless);
        }
        // The optional cloud gate re-checks every surviving candidate against the
        // grounded description; with it enabled, a failed check fails the asset.
        if let Some(gate) = gate {
            gate.apply(&mut combined, &labels, &self.cancel).await?;
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

/// Discovery references a per-asset deterministic sample, never the most-used
/// labels: an automatic attach must not raise a tag's rank and feed back into
/// later suggestions.
fn discovery_sample(labels: &mut Vec<data::Label>, asset: &str) {
    const REFERENCE: usize = 8;
    if labels.len() <= REFERENCE {
        return;
    }
    labels.sort_unstable_by_key(|label| {
        let mut hash = DefaultHasher::new();
        label.id.hash(&mut hash);
        asset.hash(&mut hash);
        hash.finish()
    });
    labels.truncate(REFERENCE);
}

/// `labels` is the enabled set. Discovered names that match an existing label
/// attach it directly; only genuinely new names create labels.
fn ground_discovered_names(labels: &[data::Label], prediction: &mut data::Prediction) {
    prediction.tags.retain(|name| {
        match labels
            .iter()
            .find(|label| label.name.eq_ignore_ascii_case(name))
        {
            Some(label) => {
                prediction.matches.push(label.id.clone());
                false
            }
            None => true,
        }
    });
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
                let jev_key = {
                    let settings = app.state::<crate::core::settings::SettingsState>();
                    let snapshot = settings.get();
                    if snapshot.jev_verify_enabled {
                        snapshot.jev_api_key.filter(|key| !key.trim().is_empty())
                    } else {
                        None
                    }
                };
                if classifier
                    .start(
                        app.clone(),
                        db.clone(),
                        paths.clone(),
                        false,
                        tag,
                        jev_key,
                        true,
                    )
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
