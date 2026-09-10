//! 生成任务收尾与启动恢复（视频生成 spec Phase A Task 5）。
//!
//! [`finalize_generation_assets`]：把 provider 产出的源图入库为正式资产 + 落 generation_meta +
//! 自动命名，供 `codex_create_image`（正常路径）与启动恢复 worker 复用，保证两条路径产物元数据一致。
//! 生成图不再自动写 caption（曾从生成 prompt 拆 `【维度】：正文` 当反推，导致所有生成图被标为
//! 「有反推」——已移除；生成图需手动反推才进创作板 @ 池 / 标 🏷️）。

use std::path::PathBuf;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Semaphore;
use ulid::Ulid;

use crate::codex::jimeng::{
    list_remote_tasks, poll_query_and_download, resolve_dreamina_binary, RemoteJimengTask,
};
use crate::core::ingest;
use crate::core::library::{Analysis, Asset};
use crate::core::paths::LibraryPaths;
use crate::core::task_queue::{GenJob, Task};
use crate::db::Database;
use crate::error::{AppError, AppResult};

/// 即梦同账号视频/图片并发上限 = 1（spike 实证 `ExceedConcurrencyLimit`，ret=1310）。
/// permit=1 Semaphore 让即梦 job 在 Bowerbird 侧串行（同时只 1 个 dreamina 子进程），避免多 job
/// 并发撞限制；codex 不受此限可并行。正常生成（`codex_create_image`）与启动恢复 worker
///（`recover_one_jimeng_job`）共用此令牌，FIFO 公平排队（恢复轮询久时新发即梦 job 等待，可接受）。
pub static JIMENG_FLY: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(1));

/// 取消覆盖等待账号名额与远端查询，返回后不再取消同步入库。
async fn cancellable_jimeng_query<T>(
    semaphore: &Semaphore,
    cancel_rx: &mut Option<tokio::sync::oneshot::Receiver<()>>,
    query: impl std::future::Future<Output = AppResult<T>>,
) -> Option<AppResult<T>> {
    tokio::select! {
        result = async {
            let _permit = semaphore.acquire().await.map_err(|e| AppError::Other(e.to_string()))?;
            query.await
        } => Some(result),
        _ = async { match cancel_rx.as_mut() { Some(rx) => { let _ = rx.await; }, None => std::future::pending::<()>().await } } => None,
    }
}

fn provider_source_tag(provider: &str) -> &'static str {
    if provider.starts_with("bowerbird-cloud") {
        // Cloud 三档变体（Pro/标准/Lite）入库 source 统一，侧栏 smart query 与徽标零特判。
        "bowerbird-cloud"
    } else {
        match provider {
            "jimeng" | "dreamina" => "jimeng",
            _ => "codex",
        }
    }
}

fn media_from_paths(paths: &[PathBuf]) -> &'static str {
    if paths.iter().any(|p| p.extension().and_then(|e| e.to_str()).is_some_and(crate::media::probe::is_video)) { "video" } else { "image" }
}

fn update_creative_job_status(
    app: &AppHandle,
    db: &Database,
    job: &GenJob,
    status: &str,
    provider_session_id: Option<&str>,
) {
    let (Some(project_id), Some(thread_id), Some(turn_key)) = (
        job.project_id.as_deref(),
        job.thread_id.as_deref(),
        job.turn_key.as_deref(),
    ) else {
        return;
    };
    if let Err(error) = db.update_project_generation_turn_status(
        project_id,
        thread_id,
        &job.id,
        turn_key,
        status,
        provider_session_id,
    ) {
        tracing::warn!(
            "gen: failed to update creative graph for {}: {error}",
            job.id
        );
    }
    let _ = app.emit(
        "creative://changed",
        serde_json::json!({
            "projectId": project_id,
            "threadId": thread_id,
            "jobId": &job.id,
            "turnKey": turn_key,
            "status": status,
        }),
    );
}

/// 从本地任务与已入库 generation_meta 幂等修复项目画板投影。
/// 该路径只补 thread link / prompt / output 节点，绝不调用 provider 或重新计费。
pub(crate) fn recover_project_generation_projection(
    db: &Database,
    job: &GenJob,
    task_status: &str,
) -> AppResult<bool> {
    let (Some(project_id), Some(thread_id), Some(turn_key)) = (
        job.project_id.as_deref(),
        job.thread_id.as_deref(),
        job.turn_key.as_deref(),
    ) else {
        return Ok(false);
    };
    let conversation_id = job.conversation_id.as_deref().unwrap_or(&job.id);
    db.begin_project_generation_turn(&crate::core::project_canvas::ProjectGenerationTurnInput {
        project_id: project_id.to_string(),
        thread_id: thread_id.to_string(),
        generation_conversation_id: conversation_id.to_string(),
        job_id: job.id.clone(),
        turn_key: turn_key.to_string(),
        prompt: job.prompt.clone(),
        applied_prompt: job
            .applied_prompt
            .clone()
            .unwrap_or_else(|| job.prompt.clone()),
        provider: job.provider.clone(),
        provider_session_id: job.session_id.clone(),
        ratio: job.ratio.clone(),
        visual_profile: job.visual_profile.as_ref().map(|profile| {
            crate::core::creative_session_contract::VisualProfileRefV1 {
                profile_id: profile.profile_id.clone(),
                version: profile.version,
                hash: profile.hash.clone(),
            }
        }),
        reference_node_ids: job.reference_node_ids.clone(),
        references: job.references.clone(),
        parent_node_id: job.parent_node_id.clone(),
        parent_asset_path: job.parent_asset_path.clone(),
        relation: job.creative_relation,
    })?;

    let asset_ids = {
        let conn = db.conn.lock().unwrap();
        let mut statement = conn.prepare(
            "SELECT DISTINCT asset_id FROM analyses
             WHERE kind='generation_meta'
               AND json_extract(payload,'$.job_id')=?1
               AND json_extract(payload,'$.turn_key')=?2
             ORDER BY COALESCE(created_at,0),id",
        )?;
        let rows = statement
            .query_map(rusqlite::params![job.id, turn_key], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let mut outputs = Vec::new();
    for asset_id in asset_ids {
        if let Some(asset) = db.get_asset(&asset_id)? {
            outputs.push(asset);
        }
    }
    if !outputs.is_empty() {
        db.complete_project_generation_turn(
            project_id,
            thread_id,
            &job.id,
            turn_key,
            job.session_id.as_deref(),
            &outputs,
        )?;
    }
    // `task_queue.status` is the durable task state. The status embedded in the
    // GenJob payload can lag because terminal transitions update the queue column.
    db.update_project_generation_turn_status(
        project_id,
        thread_id,
        &job.id,
        turn_key,
        task_status,
        job.session_id.as_deref(),
    )?;
    Ok(true)
}

/// 把 provider 产出的源图收尾入库：ingest（每个 src，不算 pHash 不去重）→ 删临时下载目录 →
/// project link → generation_meta（payload 增 `submit_id`，详情页「✨ 生成来源」卡片）→ 后台自动命名。
/// 返回入库的资产。
///
/// `codex_create_image`（正常路径）与启动恢复 worker 都调它，保证恢复资产也有完整 ✨ 来源。
/// 自动命名 `spawn_auto_name_only` 自身 spawn task（需 `Arc<Database>`），故本函数为 async。
pub async fn finalize_generation_assets(
    app: AppHandle,
    db: Arc<Database>,
    paths: Arc<LibraryPaths>,
    src_images: Vec<PathBuf>,
    temp_dir: Option<PathBuf>,
    prompt: String,
    applied_prompt: Option<String>,
    prompt_raw: Option<String>,
    // 借用维度源图（图 chip 被删、只借维度的资产 id）：随 meta 落库，复用生成提示词时
    // 据此回绑车牌取最新反推内容（generation_history → dimension_assets）。恢复路径无 → None。
    dimension_sources: Option<Vec<String>>,
    references: Vec<String>,
    session_id: Option<String>,
    conversation_id: Option<String>,
    submit_id: Option<String>,
    provider: String,
    project_id: Option<String>,
    visual_profile: Option<crate::core::visual_profile::VisualProfileCapsule>,
    codex_thread: Option<String>,
    thread_id: Option<String>,
    generation_job_id: Option<String>,
    turn_key: Option<String>,
) -> AppResult<Vec<Asset>> {
    let source_tag = provider_source_tag(&provider).to_string();
    let generation_job = generation_job_id.as_deref()
        .map(|id| Task::by_id(&db, id)).transpose()?.flatten()
        .and_then(|task| task.gen_job());
    let video_options = generation_job.as_ref().and_then(|job| job.video_options.clone());
    let reference_node_ids = generation_job.as_ref().map(|job| job.reference_node_ids.clone()).unwrap_or_default();
    let cloud_video_remote = if provider.starts_with("bowerbird-cloud") { submit_id.clone().filter(|_| media_from_paths(&src_images) == "video") } else { None };
    let ratio = generation_job.as_ref().and_then(|job| job.ratio.clone());
    let media = if src_images.iter().any(|p| p.extension().and_then(|e| e.to_str()).is_some_and(crate::media::probe::is_video)) { "video" } else { "image" };

    // ingest + 删 temp + project link + generation_meta + caption（同步 DB 写，spawn_blocking）
    let db_b = db.clone();
    let paths_b = paths.clone();
    let gen_assets: Vec<Asset> = tokio::task::spawn_blocking(move || -> AppResult<Vec<Asset>> {
        let mut out: Vec<Asset> = Vec::new();
        for src in &src_images {
            out.push(ingest::ingest_generated(
                &paths_b,
                &db_b,
                src,
                session_id.as_deref(),
                &source_tag,
            )?);
        }
        // 源图已 copy 进库，删临时下载目录（即梦用；codex 为 None 不删）。
        if let Some(dir) = &temp_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
        // 会话级分组持久化（session → conversation）：生成图入库即记，瀑布流 / 详情分组查询
        // 据此把「重新编辑 / 重试」各版本 session 并成一组；失败仅告警不影响入库结果。
        if let (Some(sid), Some(conv)) = (session_id.as_deref(), conversation_id.as_deref()) {
            if let Err(e) = db_b.record_generation_conversation(sid, conv) {
                tracing::warn!("记录会话分组失败 session={sid} conv={conv}: {e}");
            }
        }
        if let Some(pid) = project_id.as_deref() {
            let ids: Vec<String> = out.iter().map(|a| a.id.clone()).collect();
            if let Err(e) = db_b.add_assets_to_project(pid, &ids) {
                tracing::warn!("failed to link generated assets to project {pid}: {e}");
            }
        }

        // generation_meta（详情页「✨ 生成来源」卡片；payload 增 submit_id 供事后取回）。
        // prompt = 铺开发 provider 用；prompt_raw = 未铺开的原始编辑框文本，复用时载入还原 chip。
        // codex_thread = codex 轮的真实 thread id（与即梦 submit_id 对称的续接句柄）：非 codex
        // 原生会话（即梦/Cloud 会话）切 codex 时靠它让连续 codex 轮共享一个 thread（下轮 resume）。
        let visual_profile_meta = visual_profile.as_ref().map(|capsule| {
            serde_json::json!({
                "profile_id": &capsule.profile_id,
                "version": capsule.version,
                "hash": &capsule.hash,
            })
        });
        let meta_payload = serde_json::json!({
            "prompt": prompt,
            "applied_prompt": applied_prompt,
            "prompt_raw": prompt_raw,
            "session_id": session_id,
            "conversation_id": conversation_id,
            "thread_id": thread_id,
            "job_id": generation_job_id,
            "turn_key": turn_key,
            "references": references,
            "reference_node_ids": reference_node_ids,
            "dimension_sources": dimension_sources,
            "provider": provider,
            "visual_profile": visual_profile_meta,
            "visual_profile_capsule": visual_profile,
            "submit_id": submit_id,
            "codex_thread": codex_thread,
            "media": media,
            "media_type": media,
            "video_options": video_options,
            "ratio": ratio,
        })
        .to_string();
        for a in &out {
            let row = Analysis {
                id: Ulid::new().to_string(),
                asset_id: a.id.clone(),
                kind: "generation_meta".to_string(),
                payload: meta_payload.clone(),
                provider: Some(provider.clone()),
                created_at: None,
            };
            db_b.insert_analysis(&row)?;
        }
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;

    if let Some(remote) = cloud_video_remote {
        let cloud = app.state::<crate::cloud::CloudClient>();
        let auth = app.state::<crate::cloud::AuthClient>();
        if let Some(endpoint) = cloud.config().endpoint("generate-proxy") {
            crate::codex::bowerbird_cloud::acknowledge_artifact(&auth, &cloud, &endpoint, &remote).await;
        }
    }

    // 后台自动命名（每张生成图各跑一次，用生成 prompt 维度数据纯文本取名——codex 与
    // cloud 共用一条通路，不看图；替代 codex 默认 ig_<hash>，见 autoname）。
    for a in gen_assets.clone() {
        if a.ext.as_deref().is_some_and(crate::media::probe::is_video) { continue; }
        crate::core::autoname::spawn_auto_name_only(app.clone(), db.clone(), a);
    }
    Ok(gen_assets)
}

/// app 启动恢复入口：扫 `task_queue` 未完成（queued/running）的 generation job，
/// - codex job → `mark_failed`（codex exec 无 resume-from-mid，不可恢复）+ emit error；
/// - 即梦 job 但 submit_id=None → `mark_failed`（重启前未拿到 submit_id，无法续查）；
/// - 即梦 job + submit_id → 后台 spawn `recover_one_jimeng_job` 续查。
///
/// 异步不阻塞启动；恢复 job 的 permit 与正常生成公平排队（JIMENG_FLY FIFO）。
pub fn spawn_recovery(app: AppHandle, db: Arc<Database>, paths: Arc<LibraryPaths>) {
    tauri::async_runtime::spawn(async move {
        match Task::list_project_generation(&db) {
            Ok(tasks) => {
                for task in tasks {
                    let Some(job) = task.gen_job() else { continue };
                    if let Err(error) =
                        recover_project_generation_projection(&db, &job, &task.status)
                    {
                        tracing::warn!(
                            job_id = %job.id,
                            error = %error,
                            "failed to recover project canvas generation projection"
                        );
                    }
                }
            }
            Err(error) => tracing::warn!(
                error = %error,
                "failed to scan project generation projections"
            ),
        }
        let auth = app.state::<crate::cloud::AuthClient>().inner().clone();
        let entitlement = app.state::<crate::cloud::EntitlementService>();
        let entitlement_snapshot = entitlement.current_or_sync(&auth).await;
        let mut running = match Task::list_running(&db) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("启动恢复：list_running 失败: {e}");
                return;
            }
        };
        // Local Cloud video failures remain recoverable with their original key.
        if let Ok(tasks) = Task::list_project_generation(&db) {
            for task in tasks {
                if task.status != "failed" { continue; }
                if let Some(job) = task.gen_job().filter(|job| job.media == "video" && job.provider.starts_with("bowerbird-cloud")) {
                    if Task::claim_cloud_video_retrieval(&db,&job).unwrap_or(false) { running.push(task); }
                }
            }
        }
        tracing::info!("启动恢复：list_running 扫到 {} 条未完成 job", running.len());
        for task in running {
            let Some(mut job) = task.gen_job() else { continue };
            tracing::info!(
                "恢复扫描：job={} provider={} status={} submit_id={:?}",
                job.id,
                job.provider,
                job.status,
                job.submit_id
            );
            if matches!(job.provider.as_str(), "jimeng" | "dreamina")
                && !entitlement_snapshot.policy.can_use_byo
            {
                let message = "当前账号已降级，升级 Pro 后才能恢复即梦 CLI 任务";
                let _ = Task::mark_failed(&db, &job.id, message);
                update_creative_job_status(&app, &db, &job, "failed", None);
                let _ = app.emit(
                    "codex://chunk",
                    serde_json::json!({ "kind": "error", "job_id": job.id, "message": message }),
                );
                continue;
            }
            if !matches!(
                job.provider.as_str(),
                "jimeng" | "dreamina" | "bowerbird-cloud"
            ) && !job.provider.starts_with("bowerbird-cloud-") {
                let _ = Task::mark_failed(&db, &job.id, "app 重启中断，codex 会话不可恢复");
                update_creative_job_status(&app, &db, &job, "failed", None);
                let _ = app.emit(
                    "codex://chunk",
                    serde_json::json!({ "kind": "error", "job_id": job.id, "message": "app 重启中断，codex 会话不可恢复" }),
                );
                continue;
            }
            if job.media == "video" && job.provider.starts_with("bowerbird-cloud") && job.submit_id.is_none() {
                let cloud = app.state::<crate::cloud::CloudClient>();
                if let Some(turn) = job.turn_key.as_deref() {
                    match crate::codex::bowerbird_cloud::find_video_job(&cloud, &auth, &job.id, turn).await {
                        Ok(Some(id)) => { job.submit_id = Some(id); let _ = Task::upsert_gen_job(&db, &job); }
                        _ => {
                            let message = "原视频提交状态待核对，不会自动重新生成";
                            let _ = Task::mark_failed(&db,&job.id,message);
                            let _ = app.emit("codex://chunk", serde_json::json!({ "kind": "error", "job_id": job.id, "message": message }));
                            continue;
                        }
                    }
                }
            }
            let Some(submit_id) = job.submit_id.clone() else {
                let _ = Task::mark_failed(&db, &job.id, "重启前未拿到 submit_id，无法续查");
                update_creative_job_status(&app, &db, &job, "failed", None);
                let _ = app.emit(
                    "codex://chunk",
                    serde_json::json!({ "kind": "error", "job_id": job.id, "message": "未拿到 submit_id，无法续查" }),
                );
                continue;
            };
            if job.provider.starts_with("bowerbird-cloud") {
                let (app2, db2, paths2) = (app.clone(), db.clone(), paths.clone());
                tokio::spawn(async move {
                    recover_one_cloud_job(app2, db2, paths2, job, submit_id).await;
                });
                continue;
            }
            // 即梦 job + submit_id → 后台续查（recover_started 自包含，不依赖前端 mount 顺序）。
            let (app2, db2, paths2) = (app.clone(), db.clone(), paths.clone());
            tokio::spawn(async move {
                recover_one_jimeng_job(app2, db2, paths2, job, submit_id).await;
            });
        }
    });
}

/// 续查 Bowerbird Cloud 持久任务。Cloud 任务由 VPS 独立执行，桌面重启后只需按 job_id
/// 恢复轮询和产物下载；不会重新提交方舟请求。
pub(crate) async fn recover_one_cloud_job(
    app: AppHandle,
    db: Arc<Database>,
    paths: Arc<LibraryPaths>,
    mut job: GenJob,
    submit_id: String,
) {
    let _ = app.emit(
        "codex://chunk",
        serde_json::json!({
            "kind": "recover_started",
            "job_id": job.id,
            "prompt": job.prompt,
            "provider": job.provider,
            "project_id": job.project_id,
            "thread_id": job.thread_id,
            "turn_key": job.turn_key,
            "media": job.media,
            "video_options": job.video_options,
            "references": job.references,
            "reference_node_ids": job.reference_node_ids,
            "ratio": job.ratio,
            "submit_id": submit_id,
        }),
    );
    job.status = "querying".into();
    let _ = Task::upsert_gen_job(&db, &job);
    update_creative_job_status(&app, &db, &job, "querying", Some(&submit_id));
    let cloud = app.state::<crate::cloud::CloudClient>().inner().clone();
    let auth = app.state::<crate::cloud::AuthClient>().inner().clone();
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
    crate::commands::codex::GENERATE_CANCEL.lock().unwrap().insert(job.id.clone(),cancel_tx);
    let recovered = tokio::select! {
        result = crate::codex::bowerbird_cloud::recover_cloud_generation(&cloud, &auth, &submit_id) => result,
        _ = &mut cancel_rx => {
            let _ = Task::mark_cancelled(&db,&job.id);
            let _ = app.emit("codex://chunk",serde_json::json!({"kind":"error","job_id":job.id,"message":"已停止等待，可按原任务取回视频"}));
            return;
        }
    };
    crate::commands::codex::GENERATE_CANCEL.lock().unwrap().remove(&job.id);
    match recovered {
        Ok((src_images, temp_dir)) => {
            // 会话语义（同即梦恢复）：job 死在续轮时记回会话首轮 session，不把历史撕成两段。
            let session_for_meta = job.session_id.clone().or_else(|| Some(submit_id.clone()));
            match finalize_generation_assets(
                app.clone(),
                db.clone(),
                paths,
                src_images,
                Some(temp_dir),
                job.prompt.clone(),
                job.applied_prompt.clone(),
                None,
                // 恢复路径无借用维度 sidecar（GenJob 不携带），meta 缺省前端走 raw 正文回绑。
                None,
                job.references.clone(),
                session_for_meta.clone(),
                job.conversation_id.clone(),
                Some(submit_id.clone()),
                job.provider.clone(),
                job.project_id.clone(),
                job.visual_profile.clone(),
                None,
                job.thread_id.clone(),
                Some(job.id.clone()),
                job.turn_key.clone(),
            )
            .await
            {
                Ok(assets) => {
                    if let (Some(project_id), Some(thread_id), Some(turn_key)) = (
                        job.project_id.as_deref(),
                        job.thread_id.as_deref(),
                        job.turn_key.as_deref(),
                    ) {
                        let _ = db.complete_project_generation_turn(
                            project_id,
                            thread_id,
                            &job.id,
                            turn_key,
                            session_for_meta.as_deref(),
                            &assets,
                        );
                        let _ = app.emit(
                            "creative://changed",
                            serde_json::json!({
                                "projectId": project_id,
                                "threadId": thread_id,
                                "jobId": &job.id,
                                "turnKey": turn_key,
                                "status": "done",
                            }),
                        );
                    }
                    let asset_paths: Vec<PathBuf> = assets
                        .iter()
                        .filter_map(|asset| asset.store_path.clone().map(PathBuf::from))
                        .collect();
                    let _ = Task::mark_done(&db, &job.id);
                    let _ = app.emit(
                        "codex://chunk",
                        serde_json::json!({ "kind": "done", "job_id": job.id, "images": asset_paths, "provider": "bowerbird-cloud", "session_id": session_for_meta, "text": "", "elapsed_ms": 0 }),
                    );
                    let _ = app.emit("library://assets-changed", ());
                }
                Err(error) => {
                    let message = error.to_string();
                    let _ = Task::mark_failed(&db, &job.id, &message);
                    update_creative_job_status(&app, &db, &job, "failed", Some(&submit_id));
                    let _ = app.emit(
                        "codex://chunk",
                        serde_json::json!({ "kind": "error", "job_id": job.id, "message": message }),
                    );
                }
            }
        }
        Err(error) => {
            let message = error.to_string();
            let _ = Task::mark_failed(&db, &job.id, &message);
            update_creative_job_status(&app, &db, &job, "failed", Some(&submit_id));
            let _ = app.emit(
                "codex://chunk",
                serde_json::json!({ "kind": "error", "job_id": job.id, "message": message }),
            );
        }
    }
}

/// 续查单个即梦 job：emit recover_started（前端 upsert 占位 job）→ 拿 JIMENG_FLY permit →
/// status=querying 落库 → poll_query_and_download 续查下载 → finalize_generation_assets 入库 →
/// emit done。远端仍排队则保持 running + emit recover_polling（下次启动再试）；真失败 mark_failed。
/// 启动恢复与孤儿取回（`jimeng_retrieve_orphan`）共用。
pub(crate) async fn recover_one_jimeng_job(
    app: AppHandle,
    db: Arc<Database>,
    paths: Arc<LibraryPaths>,
    job: GenJob,
    submit_id: String,
) {
    if job.media != "video" {
        recover_one_jimeng_job_inner(app, db, paths, job, submit_id, None).await;
        return;
    }
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    crate::commands::codex::GENERATE_CANCEL.lock().unwrap().insert(job.id.clone(), cancel_tx);
    recover_one_jimeng_job_inner(app, db, paths, job.clone(), submit_id, Some(cancel_rx)).await;
    crate::commands::codex::GENERATE_CANCEL.lock().unwrap().remove(&job.id);
}

async fn recover_one_jimeng_job_inner(
    app: AppHandle,
    db: Arc<Database>,
    paths: Arc<LibraryPaths>,
    mut job: GenJob,
    submit_id: String,
    mut cancel_rx: Option<tokio::sync::oneshot::Receiver<()>>,
) {
    // ① recover_started 自包含事件：前端据此 upsert 占位 job，防 done 早于 loadGenJobs 丢事件。
    let _ = app.emit(
        "codex://chunk",
        serde_json::json!({
            "kind": "recover_started",
            "job_id": job.id,
            "prompt": job.prompt,
            "provider": job.provider,
            "project_id": job.project_id,
            "thread_id": job.thread_id,
            "turn_key": job.turn_key,
            "media": job.media,
            "video_options": job.video_options,
            "ratio": job.ratio,
            "references": job.references,
            "submit_id": job.submit_id,
        }),
    );
    // ② 拿 permit（FIFO 公平，与正常即梦生成串行）。
    // ③ status=querying 落库（前端 loadGenJobs 拉到时显示「续查中」）。
    job.status = "querying".into();
    let _ = Task::upsert_gen_job(&db, &job);
    update_creative_job_status(&app, &db, &job, "querying", Some(&submit_id));

    // ④ 轮询续查下载（策略 B：bounded poll loop，向下兼容 query_result 阻塞等待）。
    let binary = resolve_dreamina_binary().unwrap_or_else(|| "dreamina".to_string());
    let query = async {
    if job.media == "video" {
        crate::codex::jimeng_video::poll_video(&binary, &submit_id).await.map(|(files, dir)| (files, Some(dir)))
    } else {
        poll_query_and_download(&binary, &submit_id, 30, Duration::from_secs(10)).await.map(|files| {
            let dir = files.first().and_then(|p| p.parent()).map(std::path::Path::to_path_buf);
            (files, dir)
        })
    }
    };
    let downloaded = match cancellable_jimeng_query(&JIMENG_FLY, &mut cancel_rx, query).await {
        Some(result) => result,
        None => {
            let _ = Task::mark_cancelled(&db, &job.id);
            update_creative_job_status(&app, &db, &job, "cancelled", job.session_id.as_deref());
            let _ = app.emit("codex://chunk", serde_json::json!({"kind":"error", "job_id":job.id, "message":"已停止本地查询；即梦远端任务可能仍在运行，可取回视频"}));
            return;
        }
    };
    if job.media == "video" {
        crate::commands::codex::GENERATE_CANCEL.lock().unwrap().remove(&job.id);
    }
    match downloaded {
        Ok((src_images, temp_dir)) => {
            tracing::info!("恢复续查成功：job={} 图={} 张", job.id, src_images.len());
            // 会话语义：job 死在续轮时 task_queue 已有会话首轮 session（即梦首轮 submit_id），
            // meta/done 都要记回该 session（记成本轮自己的 submit_id 会把会话历史撕裂成两段，
            // 前端回看/重启恢复只剩半截）；死在首轮则本轮 submit_id 即会话 id。
            let session_for_meta = job.session_id.clone().or_else(|| Some(submit_id.clone()));
            match finalize_generation_assets(
                app.clone(),
                db.clone(),
                paths.clone(),
                src_images,
                temp_dir,
                job.prompt.clone(),
                job.applied_prompt.clone(),
                None,
                // 恢复路径无借用维度 sidecar（GenJob 不携带），meta 缺省前端走 raw 正文回绑。
                None,
                job.references.clone(),
                session_for_meta.clone(),
                job.conversation_id.clone(),
                Some(submit_id.clone()),
                "jimeng".to_string(),
                job.project_id.clone(),
                job.visual_profile.clone(),
                None,
                job.thread_id.clone(),
                Some(job.id.clone()),
                job.turn_key.clone(),
            )
            .await
            {
                Ok(assets) => {
                    if let (Some(project_id), Some(thread_id), Some(turn_key)) = (
                        job.project_id.as_deref(),
                        job.thread_id.as_deref(),
                        job.turn_key.as_deref(),
                    ) {
                        let _ = db.complete_project_generation_turn(
                            project_id,
                            thread_id,
                            &job.id,
                            turn_key,
                            session_for_meta.as_deref(),
                            &assets,
                        );
                        let _ = app.emit(
                            "creative://changed",
                            serde_json::json!({
                                "projectId": project_id,
                                "threadId": thread_id,
                                "jobId": &job.id,
                                "turnKey": turn_key,
                                "status": "done",
                            }),
                        );
                    }
                    let asset_paths: Vec<PathBuf> = assets
                        .iter()
                        .filter_map(|a| a.store_path.clone().map(PathBuf::from))
                        .collect();
                    let _ = Task::mark_done(&db, &job.id);
                    let _ = app.emit(
                        "codex://chunk",
                        serde_json::json!({ "kind": "done", "job_id": job.id, "images": asset_paths, "provider": "jimeng", "session_id": session_for_meta, "text": "", "elapsed_ms": 0 }),
                    );
                    let _ = app.emit("library://assets-changed", ());
                }
                Err(e) => {
                    let msg = e.to_string();
                    let _ = Task::mark_failed(&db, &job.id, &msg);
                    update_creative_job_status(&app, &db, &job, "failed", Some(&submit_id));
                    let _ = app.emit(
                        "codex://chunk",
                        serde_json::json!({ "kind": "error", "job_id": job.id, "message": msg }),
                    );
                }
            }
        }
        Err(e) => {
            let msg = e.to_string();
            tracing::info!("恢复续查未完成：job={} err={}", job.id, msg);
            // 远端仍排队中（querying/未下载到图/轮询超时）→ 保持 running + 提示；真失败 mark_failed。
            if job.media != "video" && (msg.contains("排队") || msg.contains("querying") || msg.contains("未下载到图片"))
            {
                let _ = app.emit(
                    "codex://chunk",
                    serde_json::json!({ "kind": "recover_polling", "job_id": job.id, "message": msg }),
                );
            } else {
                let _ = Task::mark_failed(&db, &job.id, &msg);
                update_creative_job_status(&app, &db, &job, "failed", Some(&submit_id));
                let _ = app.emit(
                    "codex://chunk",
                    serde_json::json!({ "kind": "error", "job_id": job.id, "message": msg }),
                );
            }
        }
    }
}

/// 启动孤儿扫描（约定 23 阶段 3）：`dreamina list_task` 比对本地已知 submit_id，远端仍在
/// `querying`（或已完成但从未下载的 `success`）且本地无记录的图片任务 → emit
/// `codex://jimeng-orphans`，前端会话面板提供「取回」入口。孤儿取回经
/// `jimeng_retrieve_orphan` command 合成 GenJob 后复用 [`recover_one_jimeng_job`]。
///
/// 与恢复同口径的前置：即梦是 BYO provider，免费档不扫；CLI 未装/未登录静默跳过
/// （扫描失败绝不打扰用户——孤儿只影响「可选取回」，不影响正常功能）。
pub fn spawn_orphan_scan(app: AppHandle, db: Arc<Database>) {
    tauri::async_runtime::spawn(async move {
        let auth = app.state::<crate::cloud::AuthClient>().inner().clone();
        let entitlement = app.state::<crate::cloud::EntitlementService>();
        let snapshot = entitlement.current_or_sync(&auth).await;
        if !snapshot.policy.can_use_byo {
            return;
        }
        let Some(binary) = resolve_dreamina_binary() else {
            tracing::debug!("孤儿扫描：未找到 dreamina CLI，跳过");
            return;
        };
        // 延后 15s：启动即有登录态/磁盘 IO 高峰，孤儿不急（spike 实证卡几小时也不丢）。
        tokio::time::sleep(Duration::from_secs(15)).await;
        let remote = match list_remote_tasks(&binary, 20).await {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!("孤儿扫描：list_task 失败（忽略）: {e}");
                return;
            }
        };
        let known = match known_submit_ids(&db) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("孤儿扫描：读本地 submit_id 失败: {e}");
                return;
            }
        };
        // 只取图片任务（gen_task_type 含 image）：视频产物 walk_images 扫不到，取回必失败；
        // 视频链路（Phase B）落地后再放开。
        let orphans: Vec<RemoteJimengTask> = remote
            .into_iter()
            .filter(|t| {
                t.gen_task_type.contains("image")
                    && matches!(t.gen_status.as_str(), "querying" | "success")
                    && !known.contains(&t.submit_id)
            })
            .collect();
        if orphans.is_empty() {
            tracing::debug!("孤儿扫描：无孤儿任务");
            return;
        }
        tracing::info!("孤儿扫描：发现 {} 条孤儿任务", orphans.len());
        let _ = app.emit("codex://jimeng-orphans", &orphans);
    });
}

/// 本地已知的即梦 submit_id 集合：task_queue 全状态 GenJob（done/failed/cancelled 也算
/// 已知——它们有本地记录，不是孤儿）+ generation_meta 来源卡片（task_queue 记录被清理后
/// 仍能识别，防止把已入库任务再当孤儿）。
fn known_submit_ids(db: &Arc<Database>) -> AppResult<std::collections::HashSet<String>> {
    let conn = db.conn.lock().unwrap();
    let mut out = std::collections::HashSet::new();
    {
        let mut stmt = conn.prepare("SELECT payload FROM task_queue WHERE kind = 'generation'")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for row in rows {
            let Ok(payload) = row else { continue };
            if let Ok(job) = serde_json::from_str::<GenJob>(&payload) {
                if let Some(submit_id) = job.submit_id {
                    out.insert(submit_id);
                }
            }
        }
    }
    {
        let mut stmt = conn.prepare(
            "SELECT json_extract(payload, '$.submit_id') FROM analyses \
             WHERE kind = 'generation_meta' AND json_valid(payload)",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, Option<String>>(0))?;
        for row in rows {
            if let Ok(Some(submit_id)) = row {
                out.insert(submit_id);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn video_recovery_cancel_before_permit_never_starts_query() {
        let semaphore = Semaphore::new(0);
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut cancel = Some(rx);
        tx.send(()).unwrap();
        let result = cancellable_jimeng_query(&semaphore, &mut cancel, async {
            panic!("query must not run while queued");
            #[allow(unreachable_code)] Ok::<(), AppError>(())
        }).await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn video_recovery_cancel_drops_query_and_releases_permit() {
        let semaphore = Semaphore::new(1);
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut cancel = Some(rx);
        let result = cancellable_jimeng_query(&semaphore, &mut cancel, async {
            tx.send(()).unwrap();
            std::future::pending::<AppResult<()>>().await
        }).await;
        assert!(result.is_none());
        assert_eq!(semaphore.available_permits(), 1);
    }

    #[test]
    fn cloud_provider_keeps_own_source_tag() {
        assert_eq!(provider_source_tag("bowerbird-cloud"), "bowerbird-cloud");
        assert_eq!(provider_source_tag("jimeng"), "jimeng");
        assert_eq!(provider_source_tag("codex"), "codex");
    }

    #[test]
    fn known_submit_ids_covers_gen_jobs_and_generation_meta() {
        let db = crate::db::Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        // task_queue：全状态 GenJob 的 submit_id 都算已知（含 failed）。
        let failed_job = GenJob {
            id: "job-1".into(),
            media: "image".into(),
            provider: "jimeng".into(),
            status: "failed".into(),
            prompt: String::new(),
            applied_prompt: None,
            reference_node_ids: vec![],
            references: vec![],
            session_id: None,
            conversation_id: None,
            thread_id: None,
            creative_session_id: None,
            turn_key: None,
            parent_node_id: None,
            parent_asset_path: None,
            creative_relation: None,
            project_id: None,
            ratio: None,
            visual_profile: None,
            submit_id: Some("sub-task-queue".into()),
            video_options: None,
            turns: serde_json::Value::Null,
            error: None,
            queue_idx: None,
            created_at: 1,
            started_at: None,
            finished_at: None,
        };
        Task::upsert_gen_job(&db, &failed_job).unwrap();

        // generation_meta：task_queue 记录被清理后，meta 里的 submit_id 仍识别为已知。
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO assets (id, name, created_at) VALUES ('a-1', 'x', 1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO analyses (id, asset_id, kind, payload) \
                 VALUES ('an-1', 'a-1', 'generation_meta', ?1)",
                rusqlite::params![serde_json::json!({ "submit_id": "sub-meta-only" }).to_string()],
            )
            .unwrap();
        }

        let known = known_submit_ids(&std::sync::Arc::new(db)).unwrap();
        assert!(
            known.contains("sub-task-queue"),
            "GenJob submit_id 应算已知"
        );
        assert!(
            known.contains("sub-meta-only"),
            "generation_meta submit_id 应算已知"
        );
        assert!(!known.contains("sub-unknown"), "未知 submit_id 不在集合中");
    }

    #[test]
    fn startup_projection_recovery_repairs_missing_link_and_output_without_provider_replay() {
        let db = crate::db::Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.create_project("project-1", "项目", "project-1", "project-1", "blank")
            .unwrap();
        db.ensure_project_canvas("project-1").unwrap();
        db.create_creative_thread(&crate::core::project_canvas::NewCreativeThread {
            id: "thread-1".into(),
            project_id: "project-1".into(),
            title: "生成线程".into(),
            origin: crate::core::creative_session_contract::CreativeThreadOrigin::Direct,
        })
        .unwrap();
        let job = GenJob {
            id: "job-1".into(),
            media: "image".into(),
            provider: "bowerbird-cloud".into(),
            status: "done".into(),
            prompt: "生成一张海报".into(),
            applied_prompt: Some("完整生成指令".into()),
            reference_node_ids: vec![],
            references: vec![],
            session_id: Some("provider-session-1".into()),
            conversation_id: Some("conversation-1".into()),
            thread_id: Some("thread-1".into()),
            creative_session_id: None,
            turn_key: Some("turn-1".into()),
            parent_node_id: None,
            parent_asset_path: None,
            creative_relation: None,
            project_id: Some("project-1".into()),
            ratio: Some("1:1".into()),
            visual_profile: None,
            submit_id: Some("remote-submit-1".into()),
            video_options: None,
            turns: serde_json::json!([]),
            error: None,
            queue_idx: None,
            created_at: 1,
            started_at: Some(1),
            finished_at: Some(2),
        };
        Task::upsert_gen_job(&db, &job).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO assets(id,name,store_path,created_at) VALUES ('asset-1','结果','/result.png',2)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO analyses(id,asset_id,kind,payload,created_at) VALUES ('analysis-1','asset-1','generation_meta',?1,2)",
                [serde_json::json!({"job_id":"job-1","turn_key":"turn-1"}).to_string()],
            )
            .unwrap();
        }

        assert!(db
            .thread_for_generation("conversation-1")
            .unwrap()
            .is_none());
        assert!(recover_project_generation_projection(&db, &job, "done").unwrap());
        assert_eq!(
            db.thread_for_generation("conversation-1")
                .unwrap()
                .as_deref(),
            Some("thread-1")
        );
        let first = db.project_canvas_snapshot("project-1").unwrap();
        assert_eq!(
            first
                .nodes
                .iter()
                .filter(|node| node.kind
                    == crate::core::creative_session_contract::CreativeNodeKind::Prompt)
                .count(),
            1
        );
        assert_eq!(
            first
                .nodes
                .iter()
                .filter(|node| node.asset_id.as_deref() == Some("asset-1"))
                .count(),
            1
        );

        assert!(recover_project_generation_projection(&db, &job, "done").unwrap());
        let replay = db.project_canvas_snapshot("project-1").unwrap();
        assert_eq!(replay.nodes.len(), first.nodes.len());
        assert_eq!(replay.edges.len(), first.edges.len());

        let prompt_id = replay
            .nodes
            .iter()
            .find(|node| {
                node.kind == crate::core::creative_session_contract::CreativeNodeKind::Prompt
            })
            .unwrap()
            .id
            .clone();
        assert!(matches!(
            db.remove_canvas_node(&prompt_id).unwrap(),
            Some(crate::core::project_canvas::CanvasNodeRemoval::Hidden)
        ));
        assert!(recover_project_generation_projection(&db, &job, "done").unwrap());
        assert!(db
            .get_canvas_node(&prompt_id)
            .unwrap()
            .unwrap()
            .hidden_at
            .is_some());
    }

    #[test]
    fn startup_projection_recovery_uses_persisted_exact_parent_node() {
        use crate::core::creative_session_contract::{
            AssetExecutionRefV1, AssetNodePayloadV1, AssetSnapshotV1, CreativeGenerationRelation,
            CreativeNodeKind, CreativeNodeRole,
        };
        use crate::core::project_canvas::{NewCanvasNode, NewCreativeThread};

        let db = crate::db::Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.create_project("project-1", "项目", "project-1", "project-1", "blank")
            .unwrap();
        db.ensure_project_canvas("project-1").unwrap();
        db.create_creative_thread(&NewCreativeThread {
            id: "thread-1".into(),
            project_id: "project-1".into(),
            title: "生成线程".into(),
            origin: crate::core::creative_session_contract::CreativeThreadOrigin::Direct,
        })
        .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO assets(id,name,store_path,created_at) VALUES ('parent-asset','父素材','/parent.png',1)",
                [],
            )
            .unwrap();
        }
        let payload = serde_json::to_string(&AssetNodePayloadV1 {
            schema_version: 1,
            snapshot: AssetSnapshotV1 {
                name: "父素材".into(),
                width: None,
                height: None,
            },
            execution: Some(AssetExecutionRefV1 {
                job_id: Some("older-job".into()),
                turn_key: Some("older-turn".into()),
                run_id: None,
                artifact_id: None,
            }),
        })
        .unwrap();
        for (index, node_id) in ["parent-exact", "parent-duplicate"].into_iter().enumerate() {
            db.create_canvas_node(&NewCanvasNode {
                id: node_id.into(),
                project_id: "project-1".into(),
                thread_id: Some("thread-1".into()),
                kind: CreativeNodeKind::Asset,
                asset_id: Some("parent-asset".into()),
                role: Some(CreativeNodeRole::Output),
                payload_json: payload.clone(),
                x: index as f64 * 220.0,
                y: 0.0,
                width: 190.0,
                height: 180.0,
                z_index: index as i64,
                position_locked: false,
            })
            .unwrap();
        }
        let job = GenJob {
            id: "job-exact-parent".into(),
            media: "image".into(),
            provider: "bowerbird-cloud".into(),
            status: "running".into(),
            prompt: "继续生成".into(),
            applied_prompt: Some("继续生成".into()),
            reference_node_ids: vec![],
            references: vec![],
            session_id: None,
            conversation_id: Some("conversation-exact-parent".into()),
            thread_id: Some("thread-1".into()),
            creative_session_id: None,
            turn_key: Some("turn-exact-parent".into()),
            parent_node_id: Some("parent-exact".into()),
            parent_asset_path: Some("/parent.png".into()),
            creative_relation: Some(CreativeGenerationRelation::Continued),
            project_id: Some("project-1".into()),
            ratio: None,
            visual_profile: None,
            submit_id: None,
            video_options: None,
            turns: serde_json::json!([]),
            error: None,
            queue_idx: None,
            created_at: 1,
            started_at: Some(1),
            finished_at: None,
        };
        Task::upsert_gen_job(&db, &job).unwrap();
        let persisted = Task::by_id(&db, &job.id)
            .unwrap()
            .unwrap()
            .gen_job()
            .unwrap();
        assert_eq!(persisted.parent_node_id.as_deref(), Some("parent-exact"));

        assert!(recover_project_generation_projection(&db, &persisted, "running").unwrap());
        let snapshot = db.project_canvas_snapshot("project-1").unwrap();
        let prompt = snapshot
            .nodes
            .iter()
            .find(|node| node.kind == CreativeNodeKind::Prompt)
            .unwrap();
        assert!(snapshot
            .edges
            .iter()
            .any(|edge| { edge.from_node_id == "parent-exact" && edge.to_node_id == prompt.id }));
        assert!(!snapshot.edges.iter().any(|edge| {
            edge.from_node_id == "parent-duplicate" && edge.to_node_id == prompt.id
        }));
    }

    fn assert_terminal_task_status_wins_over_stale_payload(task_status: &str) {
        let db = crate::db::Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.create_project("project-1", "项目", "project-1", "project-1", "blank")
            .unwrap();
        db.ensure_project_canvas("project-1").unwrap();
        db.create_creative_thread(&crate::core::project_canvas::NewCreativeThread {
            id: "thread-1".into(),
            project_id: "project-1".into(),
            title: "生成线程".into(),
            origin: crate::core::creative_session_contract::CreativeThreadOrigin::Direct,
        })
        .unwrap();
        let job = GenJob {
            id: "job-1".into(),
            media: "image".into(),
            provider: "codex".into(),
            status: "running".into(),
            prompt: "生成一张海报".into(),
            applied_prompt: Some("完整生成指令".into()),
            reference_node_ids: vec![],
            references: vec![],
            session_id: None,
            conversation_id: Some("conversation-1".into()),
            thread_id: Some("thread-1".into()),
            creative_session_id: None,
            turn_key: Some("turn-1".into()),
            parent_node_id: None,
            parent_asset_path: None,
            creative_relation: None,
            project_id: Some("project-1".into()),
            ratio: Some("1:1".into()),
            visual_profile: None,
            submit_id: None,
            video_options: None,
            turns: serde_json::json!([]),
            error: None,
            queue_idx: None,
            created_at: 1,
            started_at: Some(1),
            finished_at: None,
        };
        Task::upsert_gen_job(&db, &job).unwrap();
        match task_status {
            "failed" => Task::mark_failed(&db, &job.id, "failed for test").unwrap(),
            "cancelled" => Task::mark_cancelled(&db, &job.id).unwrap(),
            other => panic!("unsupported terminal status {other}"),
        }
        let task = Task::by_id(&db, &job.id).unwrap().unwrap();
        let persisted_job = task.gen_job().unwrap();
        assert_eq!(persisted_job.status, "running");
        assert_eq!(task.status, task_status);

        assert!(recover_project_generation_projection(&db, &persisted_job, &task.status,).unwrap());
        let prompt = db
            .project_canvas_snapshot("project-1")
            .unwrap()
            .nodes
            .into_iter()
            .find(|node| {
                node.kind == crate::core::creative_session_contract::CreativeNodeKind::Prompt
            })
            .unwrap();
        let payload: serde_json::Value = serde_json::from_str(&prompt.payload_json).unwrap();
        assert_eq!(payload["status"], task_status);
    }

    #[test]
    fn startup_projection_recovery_uses_task_queue_terminal_status() {
        assert_terminal_task_status_wins_over_stale_payload("failed");
        assert_terminal_task_status_wins_over_stale_payload("cancelled");
    }
}
