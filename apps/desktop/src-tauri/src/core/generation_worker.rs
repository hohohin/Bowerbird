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

use crate::codex::jimeng::{poll_query_and_download, resolve_dreamina_binary};
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
    prompt_raw: Option<String>,
    references: Vec<String>,
    session_id: Option<String>,
    submit_id: Option<String>,
    provider: String,
    project_id: Option<String>,
) -> AppResult<Vec<Asset>> {
    let source_tag = provider_source_tag(&provider).to_string();

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
        if let Some(pid) = project_id.as_deref() {
            let ids: Vec<String> = out.iter().map(|a| a.id.clone()).collect();
            if let Err(e) = db_b.add_assets_to_project(pid, &ids) {
                tracing::warn!("failed to link generated assets to project {pid}: {e}");
            }
        }

        // generation_meta（详情页「✨ 生成来源」卡片；payload 增 submit_id 供事后取回）。
        // prompt = 铺开发 provider 用；prompt_raw = 未铺开的原始编辑框文本，复用时载入还原 chip。
        let meta_payload = serde_json::json!({
            "prompt": prompt,
            "prompt_raw": prompt_raw,
            "session_id": session_id,
            "references": references,
            "provider": provider,
            "submit_id": submit_id,
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

    // 后台自动命名（每张生成图各跑一次 codex 看图取名，替代 codex 默认 ig_<hash>）。
    for a in gen_assets.clone() {
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
        let auth = app.state::<crate::cloud::AuthClient>().inner().clone();
        let entitlement = app.state::<crate::cloud::EntitlementService>();
        let entitlement_snapshot = entitlement.current_or_sync(&auth).await;
        let running = match Task::list_running(&db) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("启动恢复：list_running 失败: {e}");
                return;
            }
        };
        tracing::info!("启动恢复：list_running 扫到 {} 条未完成 job", running.len());
        for task in running {
            let Some(job) = task.gen_job() else { continue };
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
                let _ = app.emit(
                    "codex://chunk",
                    serde_json::json!({ "kind": "error", "job_id": job.id, "message": message }),
                );
                continue;
            }
            if !matches!(
                job.provider.as_str(),
                "jimeng" | "dreamina" | "bowerbird-cloud"
            ) {
                let _ = Task::mark_failed(&db, &job.id, "app 重启中断，codex 会话不可恢复");
                let _ = app.emit(
                    "codex://chunk",
                    serde_json::json!({ "kind": "error", "job_id": job.id, "message": "app 重启中断，codex 会话不可恢复" }),
                );
                continue;
            }
            let Some(submit_id) = job.submit_id.clone() else {
                let _ = Task::mark_failed(&db, &job.id, "重启前未拿到 submit_id，无法续查");
                let _ = app.emit(
                    "codex://chunk",
                    serde_json::json!({ "kind": "error", "job_id": job.id, "message": "未拿到 submit_id，无法续查" }),
                );
                continue;
            };
            if job.provider == "bowerbird-cloud" {
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
async fn recover_one_cloud_job(
    app: AppHandle,
    db: Arc<Database>,
    paths: Arc<LibraryPaths>,
    mut job: GenJob,
    submit_id: String,
) {
    let _ = app.emit(
        "codex://chunk",
        serde_json::json!({ "kind": "recover_started", "job_id": job.id, "prompt": job.prompt, "provider": job.provider }),
    );
    job.status = "querying".into();
    let _ = Task::upsert_gen_job(&db, &job);
    let cloud = app.state::<crate::cloud::CloudClient>().inner().clone();
    let auth = app.state::<crate::cloud::AuthClient>().inner().clone();
    match crate::codex::bowerbird_cloud::recover_cloud_generation(&cloud, &auth, &submit_id).await {
        Ok((src_images, temp_dir)) => {
            match finalize_generation_assets(
                app.clone(),
                db.clone(),
                paths,
                src_images,
                Some(temp_dir),
                job.prompt.clone(),
                None,
                job.references.clone(),
                Some(submit_id.clone()),
                Some(submit_id.clone()),
                "bowerbird-cloud".to_string(),
                job.project_id.clone(),
            )
            .await
            {
                Ok(assets) => {
                    let asset_paths: Vec<PathBuf> = assets
                        .iter()
                        .filter_map(|asset| asset.store_path.clone().map(PathBuf::from))
                        .collect();
                    let _ = Task::mark_done(&db, &job.id);
                    let _ = app.emit(
                        "codex://chunk",
                        serde_json::json!({ "kind": "done", "job_id": job.id, "images": asset_paths, "provider": "bowerbird-cloud", "session_id": submit_id, "text": "", "elapsed_ms": 0 }),
                    );
                    let _ = app.emit("library://assets-changed", ());
                }
                Err(error) => {
                    let message = error.to_string();
                    let _ = Task::mark_failed(&db, &job.id, &message);
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
async fn recover_one_jimeng_job(
    app: AppHandle,
    db: Arc<Database>,
    paths: Arc<LibraryPaths>,
    mut job: GenJob,
    submit_id: String,
) {
    // ① recover_started 自包含事件：前端据此 upsert 占位 job，防 done 早于 loadGenJobs 丢事件。
    let _ = app.emit(
        "codex://chunk",
        serde_json::json!({ "kind": "recover_started", "job_id": job.id, "prompt": job.prompt, "provider": job.provider }),
    );
    // ② 拿 permit（FIFO 公平，与正常即梦生成串行）。
    let _permit = match JIMENG_FLY.acquire().await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("恢复 job {} 获取即梦令牌失败: {e}", job.id);
            return;
        }
    };
    // ③ status=querying 落库（前端 loadGenJobs 拉到时显示「续查中」）。
    job.status = "querying".into();
    let _ = Task::upsert_gen_job(&db, &job);

    // ④ 轮询续查下载（策略 B：bounded poll loop，向下兼容 query_result 阻塞等待）。
    let binary = resolve_dreamina_binary().unwrap_or_else(|| "dreamina".to_string());
    match poll_query_and_download(&binary, &submit_id, 30, Duration::from_secs(10)).await {
        Ok(src_images) => {
            tracing::info!("恢复续查成功：job={} 图={} 张", job.id, src_images.len());
            let temp_dir = src_images
                .first()
                .and_then(|p| p.parent().map(|x| x.to_path_buf()));
            match finalize_generation_assets(
                app.clone(),
                db.clone(),
                paths.clone(),
                src_images,
                temp_dir,
                job.prompt.clone(),
                None,
                job.references.clone(),
                Some(submit_id.clone()),
                Some(submit_id.clone()),
                "jimeng".to_string(),
                job.project_id.clone(),
            )
            .await
            {
                Ok(assets) => {
                    let asset_paths: Vec<PathBuf> = assets
                        .iter()
                        .filter_map(|a| a.store_path.clone().map(PathBuf::from))
                        .collect();
                    let _ = Task::mark_done(&db, &job.id);
                    let _ = app.emit(
                        "codex://chunk",
                        serde_json::json!({ "kind": "done", "job_id": job.id, "images": asset_paths, "provider": "jimeng", "session_id": submit_id, "text": "", "elapsed_ms": 0 }),
                    );
                    let _ = app.emit("library://assets-changed", ());
                }
                Err(e) => {
                    let msg = e.to_string();
                    let _ = Task::mark_failed(&db, &job.id, &msg);
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
            if msg.contains("排队") || msg.contains("querying") || msg.contains("未下载到图片")
            {
                let _ = app.emit(
                    "codex://chunk",
                    serde_json::json!({ "kind": "recover_polling", "job_id": job.id, "message": msg }),
                );
            } else {
                let _ = Task::mark_failed(&db, &job.id, &msg);
                let _ = app.emit(
                    "codex://chunk",
                    serde_json::json!({ "kind": "error", "job_id": job.id, "message": msg }),
                );
            }
        }
    }
}

/// 把生成会话的 prompt 链转成 caption 正文：从中识别 `【维度】：正文` 片段（创作板序列化时由
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_provider_keeps_own_source_tag() {
        assert_eq!(provider_source_tag("bowerbird-cloud"), "bowerbird-cloud");
        assert_eq!(provider_source_tag("jimeng"), "jimeng");
        assert_eq!(provider_source_tag("codex"), "codex");
    }
}
