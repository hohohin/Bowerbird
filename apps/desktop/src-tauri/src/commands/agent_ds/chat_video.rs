//! HyperFrames tools used by the existing chat model. No nested model invocation.
use super::*;
use crate::{core::paths::LibraryPaths, db::Database};
use sha2::{Digest, Sha256};
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::watch;
use tauri::{AppHandle, Emitter, Manager};

pub(crate) const INSTRUCTIONS: &str = "本机对话额外支持 hyperframes_video 工具。用户要求制作或修改视频时，直接使用该工具制作并交付 MP4，无需切换到 Agent 卡片。普通讨论不启动制作。先 prepare 获取固定版本 Skill、工程文件列表和本轮素材路径；用 read 读取 Skill 或已有工程，用 write 写 HTML/CSS/JS，再 check、snapshot 观察画面，最后 render。每轮交付一个视频，续聊自动复制上一轮已交付工程；不能借用其他会话。工具由应用执行，shell/全局 skills 不可用不代表视频工具不可用。不运行 npm、登录或额外付费服务，不引用网络资源。只有 render 返回 delivered 才能声称交付。创建画板卡片仍遵守原规则，不自动运行卡片。";

pub(crate) fn spec() -> Value {
    json!({"type":"function","name":"hyperframes_video","description":"Make or revise a local HyperFrames video in this conversation, only when the user requests video creation. First prepare, then read/write project files, check, snapshot (returns images), render (imports and displays MP4 in chat). One delivery per turn. No arbitrary commands or external paths. Available on every supported desktop installation, using its managed runtime.","inputSchema":{"type":"object","additionalProperties":false,"required":["action"],"properties":{
        "action":{"enum":["prepare","read","write","check","snapshot","render"]},
        "path":{"type":"string","description":"Relative project file, or skills/<skill>/SKILL.md for reading installed skill instructions."},
        "content":{"type":"string","maxLength":300000,"description":"Complete UTF-8 file contents for write."}
    }}})
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Args { action: String, path: Option<String>, content: Option<String> }
impl Args {
    fn parse(value: &Value) -> Result<Self, AppError> {
        let args: Self = serde_json::from_value(value.clone())?;
        let valid = match args.action.as_str() {
            "read" => args.path.is_some() && args.content.is_none(),
            "write" => args.path.is_some() && args.content.as_ref().is_some_and(|s| s.len() <= 300_000),
            "prepare" | "check" | "snapshot" | "render" => args.path.is_none() && args.content.is_none(),
            _ => false,
        };
        if !valid { return Err(AppError::Other("视频工具参数无效，请检查操作和文件内容".into())); }
        Ok(args)
    }
}

fn file_path(root: &Path, name: &str, write: bool) -> Result<PathBuf, AppError> {
    let invalid = || AppError::Other("只能访问本次视频工程的 HTML、CSS、JS、JSON 或配套 Skill".into());
    if name.len() > 240 || name.contains(['\\', ':']) || name.split('/').any(|p| p.is_empty() || p.starts_with('.')) { return Err(invalid()); }
    let (base, name) = if let Some(skill) = name.strip_prefix("skills/") {
        if write { return Err(invalid()); }
        (root.join(".agents/skills"), skill)
    } else {
        if !matches!(Path::new(name).extension().and_then(|s|s.to_str()), Some("html" | "css" | "js" | "json")) || name.starts_with("assets/") { return Err(invalid()); }
        (root.join("project"), name)
    };
    let base = std::fs::canonicalize(base)?;
    let mut path = base.clone();
    let parts: Vec<_> = name.split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        path.push(part);
        if path.exists() {
            if std::fs::canonicalize(&path)? != path { return Err(invalid()); }
        } else if index + 1 < parts.len() && write { std::fs::create_dir(&path)?; }
    }
    Ok(path)
}

fn files(base: &Path, at: &Path, result: &mut Vec<String>) -> Result<(), AppError> {
    for entry in std::fs::read_dir(at)? {
        let entry = entry?;
        if result.len() >= 200 { break; }
        if entry.file_type()?.is_symlink() || entry.file_name().to_string_lossy().starts_with('.') { continue; }
        let path = entry.path();
        if path.is_dir() { files(base, &path, result)?; }
        else { result.push(path.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/")); }
    }
    Ok(())
}

fn text(value: Value) -> Value { json!({"contentItems":[{"type":"inputText","text":value.to_string()}],"success":true}) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chat_video_files_and_operations_are_scoped() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path();
        std::fs::create_dir_all(root.join("project")).unwrap();
        std::fs::create_dir_all(root.join(".agents/skills/hyperframes")).unwrap();
        for name in ["../outside.html", "/outside.html", "C:/outside.html", "a\\b.html", ".agents/foo.js", "assets/gsap.js", "script.exe"] {
            assert!(file_path(root, name, true).is_err(), "{name}");
        }
        assert!(file_path(root, "skills/hyperframes/SKILL.md", true).is_err());
        assert!(file_path(root, "skills/hyperframes/SKILL.md", false).is_ok());
        let file = file_path(root, "compositions/scene.html", true).unwrap();
        std::fs::write(&file, "scene").unwrap();
        assert_eq!(std::fs::read_to_string(file_path(root,"compositions/scene.html",false).unwrap()).unwrap(), "scene");
        for value in [json!({"action":"shell"}),json!({"action":"render","path":"outside"}),json!({"action":"write","path":"index.html"}),json!({"action":"prepare","endpoint":"remote"})] {
            assert!(Args::parse(&value).is_err());
        }
        assert!(Args::parse(&json!({"action":"write","path":"index.html","content":"<html>"})).is_ok());
    }
}

/// Called only after the app-server thread/turn and entitlement checks.
pub(crate) async fn call(app: &AppHandle, db: &Database, conversation: &str, turn: &str, call: &str, value: &Value, images: &[String], mut cancel: watch::Receiver<bool>) -> Result<Value, AppError> {
    let args = Args::parse(value)?;
    let chat = db.get_local_chat(conversation)?.ok_or_else(|| AppError::Other("对话不存在".into()))?;
    if chat.summary.provider != "codex-local" || chat.summary.status != "running" || !chat.messages.iter().any(|m| m.turn_id == turn && m.status == "running") {
        return Err(AppError::Other("视频请求不属于当前运行中的本机对话".into()));
    }
    let digest = format!("{:x}", Sha256::digest(format!("chat-video:{conversation}").as_bytes()));
    let scope = format!("session-bowerbird-{digest}");
    let request_id = format!("{}-{}", chat.messages.iter().find(|m|m.turn_id==turn).unwrap().created_at, uuid::Uuid::from_slice(&Sha256::digest(turn.as_bytes())[..16]).unwrap());
    let base = crate::codex::codex_cli::app_data_dir().ok_or_else(|| AppError::Other("应用资料目录不可用".into()))?.join("chat-video").join(&digest);
    let root = base.join(&request_id);
    std::fs::create_dir_all(&root)?;
    let root = std::fs::canonicalize(root)?;
    let receipt = root.join(format!("call-{}.json", format!("{:x}", Sha256::digest(call.as_bytes()))));
    if receipt.exists() {
        let saved: Value = serde_json::from_slice(&std::fs::read(receipt)?)?;
        if saved["args"] != *value { return Err(AppError::Other("视频调用编号已用于其他操作".into())); }
        return Ok(saved["result"].clone());
    }
    if root.join("delivered.json").exists() { return Ok(text(json!({"delivered":true,"notice":"本轮视频已交付；如需修改请在下一轮继续。"}))); }
    std::fs::OpenOptions::new().write(true).create_new(true).open(receipt.with_extension("claimed"))
        .map_err(|_| AppError::Other("此视频操作已执行或中断，未重复运行；请继续对话重新检查工程".into()))?;
    let progress = match args.action.as_str() { "prepare" => "正在准备视频工程", "render" => "正在渲染视频", "snapshot" => "正在预览视频", _ => "正在制作视频" };
    db.save_local_chat_video(conversation, turn, progress, "running", &[])?;
    let _ = app.emit("local-chat://updated", db.get_local_chat(conversation)?);
    let result = execute(app, db, &chat.summary.project_id, conversation, turn, &root, &request_id, &scope, &args, images, &mut cancel).await;
    let result = match result {
        Ok(value) => value,
        Err(error) => {
            let _ = db.save_local_chat_video(conversation, turn, &error.to_string(), "failed", &[]);
            json!({"success":false,"contentItems":[{"type":"inputText","text":error.to_string()}]})
        }
    };
    let _ = app.emit("local-chat://updated", db.get_local_chat(conversation)?);
    write_json_atomic(&receipt, &json!({"args":value,"result":result}))?;
    Ok(result)
}

async fn execute(app: &AppHandle, db: &Database, project_id: &str, conversation: &str, turn: &str, root: &Path, id: &str, scope: &str, args: &Args, images: &[String], cancel: &mut watch::Receiver<bool>) -> Result<Value, AppError> {
    if *cancel.borrow() { return Err(AppError::Other("视频制作已停止".into())); }
    if args.action == "prepare" {
        if !root.join("video-request.json").exists() { video::request(root, id, scope, images)?; }
        let _ = video::prepare(root, scope, cancel).await?;
        let mut list = Vec::new(); files(&root.join("project"), &root.join("project"), &mut list)?;
        return Ok(text(json!({"files":list,"skill":std::fs::read_to_string(root.join(".agents/skills/hyperframes/SKILL.md"))?,"instructions":INSTRUCTIONS})));
    }
    if !root.join("bowerbird-hyperframes.mjs").is_file() { return Err(AppError::Other("请先调用 prepare 准备视频工程".into())); }
    if matches!(args.action.as_str(), "read" | "write") {
        let path = file_path(root, args.path.as_deref().unwrap(), args.action == "write")?;
        if let Some(content) = &args.content { std::fs::write(path, content)?; return Ok(text(json!({"saved":true}))); }
        if std::fs::metadata(&path)?.len() > 300_000 { return Err(AppError::Other("工程文件过大，请精简后读取".into())); }
        return Ok(text(json!({"content":std::fs::read_to_string(path)?})));
    }
    let prepared = video::prepare(root, scope, cancel).await?;
    let artifacts = root.join("artifacts").join(id); std::fs::create_dir_all(&artifacts)?;
    let command: Vec<String> = match args.action.as_str() {
        "check" => vec!["check".into(), "--json".into()],
        "snapshot" => vec!["snapshot".into(), "--frames".into(), "3".into(), "--json".into()],
        "render" => vec!["render".into(), "--output".into(), artifacts.join("result.mp4").to_string_lossy().into_owned(), "--quality".into(), "delivery".into()],
        _ => unreachable!(),
    };
    let output = video::execute(root, &prepared, &command, cancel).await?;
    if output["code"] != 0 {
        db.save_local_chat_video(conversation, turn, "视频检查或渲染未通过，正在等待修正工程", "failed", &[])?;
        let mut result = text(output); result["success"] = json!(false); return Ok(result);
    }
    if args.action == "snapshot" {
        use base64::Engine;
        let snapshots: Value = serde_json::from_str(output["stdout"].as_str().unwrap_or(""))?;
        let mut result = text(output.clone());
        for frame in snapshots["frames"].as_array().into_iter().flatten().take(3) {
            let path = std::fs::canonicalize(frame["path"].as_str().unwrap_or(""))?;
            if !path.starts_with(root.join("project/.hyperframes")) || std::fs::metadata(&path)?.len() > 8 * 1024 * 1024 { return Err(AppError::Other("视频预览输出无效".into())); }
            result["contentItems"].as_array_mut().unwrap().push(json!({"type":"inputImage","imageUrl":format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(std::fs::read(path)?))}));
        }
        return Ok(result);
    }
    if args.action != "render" { return Ok(text(output)); }
    if *cancel.borrow() { return Err(AppError::Other("视频制作已停止".into())); }
    let files = video::result_paths(root, id, &json!({"videos":["result.mp4"]}))?;
    let paths = app.state::<Arc<LibraryPaths>>();
    let asset = crate::core::ingest::ingest_new_file(&paths, db, &files[0])?;
    db.add_assets_to_project(project_id, std::slice::from_ref(&asset.id))?;
    for path in [&asset.store_path, &asset.thumb_path].into_iter().flatten() {
        app.asset_protocol_scope().allow_file(path).map_err(|e|AppError::Other(e.to_string()))?;
    }
    db.save_local_chat_video(conversation, turn, "视频已完成", "done", std::slice::from_ref(&asset.id))?;
    video::accept_revision(root)?;
    let result = text(json!({"delivered":true,"assetId":asset.id,"message":"成片已显示在本轮对话并保存到项目素材；可以继续对话修改。"}));
    write_json_atomic(&root.join("delivered.json"), &result)?;
    let _ = app.emit("library://assets-changed", ()); let _ = app.emit("projects://changed", ());
    Ok(result)
}
