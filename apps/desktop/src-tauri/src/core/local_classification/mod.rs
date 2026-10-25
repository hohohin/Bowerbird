//! Automatic classification supports local matching or explicit Jev image API judgment.
mod cloud;
mod diagnostics;
pub mod explorer;
pub mod folder;
pub mod global;
pub mod data;
pub mod jev;
mod pipeline;
pub mod runtime;
#[cfg(test)]
mod tests;
pub mod vector;

use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

use super::paths::LibraryPaths;
use crate::db::Database;

#[derive(Clone, Serialize)]
pub struct CurrentAsset {
    pub id: String,
    pub name: String,
    pub thumb_path: Option<String>,
    pub position: usize,
}

#[derive(Clone, Serialize)]
pub struct JevProgress {
    pub asset: CurrentAsset,
    pub report: Option<jev::Report>,
    pub message: String,
}

#[derive(Clone, Default, Serialize)]
pub struct Status {
    #[cfg(debug_assertions)]
    pub diagnostics: Vec<diagnostics::Row>,
    pub run_id: String,
    pub recent_results: Vec<ClassificationResult>,
    pub recent_cloud_handoffs: Vec<CurrentAsset>,
    pub folder_root: Option<String>,
    pub global_scope: bool,
    pub project_id: Option<String>,
    pub supported: bool,
    pub installed: bool,
    pub enabled: bool,
    pub busy: bool,
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub failed: usize,
    pub jev_done: usize,
    pub cloud_running: usize,
    pub cloud_queued: usize,
    pub download_done: u64,
    pub download_total: u64,
    pub message: String,
    pub last_error: String,
    pub current_asset: Option<CurrentAsset>,
    pub jev_progress: Option<JevProgress>,
    pub model: String,
    pub acceleration: String,
    pub vector_supported: bool,
    pub vector_installed: bool,
}

#[derive(Clone, Serialize)]
pub struct ClassificationResult {
    pub sequence: usize,
    pub asset: CurrentAsset,
    pub tags: Vec<String>,
    pub error: Option<String>,
}

pub struct LocalClassifier {
    diagnostics: diagnostics::Diagnostics,
    pub root: PathBuf,
    gate: Arc<tokio::sync::Mutex<()>>,
    cancel: AtomicBool,
    status: Mutex<Status>,
    background: AtomicBool,
    foreground_requests: AtomicUsize,
}

impl LocalClassifier {
    pub fn folder_records_root(&self) -> PathBuf {
        // Keep user records outside the downloadable/removable model package.
        self.root.parent().unwrap_or(&self.root).join("folder-records")
    }
    pub fn new(root: PathBuf) -> Self {
        Self {
            diagnostics: diagnostics::Diagnostics::default(),
            root,
            gate: Arc::new(tokio::sync::Mutex::new(())),
            cancel: AtomicBool::new(false),
            status: Mutex::new(Status::default()),
            background: AtomicBool::new(false),
            foreground_requests: AtomicUsize::new(0),
        }
    }

    pub fn snapshot(&self, db: &Database) -> Result<Status, String> {
        let mut result = self.status.lock().unwrap().clone();
        #[cfg(debug_assertions)]
        { result.diagnostics = self.diagnostics.snapshot(); }
        result.supported = runtime::supported();
        result.installed = runtime::installed(&self.root);
        result.enabled = db.local_enabled().map_err(|e| e.to_string())?;
        if result.model.is_empty() {
            result.model = data::MODEL_ID.into();
        }
        result.vector_supported = vector::vector_supported();
        result.vector_installed = vector::vector_installed(&self.root);
        if result.download_total == 0 {
            result.download_total = runtime::download_bytes();
        }
        Ok(result)
    }

    fn update(&self, app: &AppHandle, update: impl FnOnce(&mut Status)) {
        #[allow(unused_mut)]
        let mut status = {
            let mut state = self.status.lock().unwrap();
            let previous_run = state.run_id.clone();
            update(&mut state);
            if state.run_id != previous_run { self.diagnostics.clear(); }
            state.clone()
        };
        #[cfg(debug_assertions)]
        { status.diagnostics = self.diagnostics.snapshot(); }
        let _ = app.emit("local-classification://progress", status);
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    fn should_yield(&self) -> bool {
        self.background.load(Ordering::Relaxed) && self.foreground_requests.load(Ordering::Relaxed) > 0
    }

    pub fn start(
        self: &Arc<Self>,
        app: AppHandle,
        db: Arc<Database>,
        library: Arc<LibraryPaths>,
        install: bool,
        tag: Option<String>,
        use_jev: bool,
        pending_only: bool,
    ) -> Result<(), String> {
        self.start_run(app, db, library, install, tag, use_jev, pending_only, false, None, None)
    }

    pub fn start_global(
        self: &Arc<Self>, app: AppHandle, db: Arc<Database>, library: Arc<LibraryPaths>,
        config: super::file_workspace::FileWorkspaceConfig, tag: Option<String>, use_jev: bool, pending_only: bool,
    ) -> Result<(), String> {
        self.start_run(app, db, library, false, tag, use_jev, pending_only, false, Some(config), None)
    }

    pub fn start_project(
        self: &Arc<Self>, app: AppHandle, db: Arc<Database>, library: Arc<LibraryPaths>,
        project: String, tag: Option<String>, use_jev: bool, pending_only: bool,
    ) -> Result<(), String> {
        self.start_run(app, db, library, false, tag, use_jev, pending_only, false, None, Some(project))
    }

    fn start_run(
        self: &Arc<Self>, app: AppHandle, db: Arc<Database>, library: Arc<LibraryPaths>,
        install: bool, tag: Option<String>, use_jev: bool, pending_only: bool, background: bool,
        global: Option<super::file_workspace::FileWorkspaceConfig>,
        project: Option<String>,
    ) -> Result<(), String> {
        let needs_local = install || !use_jev;
        if needs_local && !runtime::supported() {
            return Err(runtime::UNSUPPORTED_MESSAGE.into());
        }
        let guard = self
            .gate
            .clone()
            .try_lock_owned()
            .map_err(|_| "已有本地分类或下载任务在运行")?;
        if !install && needs_local && !runtime::installed(&self.root) {
            return Err("请先安装本地分类模型".into());
        }
        let project_scope = project.as_deref().map(|id| global::project_ids(&db, id)).transpose()?;
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
        self.background.store(background, Ordering::Relaxed);
        self.update(&app, |s| {
            *s = Status {
                run_id: ulid::Ulid::new().to_string(),
                global_scope: global.is_some(),
                project_id: project,
                busy: true,
                model: if use_jev && !install {
                    jev::OBSERVATION_MODEL.into()
                } else {
                    data::MODEL_ID.into()
                },
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
                async {
                    let scope = if let Some(config) = global {
                        let worker = this.clone(); let database = db.clone(); let paths = library.clone(); let handle = app.clone();
                        Some(tokio::task::spawn_blocking(move || {
                            global::prepare(&database, &paths, config, &worker.cancel, |message| {
                                worker.update(&handle, |s| s.message = message);
                            })
                        }).await.map_err(|e| e.to_string())??)
                    } else { project_scope.map(|ids| global::Scope { ids, unavailable: vec![], failed: 0 }) };
                    if !this.cancel.load(Ordering::Relaxed) {
                        this.run(&app, &db, &library, tag, use_jev, pending_only, None, scope.as_ref().map(|s| &s.ids)).await?;
                    }
                    if let Some(scope) = scope {
                        this.update(&app, |s| {
                            s.failed += scope.failed;
                            s.done += scope.failed;
                            s.total += scope.failed;
                            if !scope.unavailable.is_empty() { s.last_error = scope.unavailable.join("；"); }
                        });
                    }
                    Ok(())
                }.await
            };
            let cancelled = this.cancel.load(Ordering::Relaxed);
            let pause_automatic = background && (result.is_err() || this.status.lock().unwrap().failed > 0);
            // Record this run's failure before handing the gate to a queued drag;
            // a later owner's status must not be mistaken for this scan's result.
            if pause_automatic { let _ = db.set_local_enabled(false); }
            this.update(&app, |s| {
                s.busy = false;
                if cancelled && s.current_asset.is_some() {
                    if let Some(progress) = s.jev_progress.as_mut() {
                        progress.message = "已停止；此图未完成的结果未写入".into();
                    }
                }
                s.current_asset = None;
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
                        } else if !s.last_error.is_empty() {
                            "处理完成，部分位置未能读取，详见下方原因".into()
                        } else {
                            "处理完成".into()
                        }
                    })
                };
                if pause_automatic { s.message.push_str("；自动处理已暂停"); }
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

    pub fn delete_labels(&self, db: &Database, ids: &[String]) -> Result<(), String> {
        let _guard = self
            .gate
            .clone()
            .try_lock_owned()
            .map_err(|_| "已有本地分类或下载任务在运行，请先停止再删除标签")?;
        db.delete_local_labels(ids).map_err(|e| e.to_string())
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
        use_jev: bool,
        pending_only: bool,
        folder: Option<&folder::Session>,
        scope: Option<&std::collections::HashSet<String>>,
    ) -> Result<(), String> {
        let judge = if use_jev { Some(jev::Judge::new(app)?) } else { None };
        let observation_model = if judge.is_some() {
            jev::OBSERVATION_MODEL
        } else {
            data::MODEL_ID
        };
        let mut job_revision = db.local_revision().map_err(|e| e.to_string())?;
        let mut targets = if self.background.load(Ordering::Relaxed) {
            db.local_auto_targets(observation_model)
        } else {
            db.local_targets_for_model(pending_only && tag.is_none(), observation_model)
        }.map_err(|e| e.to_string())?;
        global::retain_scope(&mut targets, scope);
        if tag.is_none() && !pending_only {
            if self.cancel.load(Ordering::Relaxed) { return Ok(()); }
            (job_revision, targets) = db.reset_classification_results(&targets, job_revision).map_err(|e| e.to_string())?;
            if !targets.is_empty() {
                // Persist the reset even if all subsequent inference fails or the user stops.
                if let Some(folder) = folder { folder.save()?; }
                let _ = app.emit(if folder.is_some() { "folder-classification://changed" } else { "library://assets-changed" }, ());
            }
        }
        self.update(app, |s| {
            s.total = targets.len();
            s.message = if judge.is_some() {
                "正在准备 Jev 图片判断"
            } else {
                "正在加载标签发现模型"
            }
            .into();
        });
        if targets.is_empty() {
            if let Some(tag) = tag.filter(|_| scope.is_none()) {
                db.finish_local_label(&tag, job_revision)
                    .map_err(|e| e.to_string())?;
            }
            return Ok(());
        }
        if let Some(judge) = &judge {
            let cloud = crate::codex::understand::CloudUnderstandProvider::new(
                app.state::<crate::cloud::CloudClient>().inner().clone(),
                app.state::<crate::cloud::AuthClient>().inner().clone(),
            );
            let save_error = Mutex::new(None);
            let completed = self.run_jev_queue(
                db,
                library,
                &targets,
                tag.as_deref(),
                judge,
                &cloud,
                |changed| {
                    self.update(app, |_| {});
                    if changed {
                        if let Some(folder) = folder {
                            if let Err(error) = folder.save() {
                                *save_error.lock().unwrap() = Some(error);
                                self.cancel.store(true, Ordering::Relaxed);
                            }
                        }
                        let _ = app.emit(if folder.is_some() { "folder-classification://changed" } else { "library://assets-changed" }, ());
                    }
                },
            )
            .await;
            if let Some(error) = save_error.into_inner().unwrap() { return Err(error); }
            // Folder DBs are in memory. Retain completed translation batches
            // even when the subsequent image request fails or is cancelled.
            if let Some(folder) = folder { folder.save()?; }
            if completed && !self.cancel.load(Ordering::Relaxed) && self.status.lock().unwrap().failed == 0 {
                if let Some(tag) = tag.filter(|_| scope.is_none()) {
                    db.finish_local_label(&tag, job_revision)
                        .map_err(|e| e.to_string())?;
                }
            }
            return Ok(());
        }
        let mut server = if judge.is_some() {
            None
        } else {
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
            let server = runtime::Server::start(&self.root, &self.cancel).await?;
            self.update(app, |s| {
                s.acceleration = match gpu_install {
                    Err(error) => format!("CPU · GPU 组件下载未完成，已回退 CPU：{error}"),
                    Ok(()) => server.acceleration.clone(),
                };
            });
            Some(server)
        };
        // When the vector pack is installed its cosine judge replaces the VLM
        // yes/no matching; a load failure falls back to VLM matching instead
        // of failing the whole run.
        let mut vector = if judge.is_none() && vector::vector_installed(&self.root) {
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
        let cloud = crate::codex::understand::CloudUnderstandProvider::new(
            app.state::<crate::cloud::CloudClient>().inner().clone(),
            app.state::<crate::cloud::AuthClient>().inner().clone(),
        );
        let mut completed = true;
        for (index, id) in targets.iter().enumerate() {
            if self.should_yield() { completed = false; break; }
            if self.cancel.load(Ordering::Relaxed) {
                break;
            }
            let asset = db.get_asset(id).ok().flatten();
            self.update(app, |s| {
                s.phase = "classifying".into();
                s.message = "正在识别素材".into();
                s.current_asset = Some(CurrentAsset {
                    id: id.clone(),
                    name: asset
                        .as_ref()
                        .map(|a| a.name.clone())
                        .unwrap_or_else(|| "素材已移除".into()),
                    thumb_path: asset.and_then(|a| a.thumb_path),
                    position: index + 1,
                });
                s.jev_progress = if judge.is_some() {
                    Some(JevProgress {
                        asset: s.current_asset.clone().unwrap(),
                        report: None,
                        message: "正在等待 Jev 返回结果…".into(),
                    })
                } else {
                    None
                };
            });
            let result = self
                .classify_one(
                    server.as_ref(),
                    db,
                    library,
                    id,
                    tag.as_deref(),
                    judge.as_ref(),
                    Some(&cloud),
                    vector.as_mut(),
                    tag.is_none() && !pending_only,
                )
                .await;
            if self.cancel.load(Ordering::Relaxed) {
                break;
            }
            self.update(app, |s| {
                s.current_asset = None;
                if let Some(progress) = s.jev_progress.as_mut() {
                    progress.message = match &result {
                        Ok(()) if progress.report.is_none() => {
                            "此图处理完成；无启用的已有标签，本图未调用 Jev".into()
                        }
                        Ok(()) => "此图处理完成".into(),
                        Err(error) => format!("此图未写入结果：{error}"),
                    };
                }
                s.done = index + 1;
                if let Err(error) = &result {
                    s.failed += 1;
                    s.message = error.clone();
                    s.last_error = error.clone();
                }
            });
            if result.is_ok() {
                if let Some(folder) = folder {
                    if let Err(error) = folder.save() {
                        if let Some(server) = server.as_mut() { server.stop().await; }
                        return Err(error);
                    }
                }
                let _ = app.emit(if folder.is_some() { "folder-classification://changed" } else { "library://assets-changed" }, ());
            }
            self.record_classification_result(db, id, &result);
            self.update(app, |_| {});
        }
        if let Some(server) = server.as_mut() {
            server.stop().await;
        }
        if completed && !self.cancel.load(Ordering::Relaxed) && self.status.lock().unwrap().failed == 0 {
            if let Some(tag) = tag.filter(|_| scope.is_none()) {
                db.finish_local_label(&tag, job_revision)
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    async fn classify_one(
        &self,
        server: Option<&runtime::Server>,
        db: &Database,
        library: &LibraryPaths,
        id: &str,
        tag: Option<&str>,
        judge: Option<&jev::Judge>,
        cloud: Option<&dyn crate::codex::understand::UnderstandProvider>,
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
        if let Some(judge) = judge {
            return self
                .classify_with_jev(
                    judge,
                    cloud,
                    db,
                    library,
                    id,
                    revision,
                    &labels,
                    tag.is_none(),
                )
                .await;
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
                .ok_or("标签发现需要本地模型")?
                .predict(&image, &shortlist, true, &[], &self.cancel)
                .await?;
            // Normalize discovered names for the local-only path.
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
                    .ok_or("本地模型未加载")?
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
    async fn jev_image(db: &Database, library: &LibraryPaths, id: &str) -> Result<Vec<u8>, String> {
        let path = db
            .local_image_path(id)
            .map_err(|e| e.to_string())?
            .ok_or("图片已删除或缺少缩略图")?;
        let root = library.root.clone();
        tokio::task::spawn_blocking(move || jev::image_data(std::path::Path::new(&path), &root))
            .await
            .map_err(|e| e.to_string())?
    }

    async fn classify_with_jev(
        &self,
        judge: &jev::Judge,
        cloud: Option<&dyn crate::codex::understand::UnderstandProvider>,
        db: &Database,
        library: &LibraryPaths,
        id: &str,
        revision: i64,
        labels: &[data::Label],
        record_observation: bool,
    ) -> Result<(), String> {
        let pending = self
            .prepare_jev(judge, db, library, id, revision, labels, record_observation)
            .await?;
        self.finish_jev(db, cloud, pending).await
    }

    async fn prepare_jev(
        &self,
        judge: &jev::Judge,
        db: &Database,
        library: &LibraryPaths,
        id: &str,
        revision: i64,
        labels: &[data::Label],
        record_observation: bool,
    ) -> Result<pipeline::PendingClassification, String> {
        #[cfg(debug_assertions)]
        self.diagnostics.begin(id, &db.get_asset(id).ok().flatten().map(|a| a.name).unwrap_or_else(|| id.into()));
        let image = Self::jev_image(db, library, id).await?;
        self.prepare_jev_image(judge, db, library, id, revision, labels, record_observation, image).await
    }

    async fn prepare_jev_image(
        &self,
        judge: &jev::Judge,
        db: &Database,
        library: &LibraryPaths,
        id: &str,
        revision: i64,
        labels: &[data::Label],
        record_observation: bool,
        image: Vec<u8>,
    ) -> Result<pipeline::PendingClassification, String> {
        let evaluated = labels.iter().map(|label| label.id.clone()).collect();
        let current_labels = db.local_labels().map_err(|e| e.to_string())?;
        // Legacy dimension caches, including `other`, never exclude an enabled label.
        let labels: Vec<_> = current_labels.iter()
            .filter(|l| l.enabled && labels.iter().any(|original| original.id == l.id)).cloned().collect();
        let mut prediction = data::Prediction {
            description: String::new(),
            tags: vec![],
            matches: vec![],
        };
        let mut questions = Vec::new();
        for label in &labels {
            if self.cancel.load(Ordering::Relaxed) {
                return Err("已停止分类".into());
            }
            let mut examples = Vec::new();
            for (asset, positive) in db
                .local_examples(&label.id, id)
                .map_err(|e| e.to_string())?
            {
                examples.push((Self::jev_image(db, library, &asset).await?, positive));
            }
            questions.push(jev::Candidate {
                name: label.name.clone(),
                description: label.description.clone(),
                english: label.english.clone(),
                examples,
            });
        }
        // One shared candidate pool; empty vocabulary goes straight to Cloud.
        let mut preview = Vec::new();
        let mut ticket = None;
        #[cfg(debug_assertions)]
        let observed_judge = judge.observed(self.diagnostics.clone(), id);
        #[cfg(debug_assertions)]
        let judge = &observed_judge;
        self.diagnostics.step(id, "judge", "Jev 匹配请求（含网络、认证和服务端处理）");
        let decisions = judge
            .classify_mode(&image, &questions, &self.cancel, record_observation, |translated| {
                for (index, english) in translated {
                    db.cache_label_english(&labels[*index], english).map_err(|e| e.to_string())?;
                }
                Ok(())
            }, |value, error| {
                ticket = value["classification_id"].as_str().map(str::to_string);
                let report = jev::Report::from_response(&questions, value, error);
                preview = report.preview();
                let mut status = self.status.lock().unwrap();
                if let Some(progress) = status.jev_progress.as_mut().filter(|p| p.asset.id == id) {
                    progress.report = Some(report);
                    progress.message =
                        "Jev 已返回全部候选概率，按前三名且不低于 42% 筛选，等待此图处理完成".into();
                }
            })
            .await?;
        for index in &decisions {
            let id = &labels[*index].id;
            if !prediction.matches.contains(id) {
                prediction.matches.push(id.clone());
            }
        }
        let needs_discovery = record_observation && decisions.is_empty();
        if judge.is_cloud() && ticket.is_none() { return Err("Cloud 分类缺少请求凭据".into()); }
        Ok(pipeline::PendingClassification {
            cloud_request: ticket.map(|ticket| (judge.clone(), ticket, image)),
            preview,
            id: id.into(),
            revision,
            prediction,
            record_observation,
            evaluated,
            needs_discovery,
        })
    }

    async fn finish_jev(
        &self,
        db: &Database,
        cloud: Option<&dyn crate::codex::understand::UnderstandProvider>,
        mut pending: pipeline::PendingClassification,
    ) -> Result<(), String> {
        let mut definitions = Vec::new();
        if pending.needs_discovery {
            self.diagnostics.step(&pending.id, "discover", "Cloud 补标签请求（含网络和服务端处理）");
            if db.local_revision().map_err(|e| e.to_string())? != pending.revision {
                return Err("标签已被人工修改，请重试此素材".into());
            }
            // Queued images must see tags created since their Jev request, too.
            let current_labels = db.local_labels().map_err(|e| e.to_string())?;
            let discovered = if let Some((judge, ticket, image)) = &pending.cloud_request {
                cloud::discover_managed(judge, ticket, image, &current_labels, &self.cancel).await?
            } else {
                let provider = cloud.ok_or("Cloud 分类服务未就绪")?;
                let path = db.local_image_path(&pending.id).map_err(|e| e.to_string())?.ok_or("图片已删除或缺少缩略图")?;
                cloud::discover(provider, PathBuf::from(path), &current_labels, &self.cancel).await?
            };
            pending.prediction.matches.extend(discovered.matches);
            pending.prediction.description = discovered.description;
            for label in discovered.labels {
                pending.prediction.tags.push(label.name.clone());
                definitions.push(label);
            }
        }
        if self.cancel.load(Ordering::Relaxed) {
            return Err("已停止分类".into());
        }
        self.diagnostics.step(&pending.id, "save", "保存标签和分类观察记录");
        if !db
            .apply_classification_with_definitions(
                &pending.id,
                pending.revision,
                &pending.prediction,
                pending.record_observation,
                &pending.evaluated,
                jev::OBSERVATION_MODEL,
                &definitions,
            )
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
            if !db.local_enabled().unwrap_or(false) {
                continue;
            }
            if classifier.foreground_requests.load(Ordering::Relaxed) > 0 { continue; }
            let use_jev = {
                let settings = app.state::<crate::core::settings::SettingsState>();
                let snapshot = settings.get();
                snapshot.jev_image_classification_enabled
            };
            if !use_jev && !runtime::installed(&classifier.root) {
                continue;
            }
            let model = if use_jev {
                jev::OBSERVATION_MODEL
            } else {
                data::MODEL_ID
            };
            if db
                    .local_auto_targets(model)
                    .is_ok_and(|ids| !ids.is_empty())
            {
                if classifier
                    .start_run(
                        app.clone(),
                        db.clone(),
                        paths.clone(),
                        false,
                        None,
                        use_jev,
                        true,
                        true,
                        None,
                        None,
                    )
                    .is_err()
                {
                    continue;
                }
                // start_run pauses automatic retries on its own failure before
                // releasing the gate. Do not inspect a future owner's status here.
            }
        }
    });
}
