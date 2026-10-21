//! Local replication history; model work belongs to the existing Cloud understand queue.
mod douyin;
use crate::{
    cloud::{AuthClient, CloudClient},
    core::paths::LibraryPaths,
    db::Database,
    error::{AppError, AppResult},
};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
};
use tauri::{Emitter, Manager, State};

static LOCK: Mutex<()> = Mutex::new(());
static ACTIVE: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
fn error(text: &str) -> AppError {
    AppError::Other(text.into())
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn field<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn bounded(v: &Value, key: &str, max: usize) -> AppResult<()> {
    let text = field(v, key);
    if text.trim().is_empty() || text.chars().count() > max {
        return Err(error(&format!("{key} 需为 1–{max} 字")));
    }
    Ok(())
}
fn rewrite_input(task: &Value) -> AppResult<String> {
    let direction = field(task, "rewriteDirection").trim();
    let text = if direction.is_empty() { field(task, "inputText").to_owned() }
        else { format!("【参考文本】\n{}\n\n【改写方向】\n{direction}", field(task, "inputText")) };
    if text.chars().count() > 50000 { return Err(error("参考文本与改写方向合计不能超过 50000 字")); }
    Ok(text)
}
fn frame_reference(data: &Value) -> AppResult<Value> {
    let value = &data["frameReference"];
    if value.is_null() { return Ok(Value::Null); }
    bounded(value, "assetId", 100)?;
    bounded(value, "name", 300)?;
    if !value["time"].as_f64().is_some_and(|time| time.is_finite() && (0.0..=120.0).contains(&time)) {
        return Err(error("截帧时间无效"));
    }
    Ok(json!({"assetId":value["assetId"],"name":value["name"],"time":value["time"]}))
}
fn folder(root: &Path, id: &str) -> AppResult<PathBuf> {
    if id.len() != 32
        || !id
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return Err(error("无效的复刻记录编号"));
    }
    Ok(root.join(id))
}
fn read(root: &Path, id: &str) -> AppResult<Value> {
    Ok(serde_json::from_slice(&fs::read(
        folder(root, id)?.join("record.json"),
    )?)?)
}
fn save(root: &Path, value: &Value) -> AppResult<()> {
    let dir = folder(root, field(value, "id"))?;
    fs::create_dir_all(&dir)?;
    let temporary = dir.join("record.tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(value)?)?;
    fs::OpenOptions::new()
        .write(true)
        .open(&temporary)?
        .sync_all()?;
    fs::rename(temporary, dir.join("record.json"))?;
    Ok(())
}
fn patch(root: &Path, id: &str, changes: Value) -> AppResult<Value> {
    let _lock = LOCK.lock().unwrap();
    let mut value = read(root, id)?;
    for (key, item) in changes.as_object().ok_or_else(|| error("更新格式错误"))? {
        value[key] = item.clone();
    }
    value["updatedAt"] = json!(now());
    save(root, &value)?;
    Ok(value)
}
fn own(root: &Path, id: &str, project: &str) -> AppResult<Value> {
    let value = read(root, id)?;
    if field(&value, "projectId") != project {
        return Err(error("记录不属于当前项目"));
    }
    Ok(value)
}
fn public(mut value: Value) -> Value {
    if ["queued", "analyzing", "rewriting"].contains(&field(&value, "state"))
        && !ACTIVE.lock().unwrap().contains(field(&value, "id"))
    {
        value["state"] = json!("interrupted");
        value["message"] = json!("任务已中断；恢复仅查询原 Cloud 任务");
    }
    if let Some(object) = value.as_object_mut() {
        object.remove("path");
        object.remove("hash");
    }
    value
}
fn generation_view(db: &Database, mut task: Value) -> AppResult<Value> {
    if field(&task, "operation") != "generate" {
        return Ok(task);
    }
    let job_id = field(&task, "generationJobId").to_owned();
    if let Some(job) = crate::core::task_queue::Task::by_id(db, &job_id)? {
        let payload: Value = serde_json::from_str(&job.payload)?;
        if field(&payload, "project_id") != field(&task, "projectId") {
            return Err(error("生成任务项目不匹配"));
        }
        task["remoteTaskId"] = payload["submit_id"].clone();
        task["message"] = json!(if job.status == "done" {
            "生成完成"
        } else {
            "生成进度见画板会话"
        });
        if ["failed", "cancelled"].contains(&job.status.as_str()) {
            task["state"] = json!("failed");
            task["error"] = json!(job
                .error
                .unwrap_or_else(|| "生成未完成，可回到会话查询原任务".into()));
        }
    } else {
        task["state"] = json!("interrupted");
        task["message"] = json!("尚未确认生成提交，请在画板会话中检查，不会自动重复生成");
    }
    let ids = {
        let conn = db.conn.lock().unwrap();
        let mut statement=conn.prepare("SELECT DISTINCT asset_id FROM analyses WHERE kind='generation_meta' AND json_extract(payload,'$.job_id')=?1 AND json_extract(payload,'$.turn_key')=?2")?;
        let rows = statement
            .query_map(
                rusqlite::params![job_id, field(&task, "generationTurnKey")],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    if let Some(id) = ids.first() {
        if let Some(asset) = db.get_asset(id)? {
            task["outputAssetId"] = json!(id);
            task["outputPath"] = json!(asset.store_path);
            if field(&task, "state") != "imported" {
                task["state"] = json!("completed");
            }
        }
    }
    Ok(task)
}
fn hash(path: &Path) -> AppResult<String> {
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn verified_reference(root: &Path, id: &str, project: &str) -> AppResult<(Value, PathBuf)> {
    let value = own(root, id, project)?;
    if field(&value, "kind") != "reference" {
        return Err(error("记录不是参考视频"));
    }
    let path = PathBuf::from(field(&value, "path"));
    if !path.is_file() || hash(&path)? != field(&value, "hash") {
        return Err(error(
            "参考视频已缺失或内容改变，历史文本仍保留，请重新选择视频",
        ));
    }
    Ok((value, path))
}
fn import_reference(
    root: &Path,
    project: &str,
    source: PathBuf,
    asset_id: Option<String>,
) -> AppResult<Value> {
    if !source.is_file() || fs::metadata(&source)?.len() > 200 * 1024 * 1024 {
        return Err(error("参考视频最大 200 MiB"));
    }
    let meta = crate::media::probe::probe(&source)?;
    if !crate::media::probe::is_video(&meta.ext)
        || meta.width == 0
        || meta.height == 0
        || !meta.duration.is_finite()
        || meta.duration <= 0.0
        || meta.duration > 120.0
    {
        return Err(error("请选择包含有效视频轨、时长不超过 120 秒的视频"));
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let dir = folder(root, &id)?;
    fs::create_dir_all(&dir)?;
    let destination = dir.join(format!("source.{}", meta.ext));
    let before = hash(&source)?;
    fs::copy(&source, &destination)?;
    if hash(&destination)? != before || hash(&source)? != before {
        return Err(error("复制期间视频内容改变，请重新选择"));
    }
    let value = json!({"id":id,"kind":"reference","projectId":project,"name":source.file_name().unwrap_or_default().to_string_lossy(),"duration":meta.duration,"sourceAssetId":asset_id,"path":destination,"hash":before,"createdAt":now()});
    save(root, &value)?;
    Ok(public(value))
}
async fn cloud_request(cloud: &CloudClient, auth: &AuthClient, body: Value) -> AppResult<Value> {
    let url = cloud
        .config()
        .endpoint("understand-proxy")
        .ok_or_else(|| error("当前构建未配置 Bowerbird Cloud"))?;
    let response = auth
        .send_authorized(
            cloud.http().post(url).json(&body),
            "视频复刻 Cloud 请求失败",
        )
        .await?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|_| error("Cloud 返回格式无效"))?;
    if !status.is_success() {
        return Err(error(
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Cloud 请求失败"),
        ));
    }
    Ok(value)
}
async fn proxy_video(root: &Path, task: &Value) -> AppResult<Value> {
    let root = root.to_path_buf();
    let task = task.clone();
    let (source, target, duration, fingerprint) =
        tokio::task::spawn_blocking(move || -> AppResult<_> {
            let (reference, source) = verified_reference(
                &root,
                field(&task, "referenceId"),
                field(&task, "projectId"),
            )?;
            Ok((
                source,
                folder(&root, field(&task, "id"))?.join("analysis-input.mp4"),
                reference["duration"].clone(),
                field(&reference, "hash").to_owned(),
            ))
        })
        .await
        .map_err(|_| error("读取参考视频失败"))??;
    let binary = crate::media::tools::resolve(crate::media::tools::Tool::Ffmpeg)?;
    let mut command = tokio::process::Command::new(binary);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
        .kill_on_drop(true)
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"])
        .arg(&source)
        .args([
            "-map",
            "0:v:0",
            "-an",
            "-vf",
            "scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=10",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "25",
            "-movflags",
            "+faststart",
        ])
        .arg(&target);
    let result = tokio::time::timeout(std::time::Duration::from_secs(300), command.output())
        .await
        .map_err(|_| error("分析代理转码超时"))??;
    if !result.status.success() {
        return Err(error("分析代理转码失败，请检查视频与 FFmpeg"));
    }
    tokio::task::spawn_blocking(move || {
        if hash(&source)? != fingerprint { return Err(error("转码期间参考视频改变")); }
        if fs::metadata(&target)?.len() > 35 * 1024 * 1024 { return Err(error("分析代理超过 35 MiB")); }
        Ok(json!({"mime":"video/mp4","base64":base64::engine::general_purpose::STANDARD.encode(fs::read(target)?),"duration":duration}))
    }).await.map_err(|_| error("读取分析代理失败"))?
}
async fn execute(root: PathBuf, id: String, cloud: CloudClient, auth: AuthClient) {
    let result = async {
        let mut task = read(&root, &id)?;
        let analyze = field(&task, "operation") == "analyze";
        let mut response = if !field(&task, "remoteTaskId").is_empty() {
            cloud_request(&cloud, &auth, json!({"action":"get","job_id":task["remoteTaskId"]})).await?
        } else {
            if task["submissionPending"] == true { return Err(error("提交结果尚未确认，请恢复原 Cloud 任务，不能重复提交")); }
            let mut request = json!({"action":"create","idempotency_key":format!("replication:{id}"),"operation":if analyze {"video-analysis"} else {"text-rewrite"},"image":null});
            if analyze {
                patch(&root, &id, json!({"message":"正在制作无音轨分析代理"}))?;
                request["video"] = proxy_video(&root, &task).await?;
            } else { request["rewrite"] = json!({"inputText":rewrite_input(&task)?,"persona":task["persona"],"rules":task["rules"],"product":task["product"]}); }
            // Save the uncertain window before any possibly billable create.
            patch(&root, &id, json!({"submissionPending":true,"message":"正在提交 Bowerbird Cloud"}))?;
            cloud_request(&cloud, &auth, request).await?
        };
        if let Some(remote) = response["job_id"].as_str() {
            task = patch(&root, &id, json!({"remoteTaskId":remote,"submissionPending":false}))?;
        }
        for _ in 0..360 {
            match field(&response, "status") {
                "succeeded" => {
                    let text = field(&response, "text");
                    if text.trim().is_empty() { return Err(error("Cloud 未返回结果或结果已过期")); }
                    patch(&root, &id, if analyze { json!({"state":"analyzed","analysis":text,"message":"分析完成","error":"","charge":response["charge"]}) }
                        else { json!({"state":"rewritten","rewriteOriginalText":text,"rewrittenText":text,"message":"改写完成","error":"","charge":response["charge"]}) })?;
                    return Ok::<_, AppError>(());
                }
                "uploading" | "queued" | "leased" | "running" | "cancel_requested" => (),
                _ => return Err(error(response.pointer("/error/message").and_then(Value::as_str).unwrap_or("Cloud 任务未完成；可查询原任务"))),
            }
            patch(&root, &id, json!({"message":"Cloud 正在处理，可关闭面板，结果会保存"}))?;
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            response = cloud_request(&cloud, &auth, json!({"action":"get","job_id":task["remoteTaskId"]})).await?;
        }
        Err(error("本次等待已结束，可稍后恢复原任务"))
    }.await;
    if let Err(e) = result {
        let _ = patch(
            &root,
            &id,
            json!({"state":"failed","error":e.to_string(),"message":"未完成"}),
        );
    }
    ACTIVE.lock().unwrap().remove(&id);
}
fn start(root: PathBuf, id: String, app: &tauri::AppHandle) -> AppResult<Value> {
    if !ACTIVE.lock().unwrap().insert(id.clone()) {
        return Ok(public(read(&root, &id)?));
    }
    let value = match patch(&root, &id, json!({"state":"queued","error":""})) {
        Ok(value) => value,
        Err(e) => {
            ACTIVE.lock().unwrap().remove(&id);
            return Err(e);
        }
    };
    let cloud = app.state::<CloudClient>().inner().clone();
    let auth = app.state::<AuthClient>().inner().clone();
    tauri::async_runtime::spawn(execute(root, id, cloud, auth));
    Ok(public(value))
}

#[tauri::command]
pub async fn video_replication(
    app: tauri::AppHandle,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    project_id: String,
    action: String,
    data: Value,
) -> AppResult<Value> {
    let root = paths.root.join("video-replication");
    fs::create_dir_all(&root)?;
    // Opening the tool does not materialize an empty project; writes do.
    if ![
        "list",
        "capabilities",
        "preferences",
        "save-preferences",
        "sources",
        "douyin-list",
    ]
    .contains(&action.as_str())
    {
        let conn = db.conn.lock().unwrap();
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
            [&project_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(error("项目不存在"));
        }
    }
    if action.starts_with("douyin-") {
        return douyin::handle(&app, &root, &project_id, &action, data).await;
    }
    match action.as_str() {
        "capabilities" => {
            cloud_request(
                app.state::<CloudClient>().inner(),
                app.state::<AuthClient>().inner(),
                json!({"action":"replication-capabilities"}),
            )
            .await
        }
        "list" => {
            let mut records = Vec::new();
            for entry in fs::read_dir(&root)? {
                let entry = entry?;
                if let Some(id) = entry.file_name().to_str() {
                    if let Ok(value) = own(&root, id, &project_id) {
                        if value["kind"] != "reference" && value["kind"] != "douyin" {
                            records.push(public(generation_view(&db, value)?));
                        }
                    }
                }
            }
            records.sort_by(|a, b| field(b, "createdAt").cmp(field(a, "createdAt")));
            Ok(json!(records))
        }
        "sources" => {
            let query = format!("%{}%", field(&data, "query"));
            let offset = data["offset"].as_u64().unwrap_or(0).min(1_000_000);
            let ids = {
                let conn = db.conn.lock().unwrap();
                let mut statement=conn.prepare("SELECT id FROM assets WHERE lower(ext) IN ('mp4','mov','m4v','webm','mkv','avi') AND library_hidden=0 AND name LIKE ?1 ORDER BY created_at DESC,id LIMIT 40 OFFSET ?2")?;
                let rows = statement
                    .query_map(rusqlite::params![query, offset], |row| {
                        row.get::<_, String>(0)
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            let mut values = Vec::new();
            for id in ids {
                if let Some(asset) = db.get_asset(&id)? {
                    values.push(asset);
                }
            }
            Ok(json!(values))
        }
        "reference" => {
            let asset_id = data["assetId"].as_str().map(str::to_owned);
            let source = if let Some(id) = &asset_id {
                db.get_asset(id)?
                    .and_then(|asset| asset.store_path)
                    .ok_or_else(|| error("素材不存在"))?
            } else {
                bounded(&data, "path", 32768)?;
                field(&data, "path").to_owned()
            };
            tokio::task::spawn_blocking(move || {
                import_reference(&root, &project_id, PathBuf::from(source), asset_id)
            })
            .await
            .map_err(|_| error("导入参考视频失败"))?
        }
        "media" => {
            let id = field(&data, "id").to_owned();
            tokio::task::spawn_blocking(move || {
                verified_reference(&root, &id, &project_id).map(|(_, path)| json!(path))
            })
            .await
            .map_err(|_| error("校验参考视频失败"))?
        }
        "preferences" => {
            let path = root.join("preferences.json");
            if path.is_file() {
                Ok(serde_json::from_slice(&fs::read(path)?)?)
            } else {
                Ok(json!({"products":[]}))
            }
        }
        "save-preferences" => {
            bounded(&data, "persona", 8000)?;
            bounded(&data, "rules", 16000)?;
            let products = data["products"]
                .as_array()
                .ok_or_else(|| error("产品资料格式无效"))?;
            if products.len() > 200 {
                return Err(error("最多保存 200 项产品资料"));
            }
            for p in products {
                bounded(p, "id", 100)?;
                bounded(p, "name", 100)?;
                bounded(p, "description", 8000)?;
            }
            let _guard = LOCK.lock().unwrap();
            fs::write(root.join("preferences.tmp"), serde_json::to_vec(&data)?)?;
            fs::rename(root.join("preferences.tmp"), root.join("preferences.json"))?;
            Ok(data)
        }
        "create" => {
            bounded(&data, "title", 100)?;
            let operation = field(&data, "operation");
            if !["analyze", "rewrite", "generate"].contains(&operation) {
                return Err(error("未知操作"));
            }
            let mut task = json!({});
            for key in [
                "operation",
                "title",
                "referenceId",
                "sourceAnalysisId",
                "sourceRewriteId",
                "inputText",
                "rewriteDirection",
                "persona",
                "rules",
                "product",
                "prompt",
                "duration",
                "ratio",
                "tags",
                "scenes",
                "sellingPoints",
                "provider",
            ] {
                if let Some(value) = data.get(key) {
                    task[key] = value.clone();
                }
            }
            if !data["product"].is_null() {
                bounded(&data["product"], "id", 100)?;
                bounded(&data["product"], "name", 100)?;
                bounded(&data["product"], "description", 8000)?;
                task["product"] = json!({"id":data["product"]["id"],"name":data["product"]["name"],"description":data["product"]["description"]});
            }
            for (key, max) in [("tags", 50), ("scenes", 30), ("sellingPoints", 30)] {
                if let Some(values) = data[key].as_array() {
                    if values.len() > max {
                        return Err(error("标签数量超限"));
                    }
                    let mut cleaned = Vec::new();
                    for value in values {
                        let text = value
                            .as_str()
                            .ok_or_else(|| error("标签必须为文字"))?
                            .trim();
                        if text.chars().count() > 200 {
                            return Err(error("标签最多 200 字"));
                        }
                        if !text.is_empty() {
                            cleaned.push(text);
                        }
                    }
                    task[key] = json!(cleaned);
                }
            }
            if operation == "analyze" {
                let (reference, _) =
                    verified_reference(&root, field(&data, "referenceId"), &project_id)?;
                task["reference"] = public(reference);
            }
            if operation == "rewrite" {
                bounded(&data, "inputText", 50000)?;
                bounded(&data, "persona", 8000)?;
                bounded(&data, "rules", 16000)?;
                rewrite_input(&data)?;
                task["frameReference"] = frame_reference(&data)?;
            }
            for key in ["sourceAnalysisId", "sourceRewriteId"] {
                if let Some(id) = data[key].as_str() {
                    let source = own(&root, id, &project_id)?;
                    if key == "sourceAnalysisId" && field(&source, "analysis").is_empty()
                        || key == "sourceRewriteId"
                            && field(&source, "rewriteOriginalText").is_empty()
                    {
                        return Err(error("来源记录尚未完成"));
                    }
                }
            }
            if operation == "generate" {
                bounded(&data, "prompt", 12000)?;
                bounded(&data["product"], "name", 100)?;
                if !matches!(data["duration"].as_u64(), Some(4..=12))
                    || !["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]
                        .contains(&field(&data, "ratio"))
                {
                    return Err(error("视频参数无效"));
                }
            }
            let id = uuid::Uuid::new_v4().simple().to_string();
            for (key,value) in json!({"id":id,"projectId":project_id,"state":"queued","createdAt":now(),"updatedAt":now(),"message":"","error":"","analysis":"","rewriteOriginalText":"","rewrittenText":"","remoteTaskId":null,"submissionPending":false,"outputAssetId":null,"model":"Bowerbird Cloud","apiBase":"Bowerbird Cloud"}).as_object().unwrap() { task[key]=value.clone(); }
            if operation == "generate" {
                task["state"] = json!("generating");
                task["generationJobId"] = json!(format!("replication-{id}"));
                task["generationTurnKey"] = json!(uuid::Uuid::new_v4().simple().to_string());
            }
            save(&root, &task)?;
            if operation == "generate" {
                Ok(task)
            } else {
                start(root, id, &app)
            }
        }
        "save-result" => {
            let id = field(&data, "id");
            let task = own(&root, id, &project_id)?;
            if field(&task, "state") != "rewritten" {
                return Err(error("只能编辑已完成的改写结果"));
            }
            bounded(&data, "text", 50000)?;
            let mut changes = json!({"rewrittenText":data["text"]});
            if let Some(prompt) = data.get("firstFramePrompt") {
                if !prompt.is_string() || prompt.as_str().unwrap().chars().count() > 12000 {
                    return Err(error("首帧提示词不能超过 12000 字"));
                }
                changes["firstFramePrompt"] = prompt.clone();
            }
            if data.get("frameReference").is_some() { changes["frameReference"] = frame_reference(&data)?; }
            patch(&root, id, changes)
        }
        "export" => {
            let task = generation_view(&db, own(&root, field(&data, "id"), &project_id)?)?;
            let source = field(&task, "outputPath");
            if source.is_empty() {
                return Err(error("视频尚未生成"));
            }
            bounded(&data, "path", 32768)?;
            let target = PathBuf::from(field(&data, "path"));
            if target == PathBuf::from(source) {
                return Ok(json!(true));
            }
            fs::copy(source, target)?;
            Ok(json!(true))
        }
        "import" => {
            let id = field(&data, "id");
            let task = generation_view(&db, own(&root, id, &project_id)?)?;
            let asset = field(&task, "outputAssetId");
            if asset.is_empty() {
                return Err(error("视频尚未生成"));
            }
            let _lock = LOCK.lock().unwrap();
            let mut tags = vec!["#ai生成".to_string()];
            for key in ["tags", "scenes", "sellingPoints"] {
                if let Some(values) = task[key].as_array() {
                    for value in values {
                        if let Some(text) = value
                            .as_str()
                            .map(str::trim)
                            .filter(|text| !text.is_empty())
                        {
                            if text.chars().count() > 200 {
                                return Err(error("标签过长"));
                            }
                            tags.push(text.to_owned());
                        }
                    }
                }
            }
            if tags.len() > 111 {
                return Err(error("标签过多"));
            }
            {
                let conn = db.conn.lock().unwrap();
                let tx = conn.unchecked_transaction()?;
                for name in tags {
                    let tid = format!("replication-{:x}", Sha256::digest(name.as_bytes()));
                    tx.execute(
                        "INSERT OR IGNORE INTO tags(id,name,source) VALUES(?1,?2,'replication')",
                        rusqlite::params![tid, name],
                    )?;
                    tx.execute("INSERT OR IGNORE INTO asset_tags(asset_id,tag_id) SELECT ?1,id FROM tags WHERE name=?2",rusqlite::params![asset,name])?;
                }
                tx.execute("INSERT OR IGNORE INTO analyses(id,asset_id,kind,payload) VALUES(?1,?2,'replication_source',?3)",rusqlite::params![format!("replication-{id}"),asset,serde_json::to_string(&task)?])?;
                tx.commit()?;
            }
            let mut saved = own(&root, id, &project_id)?;
            saved["state"] = json!("imported");
            saved["outputAssetId"] = json!(asset);
            save(&root, &saved)?;
            let _ = app.emit("library://assets-changed", ());
            Ok(public(generation_view(&db, saved)?))
        }
        "resume" => {
            let id = field(&data, "id").to_owned();
            let task = own(&root, &id, &project_id)?;
            if field(&task, "operation") == "generate" {
                return Err(error("请在原生成会话中恢复视频任务"));
            }
            if !["failed", "interrupted", "queued"].contains(&field(&public(task.clone()), "state"))
            {
                return Err(error("该记录无需恢复，请新建版本"));
            }
            if task["submissionPending"] == true && field(&task, "remoteTaskId").is_empty() {
                // Resolve by the original key under authenticated ownership, never repeat create.
                let response = cloud_request(
                    app.state::<CloudClient>().inner(),
                    app.state::<AuthClient>().inner(),
                    json!({"action":"get-by-key","idempotency_key":format!("replication:{id}")}),
                )
                .await?;
                let remote = field(&response, "job_id");
                if remote.is_empty() {
                    return Err(error("尚未查到原 Cloud 任务，请稍后重查，不会重复提交"));
                }
                patch(
                    &root,
                    &id,
                    json!({"remoteTaskId":remote,"submissionPending":false}),
                )?;
            }
            start(root, id, &app)
        }
        _ => Err(error("未知视频复刻操作")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rewrite_direction_and_frame_reference_contract() {
        assert_eq!(rewrite_input(&json!({"inputText":"原文","rewriteDirection":" 改成夜景 "})).unwrap(), "【参考文本】\n原文\n\n【改写方向】\n改成夜景");
        assert_eq!(rewrite_input(&json!({"inputText":"旧记录"})).unwrap(), "旧记录");
        assert!(rewrite_input(&json!({"inputText":"a".repeat(49999),"rewriteDirection":"夜景"})).is_err());
        assert!(frame_reference(&json!({"frameReference":{"assetId":"a","name":"视频","time":3.2}})).is_ok());
        assert!(frame_reference(&json!({"frameReference":{"assetId":"a","name":"视频","time":-1}})).is_err());
    }
    #[test]
    fn history_is_atomic_project_scoped_and_preserves_original() {
        let root = std::env::temp_dir().join(format!("bb-replication-{}", uuid::Uuid::new_v4()));
        let id = uuid::Uuid::new_v4().simple().to_string();
        save(&root,&json!({"id":id,"projectId":"p","state":"rewritten","rewriteOriginalText":"原文","rewrittenText":"原文"})).unwrap();
        patch(&root, &id, json!({"rewrittenText":"编辑后"})).unwrap();
        let value = own(&root, &id, "p").unwrap();
        assert_eq!(value["rewriteOriginalText"], "原文");
        assert_eq!(value["rewrittenText"], "编辑后");
        assert!(own(&root, &id, "other").is_err());
        assert!(folder(&root, "../../other").is_err());
        assert_eq!(
            public(
                json!({"id":id,"state":"queued","remoteTaskId":"remote","submissionPending":true})
            )["state"],
            "interrupted"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn history_never_plays_replaced_source() {
        let root = std::env::temp_dir().join(format!("bb-replication-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("source.mp4");
        fs::write(&path, b"original").unwrap();
        let id = uuid::Uuid::new_v4().simple().to_string();
        save(&root,&json!({"id":id,"projectId":"p","kind":"reference","path":path,"hash":hash(&path).unwrap()})).unwrap();
        assert!(verified_reference(&root, &id, "p").is_ok());
        fs::write(&path, b"changed").unwrap();
        assert!(verified_reference(&root, &id, "p").is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn fixed_ai_tag_survives_normal_tag_editing() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch("INSERT INTO assets(id,name) VALUES('rep','generated'); INSERT INTO tags(id,name,source) VALUES('ai','#ai生成','manual'); INSERT INTO asset_tags(asset_id,tag_id) VALUES('rep','ai'); INSERT INTO analyses(id,asset_id,kind,payload) VALUES('provenance','rep','replication_source','{}');").unwrap();
        }
        db.edit_classification_tags("rep", &[], "manual").unwrap();
        db.set_asset_tags("rep", &[], "manual").unwrap();
        assert!(db.delete_local_labels(&["ai".into()]).is_err());
        assert!(db.save_local_label(Some("ai"), "改名", "", false).is_err());
        assert!(db.local_example("ai", &["rep".into()], false).is_err());
        assert!(db
            .list_asset_tags("rep")
            .unwrap()
            .iter()
            .any(|tag| tag.name == "#ai生成"));
    }
}
