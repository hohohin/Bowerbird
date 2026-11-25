use super::{apply_result, checked_plan, current_plan};
use crate::{
    cloud::{AuthClient, CloudClient},
    commands::video_analysis::jobs::transport::{self, Manifest, Service},
    core::paths::LibraryPaths,
    db::Database,
    error::{AppError, AppResult},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;
mod store;
fn err(msg: &str) -> AppError {
    AppError::Other(msg.into())
}
const EXPIRES: i64 = 120_000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    source_hash: String,
    plan_revision: i64,
    owner: String,
    shot_ids: Vec<String>,
    rerun: bool,
    pricing_version: i64,
    total_milli: i64,
    expires_at: i64,
}
#[derive(Serialize, Deserialize)]
struct Item {
    id: String,
    start: u64,
    end: u64,
    expected: Option<[String; 3]>,
    milli: i64,
    key: String,
    cache: bool,
    manifest: Option<Manifest>,
    job: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Queue {
    id: String,
    quote: Quote,
    items: Vec<Item>,
    cursor: usize,
    status: String,
    error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    status: String,
    remaining: Vec<String>,
    stopping: bool,
    error: Option<String>,
}

type Key = (PathBuf, String, String);
static ACTIVE: LazyLock<Mutex<HashSet<Key>>> = LazyLock::new(Default::default);
struct Activity(Key);
impl Drop for Activity {
    fn drop(&mut self) {
        ACTIVE.lock().unwrap().remove(&self.0);
    }
}
fn activity(root: &LibraryPaths, asset: &str, hash: &str) -> AppResult<Activity> {
    let k = (root.db.clone(), asset.to_owned(), hash.to_owned());
    if !ACTIVE.lock().unwrap().insert(k.clone()) {
        return Err(err("镜头任务正在运行"));
    }
    Ok(Activity(k))
}
fn progress(db: &Database, paths: &LibraryPaths, asset: &str, hash: &str) -> AppResult<Progress> {
    let Some((q, stop)) = store::load(db, asset, hash)? else {
        return Ok(Progress {
            status: "idle".into(),
            remaining: vec![],
            stopping: false,
            error: None,
        });
    };
    let running = ACTIVE
        .lock()
        .unwrap()
        .contains(&(paths.db.clone(), asset.into(), hash.into()));
    let status = if q.status == "running" && !running {
        "interrupted".into()
    } else {
        q.status
    };
    let remaining = if matches!(status.as_str(), "running" | "interrupted") {
        q.items[q.cursor..].iter().map(|s| s.id.clone()).collect()
    } else {
        vec![]
    };
    Ok(Progress {
        status,
        remaining,
        stopping: stop,
        error: q.error,
    })
}
#[tauri::command]
pub async fn video_shots_progress(
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    asset_id: String,
    source_hash: String,
) -> AppResult<Progress> {
    progress(&db, &paths, &asset_id, &source_hash)
}
#[tauri::command]
pub async fn video_shots_stop(
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    asset_id: String,
    source_hash: String,
) -> AppResult<Progress> {
    store::stop(&db, &asset_id, &source_hash)?;
    if let Ok(_guard) = activity(&paths, &asset_id, &source_hash) {
        if let Some((mut q, _)) = store::load(&db, &asset_id, &source_hash)? {
            if matches!(q.status.as_str(), "interrupted" | "running")
                && q.items.get(q.cursor).is_some_and(|i| i.manifest.is_none())
            {
                q.status = "stopped".into();
                q.error = None;
                store::save(&db, &asset_id, &q)?;
            }
        }
    }
    progress(&db, &paths, &asset_id, &source_hash)
}
async fn priced(
    db: &Database,
    svc: &Service<'_>,
    asset: &str,
    hash: &str,
    ids: &[String],
    rerun: bool,
) -> AppResult<(Quote, Vec<Item>)> {
    if ids.is_empty() || ids.len() > 2000 || (rerun && ids.len() != 1) {
        return Err(err("请选择需要分析的镜头"));
    }
    let (_, plan) = current_plan(db, asset, hash)?;
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    let mut billable = Vec::new();
    for id in ids {
        if !seen.insert(id) {
            return Err(err("镜头重复"));
        }
        let (a, b) = plan
            .interval(id)
            .ok_or_else(|| err("镜头已改变，请重新勾选"))?;
        if b - a > 60_000 {
            return Err(err("单镜超过 60 秒，请先添加切点"));
        }
        let expected = plan.results.get(id).cloned();
        if !rerun && expected.is_some() {
            continue;
        }
        if rerun && expected.is_none() {
            return Err(err("镜头尚无可重跑的结果"));
        }
        let cached = if rerun {
            None
        } else {
            store::cached(db, asset, hash, id)?
        };
        if cached.is_none() {
            billable.push(json!({"start_ms":a,"end_ms":b}));
        }
        items.push(Item {
            id: id.clone(),
            start: a as u64,
            end: b as u64,
            expected,
            milli: 0,
            cache: cached.is_some(),
            key: cached
                .map(|c| c.0)
                .unwrap_or_else(|| format!("library-shot:{}", Uuid::new_v4())),
            manifest: None,
            job: None,
        });
    }
    if items.is_empty() {
        return Err(err("所选镜头均已分析"));
    }
    let (mut version, mut total) = (0, 0);
    if !billable.is_empty() {
        let (status, body) = svc
            .request(json!({"action":"library-shot-quote","shots":billable}))
            .await?;
        if !status.is_success() || body["available"] != true {
            return Err(err("逐镜分析尚未开放，已保存的结果仍可查看"));
        }
        version = body["pricing_version"]
            .as_i64()
            .filter(|v| *v > 0)
            .ok_or_else(|| err("报价版本无效"))?;
        let mut rates = BTreeMap::new();
        for line in body["lines"]
            .as_array()
            .ok_or_else(|| err("报价缺少镜头"))?
        {
            rates.insert(
                (line["start_ms"].as_u64(), line["end_ms"].as_u64()),
                line["amount_milli"].as_i64().filter(|v| *v > 0),
            );
        }
        for item in items.iter_mut().filter(|i| !i.cache) {
            item.milli = rates
                .remove(&(Some(item.start), Some(item.end)))
                .flatten()
                .ok_or_else(|| err("镜头报价不符"))?;
            total = i64::checked_add(total, item.milli).ok_or_else(|| err("总额无效"))?;
        }
        if !rates.is_empty() || Some(total) != body["total_milli"].as_i64() {
            return Err(err("报价总额不符"));
        }
    }
    Ok((
        Quote {
            source_hash: hash.into(),
            plan_revision: plan.revision,
            owner: svc.owner.into(),
            shot_ids: items.iter().map(|i| i.id.clone()).collect(),
            rerun,
            pricing_version: version,
            total_milli: total,
            expires_at: chrono::Utc::now().timestamp_millis() + EXPIRES,
        },
        items,
    ))
}
fn owner(auth: &AuthClient) -> AppResult<String> {
    auth.snapshot().user_id.ok_or_else(|| err("请先登录账号"))
}
#[tauri::command]
pub async fn video_shots_quote(
    db: State<'_, Arc<Database>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    asset_id: String,
    source_hash: String,
    shot_ids: Vec<String>,
    rerun: bool,
) -> AppResult<Quote> {
    let user = owner(&auth)?;
    let svc = Service {
        cloud: &cloud,
        auth: &auth,
        owner: &user,
    };
    Ok(priced(&db, &svc, &asset_id, &source_hash, &shot_ids, rerun)
        .await?
        .0)
}
#[tauri::command]
pub async fn video_shots_start(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    asset_id: String,
    quote: Quote,
) -> AppResult<Progress> {
    let guard = activity(&paths, &asset_id, &quote.source_hash)?;
    let user = owner(&auth)?;
    if user != quote.owner || chrono::Utc::now().timestamp_millis() >= quote.expires_at {
        return Err(err("报价已过期或账号已切换，请重新确认"));
    }
    let svc = Service {
        cloud: &cloud,
        auth: &auth,
        owner: &user,
    };
    let (fresh, items) = priced(
        &db,
        &svc,
        &asset_id,
        &quote.source_hash,
        &quote.shot_ids,
        quote.rerun,
    )
    .await?;
    if fresh.plan_revision != quote.plan_revision
        || fresh.total_milli != quote.total_milli
        || fresh.pricing_version != quote.pricing_version
        || fresh.shot_ids != quote.shot_ids
    {
        return Err(err("镜头或报价已变化，请重新确认"));
    }
    let hash = quote.source_hash.clone();
    let q = Queue {
        id: Uuid::new_v4().to_string(),
        quote: fresh,
        items,
        cursor: 0,
        status: "running".into(),
        error: None,
    };
    auth.with_current_user(&user, || store::create(&db, &asset_id, &q))?;
    launch(
        app,
        db.inner().clone(),
        paths.inner().clone(),
        cloud.inner().clone(),
        auth.inner().clone(),
        asset_id.clone(),
        q,
        guard,
    );
    progress(&db, &paths, &asset_id, &hash)
}
#[tauri::command]
pub async fn video_shots_resume(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    asset_id: String,
    source_hash: String,
) -> AppResult<Progress> {
    let guard = activity(&paths, &asset_id, &source_hash)?;
    let (mut q, _) =
        store::load(&db, &asset_id, &source_hash)?.ok_or_else(|| err("没有待恢复任务"))?;
    if owner(&auth)? != q.quote.owner || !matches!(q.status.as_str(), "interrupted" | "running") {
        return Err(err("请使用原账号恢复进行中的镜头任务"));
    }
    q.status = "running".into();
    q.error = None;
    store::save(&db, &asset_id, &q)?;
    launch(
        app,
        db.inner().clone(),
        paths.inner().clone(),
        cloud.inner().clone(),
        auth.inner().clone(),
        asset_id.clone(),
        q,
        guard,
    );
    progress(&db, &paths, &asset_id, &source_hash)
}
fn launch(
    app: AppHandle,
    db: Arc<Database>,
    paths: Arc<LibraryPaths>,
    cloud: CloudClient,
    auth: AuthClient,
    asset: String,
    mut q: Queue,
    guard: Activity,
) {
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        let user = q.quote.owner.clone();
        let svc = Service {
            cloud: &cloud,
            auth: &auth,
            owner: &user,
        };
        if let Err(e) = run(&app, &db, &paths, &svc, &asset, &mut q).await {
            if q.status == "running" {
                q.status = "interrupted".into();
            }
            q.error = Some(e.to_string());
            let _ = store::save(&db, &asset, &q);
            if q.status == "failed" {
                let dir = paths.root.join("video-shots").join(&q.id);
                let _ = tokio::fs::remove_file(dir.join(format!("{}.mp4", q.cursor))).await;
                let _ = tokio::fs::remove_dir(dir).await;
            }
        }
        let _ = app.emit("library://assets-changed", ());
    });
}
async fn run(
    app: &AppHandle,
    db: &Arc<Database>,
    paths: &LibraryPaths,
    svc: &Service<'_>,
    asset: &str,
    q: &mut Queue,
) -> AppResult<()> {
    let name = asset.to_owned();
    let hash = q.quote.source_hash.clone();
    let local = db.clone();
    tokio::task::spawn_blocking(move || checked_plan(&local, &name, &hash))
        .await
        .map_err(|_| err("原件核验失败"))??;
    while q.cursor < q.items.len() {
        let i = q.cursor;
        if i > 0
            && q.items[i].manifest.is_none()
            && store::load(db, asset, &q.quote.source_hash)?.is_some_and(|r| r.1)
        {
            q.status = "stopped".into();
            break;
        }
        let (path, plan) = current_plan(db, asset, &q.quote.source_hash)?;
        let item = &q.items[i];
        let hash = &q.quote.source_hash;
        let scratch = paths
            .root
            .join("video-shots")
            .join(&q.id)
            .join(format!("{i}.mp4"));
        let (key, texts) = if item.cache {
            store::cached(db, asset, hash, &item.id)?.ok_or_else(|| err("已付费回执缺失"))?
        } else {
            let id = item.id.clone();
            let key = item.key.clone();
            // A receipt survives a crash between applying an edit and advancing the queue.
            if let Some(receipt) = store::cached(db, asset, hash, &id)?.filter(|r| r.0 == key) {
                receipt
            } else {
                if item.manifest.is_none() {
                    if plan.interval(&id).is_none()
                        || plan.results.get(&id) != item.expected.as_ref()
                    {
                        q.status = "failed".into();
                        return Err(err("镜头已改变，请重新选择"));
                    }
                    let manifest = transport::prepare_shot_proxy(
                        &path,
                        &scratch,
                        item.start,
                        item.end,
                        plan.duration_ms as u64,
                    )
                    .await?;
                    current_plan(db, asset, hash)?;
                    q.items[i].manifest = Some(manifest);
                    store::save(db, asset, q)?;
                }
                let reply = remote(db, svc, asset, q, &scratch).await;
                let _ = app.emit("cloud://shot-balance-changed", &q.quote.owner);
                let texts = reply?;
                store::remember(db, asset, &q.quote.source_hash, &id, &key, &texts)?;
                (key, texts)
            }
        };
        let item = &q.items[i];
        apply_result(
            db,
            asset,
            &q.quote.source_hash,
            &item.id,
            &key,
            texts,
            item.expected.as_ref(),
        )?;
        let _ = tokio::fs::remove_file(&scratch).await;
        q.cursor += 1;
        store::save(db, asset, q)?;
        let _ = app.emit("library://video-shots-updated", asset);
    }
    if q.status == "running" {
        q.status = "completed".into();
    }
    let _ = tokio::fs::remove_dir(paths.root.join("video-shots").join(&q.id)).await;
    store::save(db, asset, q)
}
async fn remote(
    db: &Database,
    svc: &Service<'_>,
    asset: &str,
    q: &mut Queue,
    scratch: &std::path::Path,
) -> AppResult<[String; 3]> {
    let i = q.cursor;
    let prepare = json!({"action":"library-shot-prepare","source_sha256":q.quote.source_hash,
        "idempotency_key":q.items[i].key,"expected_milli":q.items[i].milli,"pricing_version":q.quote.pricing_version,
        "video":q.items[i].manifest});
    let (status, mut value) = svc
        .request(json!({"action":"get-by-key","idempotency_key":q.items[i].key}))
        .await?;
    let missing = status == reqwest::StatusCode::NOT_FOUND
        && value.pointer("/error/code").and_then(Value::as_str) == Some("invalid_request")
        && q.items[i].job.is_none();
    if missing || status.is_success() && value["status"] == "uploading" {
        let (code, reply) = svc.request(prepare).await?;
        if !code.is_success() {
            let reason = reply.pointer("/error/code").and_then(Value::as_str);
            if missing
                && (matches!(
                    (code.as_u16(), reason),
                    (400, Some("invalid_request"))
                        | (402, Some("insufficient_credits"))
                        | (403, Some("forbidden"))
                        | (503, Some("not_configured"))
                ) || (code.as_u16() == 409
                    && reason == Some("invalid_request")
                    && reply.pointer("/error/message").and_then(Value::as_str)
                        == Some("镜头报价已变更，请重新确认")))
            {
                q.status = "failed".into();
            }
            return Err(err(reply
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("云端未确认镜头任务，请按原任务恢复")));
        }
        value = reply;
    } else if !status.is_success() {
        return Err(err("暂时无法查询原任务，请稍后恢复"));
    }
    let job = transport::parse_response(
        reqwest::StatusCode::OK,
        value.clone(),
        q.items[i].job.as_deref(),
    )?;
    q.items[i].job = Some(job.job_id.clone());
    store::save(db, asset, q)?;
    if job.status == "uploading" {
        if !tokio::fs::try_exists(scratch).await? {
            let (source, plan) = current_plan(db, asset, &q.quote.source_hash)?;
            transport::prepare_shot_proxy(
                &source,
                scratch,
                q.items[i].start,
                q.items[i].end,
                plan.duration_ms as u64,
            )
            .await?;
            current_plan(db, asset, &q.quote.source_hash)?;
        }
        let uploaded = svc
            .upload(
                &job,
                q.items[i]
                    .manifest
                    .as_ref()
                    .ok_or_else(|| err("缺少原任务清单"))?,
                scratch,
            )
            .await;
        let (status, reply) = svc
            .request(json!({"action":"library-shot-commit","job_id":job.job_id}))
            .await?;
        if !status.is_success() {
            uploaded?;
            return Err(err("云端未确认代理，按原任务恢复"));
        }
        value = reply;
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1800);
    loop {
        if value["job_id"] != job.job_id {
            return Err(err("云端返回的任务身份不符"));
        }
        match value["status"].as_str() {
            Some("succeeded") => {
                if value
                    .pointer("/charge/actual_milli")
                    .and_then(Value::as_i64)
                    != Some(q.items[i].milli)
                    || value
                        .pointer("/charge/pricing_version")
                        .and_then(Value::as_i64)
                        != Some(q.quote.pricing_version)
                {
                    return Err(err("镜头结算与已确认报价不符，请核对原任务"));
                }
                let result = &value["result"];
                let field = |key: &str| {
                    result[key]
                        .as_str()
                        .filter(|s| !s.trim().is_empty() && s.len() <= 80_000)
                        .map(str::to_owned)
                        .ok_or_else(|| err("分镜结果字段缺失，请按原任务恢复"))
                };
                return Ok([
                    field("description")?,
                    field("first_frame_prompt")?,
                    field("motion_prompt")?,
                ]);
            }
            Some("failed")
                if value.pointer("/charge/refunded").and_then(Value::as_bool) == Some(true) =>
            {
                q.status = "failed".into();
                return Err(err("此镜头任务失败，原预留已退回"));
            }
            Some("queued" | "running" | "leased") if tokio::time::Instant::now() < deadline => {}
            _ => return Err(err("镜头结果待核对，请按原任务查询")),
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
        let (status, reply) = svc
            .request(json!({"action":"library-shot-get","job_id":job.job_id}))
            .await?;
        if !status.is_success() {
            return Err(err("暂时无法查询原任务"));
        }
        value = reply;
    }
}

#[cfg(test)]
mod tests;
