//! Codex CLI adapter for the existing local workflow protocol (development and installed desktop).
//! The CLI owns reasoning; the desktop owns request identity, tools and delivery.
use super::*;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::watch;
use crate::codex::codex_cli::{codex_command, resolve_codex_binary, CodexFailure};

struct Active {
    scope: String,
    cancel: watch::Sender<bool>,
    finished: watch::Receiver<bool>,
}
static ACTIVE: LazyLock<Mutex<HashMap<String, Active>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn workspace_command(binary: &str, root: &Path) -> tokio::process::Command {
    let mut command = codex_command(binary);
    command.current_dir(root).args(["-a", "never", "-c", "sandbox_mode=\"workspace-write\""]);
    // An isolated Windows profile has no sandbox implementation selected. Codex
    // silently downgrades workspace-write to read-only without this setting.
    // Restricted-token mode needs no administrator setup; never bypass the sandbox.
    #[cfg(windows)]
    command.args(["-c", "windows.sandbox=\"unelevated\""]);
    command.arg("-C").arg(root);
    command
}

async fn read_tail(mut stream: impl tokio::io::AsyncRead + Unpin) -> std::io::Result<String> {
    let mut tail = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = stream.read(&mut buffer).await?;
        if count == 0 { break; }
        tail.extend_from_slice(&buffer[..count]);
        if tail.len() > 8192 { tail.drain(..tail.len() - 8192); }
    }
    Ok(String::from_utf8_lossy(&tail).into_owned())
}

#[cfg(windows)]
async fn check_workspace_write(mut command: tokio::process::Command, root: &Path, cancel: &mut watch::Receiver<bool>) -> Result<(), AppError> {
    // Exercise the CLI's real sandbox, not the unrestricted desktop process. This
    // runs no model and does not inherit or change the user's shared CLI settings.
    let probe = format!(".bowerbird-write-probe-{}", uuid::Uuid::new_v4());
    let script = format!("$ErrorActionPreference='Stop'; $probe=Join-Path (Get-Location) '{probe}'; \
        try {{ Set-Content -LiteralPath $probe -Value 'BOWERBIRD_WRITE_OK' -NoNewline; \
        if ((Get-Content -LiteralPath $probe -Raw) -ne 'BOWERBIRD_WRITE_OK') {{ throw 'write verification failed' }} \
        }} finally {{ if (Test-Path -LiteralPath $probe) {{ Remove-Item -LiteralPath $probe }} }}; \
        Write-Output 'BOWERBIRD_WRITE_OK'");
    // Do not select a separate sandbox --permission-profile here: that can grant
    // writes for the probe even while exec's effective policy has become read-only.
    command.args(["sandbox", "--",
        "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| AppError::Other(format!("Codex CLI 写入检查无法启动，尚未调用模型：{error}")))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let checked = {
        let execution = async {
            let (stdout, stderr, status) = tokio::try_join!(read_tail(stdout), read_tail(stderr), child.wait())
                .map_err(|error| AppError::Other(format!("Codex CLI 写入检查异常，尚未调用模型：{error}")))?;
            if !status.success() || !stdout.lines().any(|line| line.trim() == "BOWERBIRD_WRITE_OK") {
                let detail = if !stderr.trim().is_empty() { error_text(&stderr) }
                    else if !stdout.trim().is_empty() { error_text(&stdout) }
                    else { format!("未返回写入成功确认（{status}）") };
                return Err(AppError::Other(format!("Codex CLI 工作目录写入检查失败，尚未调用模型；请检查任务目录权限及设置中的 CLI 安装：{detail}")));
            }
            Ok(())
        };
        tokio::select! {
            _ = cancel.changed() => Err(AppError::Other("Codex CLI 已停止".into())),
            result = tokio::time::timeout(Duration::from_secs(30), execution) =>
                result.unwrap_or_else(|_| Err(AppError::Other("Codex CLI 工作目录写入检查超时，尚未调用模型".into()))),
        }
    };
    if checked.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    // Also clean up if the check was cancelled between its write and finally block.
    let _ = std::fs::remove_file(root.join(probe));
    checked
}

pub(super) fn request_root(id: &str) -> Result<PathBuf, AppError> {
    workflow_file(&delivery_root(), id, "results")?;
    Ok(delivery_root().join("codex").join(id))
}

pub(super) fn is_request(root: &Path) -> bool { root.join("request.json").exists() }
pub(super) fn is_active(id: &str) -> bool { ACTIVE.lock().unwrap().contains_key(id) }

pub(super) fn start(root: PathBuf, id: String, payload: DeliveryPayload, isolated_session: bool) -> Result<DeliveryOutcome, AppError> {
    let binary = resolve_codex_binary().ok_or_else(|| AppError::Other("未找到 Codex CLI，请在设置中安装并登录".into()))?;
    start_with_binary(root, id, payload, &binary, isolated_session)
}

fn start_with_binary(root: PathBuf, id: String, payload: DeliveryPayload, binary: &str, isolated_session: bool) -> Result<DeliveryOutcome, AppError> {
    let scope = payload.target_session_id.clone().ok_or_else(|| AppError::Other("Codex CLI 缺少卡片身份".into()))?;
    // Reuse the same format/byte limits as native DSH image attachments.
    workflow_image_parts(&payload.images).map_err(AppError::Other)?;
    let mut active = ACTIVE.lock().unwrap();
    let outcome = DeliveryOutcome { path: root.join("request.json").to_string_lossy().into_owned(),
        session_id: None, session_title: Some("Codex CLI".into()), auto_delivered: true, notice: None };
    if is_request(&root) { return Ok(outcome); }
    if active.values().any(|run| run.scope == scope) {
        return Err(AppError::Other("此卡片的 Codex CLI 尚未结束，请等待或停止原任务".into()));
    }
    std::fs::create_dir_all(&root)?;
    let root = std::fs::canonicalize(root)?;
    // Isolated loop items must neither inherit nor overwrite the card's interactive
    // session. The per-card in-flight lock above still applies to both session modes.
    let session_path = if isolated_session { root.join("session.json") }
        else { root.parent().unwrap().join("sessions").join(format!("{scope}.json")) };
    let session = if session_path.exists() {
        let session: String = serde_json::from_slice(&std::fs::read(&session_path)?)?;
        uuid::Uuid::parse_str(&session).map_err(|_| AppError::Other("Codex 卡片会话记录无效".into()))?;
        Some(session)
    } else { None };
    let mut command = workspace_command(binary, &root);
    command.args(["exec", "--skip-git-repo-check", "--json"]);
    if let Some(session) = &session { command.arg("resume").arg(session); }
    for image in &payload.images { command.arg("--image").arg(&image.path); }
    command.args(["--", "-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    // Claim before spawn: an interrupted/duplicate IPC must never call the model again.
    let receipt = std::fs::OpenOptions::new().write(true).create_new(true).open(root.join("request.json"))?;
    serde_json::to_writer(receipt, &payload)?;
    #[cfg(windows)]
    let probe_command = workspace_command(binary, &root);
    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    let (finished_tx, finished_rx) = watch::channel(false);
    active.insert(id.clone(), Active { scope, cancel: cancel_tx, finished: finished_rx });
    tokio::spawn(async move {
        let completed = async {
            #[cfg(windows)]
            check_workspace_write(probe_command, &root, &mut cancel_rx).await?;
            if *cancel_rx.borrow() { return Err(AppError::Other("Codex CLI 已停止".into())); }
            let mut child = command.spawn().map_err(|error| AppError::Other(format!("启动 Codex CLI 失败：{error}；请检查设置中的安装与登录")))?;
            let completed = {
                let execution = tokio::time::timeout(Duration::from_secs(1800), execute(&mut child, &payload, &session_path));
                tokio::select! {
                    _ = cancel_rx.changed() => Err(AppError::Other("Codex CLI 已停止".into())),
                    result = execution => result.unwrap_or_else(|_| Err(AppError::Other("Codex CLI 执行超时（30 分钟）".into()))),
                }
            };
            if completed.is_err() {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
            completed
        }.await;
        let completed = completed.and_then(|last_message| {
            let result = read_workflow_result(&root, &id)?.ok_or_else(|| {
                let detail = if last_message.is_empty() { "；Agent 未提供失败说明".into() }
                    else { format!("；Agent 说明：{last_message}") };
                AppError::Other(format!("Codex CLI 未写回结果文件{detail}"))
            })?;
            if result["schemaVersion"] != 1 { return Err(AppError::Other("Codex CLI 返回协议版本无效".into())); }
            Ok(())
        });
        let completion = match completed { Ok(()) => json!({"done":true}), Err(error) => json!({"error":error.to_string().chars().take(1800).collect::<String>()}) };
        if let Err(error) = write_json_atomic(&root.join("completion.json"), &completion) {
            tracing::warn!("保存 Codex CLI 完成状态失败: {error}");
        }
        ACTIVE.lock().unwrap().remove(&id);
        let _ = finished_tx.send(true);
    });
    Ok(outcome)
}

async fn execute(child: &mut tokio::process::Child, payload: &DeliveryPayload, session_path: &Path) -> Result<String, AppError> {
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let prompt = format!("{}\n{}\n本次仅处理本卡要求；不要读取或修改素材库、源代码或其他任务目录。", payload.text,
        payload.images.iter().enumerate().map(|(i, image)| format!("图片 {}：{}", i + 1, image.path)).collect::<Vec<_>>().join("\n"));
    let input = async move { stdin.write_all(prompt.as_bytes()).await?; stdin.shutdown().await };
    let events = async {
        let mut lines = BufReader::new(stdout).lines();
        let mut failure = CodexFailure::default();
        let mut completed = false;
        let mut last_message = String::new();
        while let Some(line) = lines.next_line().await? {
            if let Ok(event) = serde_json::from_str::<Value>(&line) {
                failure.observe(&event);
                if event["type"] == "thread.started" {
                    let session = event["thread_id"].as_str().filter(|id| uuid::Uuid::parse_str(id).is_ok())
                        .ok_or_else(|| AppError::Other("Codex CLI 返回会话身份无效".into()))?;
                    std::fs::create_dir_all(session_path.parent().unwrap())?;
                    write_json_atomic(session_path, &session)?;
                }
                if event["type"] == "turn.completed" { completed = true; }
                if event["type"] == "item.completed" && event["item"]["type"] == "agent_message" {
                    if let Some(text) = event["item"]["text"].as_str().filter(|text| !text.trim().is_empty()) {
                        last_message = text.trim().chars().take(1200).collect();
                    }
                }
            }
        }
        Ok::<_, AppError>((completed, failure, last_message))
    };
    // Drain stderr concurrently without retaining unbounded CLI diagnostics.
    let (_, (completed, failure, last_message), stderr, status) = tokio::try_join!(
        async { input.await.map_err(AppError::from) }, events,
        async { read_tail(stderr).await.map_err(AppError::from) }, async { child.wait().await.map_err(AppError::from) }
    )?;
    if let Some(detail) = failure.detail(status.success(), completed, &stderr) {
        return Err(AppError::Other(format!("Codex CLI 执行失败：{detail}")));
    }
    if !status.success() || !completed { return Err(AppError::Other(format!("Codex CLI 未完成（{status}）：{}", error_text(&stderr)))); }
    Ok(last_message)
}

pub(super) fn result(root: &Path, id: &str) -> Result<Option<Value>, AppError> {
    if is_active(id) { return Ok(None); }
    let completion = root.join("completion.json");
    if !completion.exists() {
        return Ok(Some(json!({"schemaVersion":1,"requestId":id,"submissionUnknown":true,"error":"Codex CLI 已中断，提交状态未知；未自动重发，请检查原任务后重新运行"})));
    }
    let status: Value = serde_json::from_slice(&std::fs::read(completion)?)?;
    if let Some(error) = status["error"].as_str() { return Ok(Some(json!({"schemaVersion":1,"requestId":id,"error":error}))); }
    read_workflow_result(root, id)
}

pub(super) async fn cancel(id: &str) {
    let finished = ACTIVE.lock().unwrap().get(id).map(|active| {
        let _ = active.cancel.send(true);
        active.finished.clone()
    });
    if let Some(mut finished) = finished {
        while !*finished.borrow_and_update() {
            if finished.changed().await.is_err() { break; }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[cfg(unix)]
    fn fixture() -> (PathBuf, String) {
        let base = std::env::temp_dir().join(format!("bowerbird-codex-agent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let binary = base.join("fake codex");
        std::fs::write(&binary, r#"#!/usr/bin/python3
# coding: utf-8
import json, sys, pathlib, time, uuid
root = pathlib.Path.cwd()
args = sys.argv[1:]
(root / 'args.json').write_text(json.dumps(args))
(root / 'stdin.txt').write_text(sys.stdin.read())
mode = (root / 'mode').read_text() if (root / 'mode').exists() else 'success'
session = args[args.index('resume') + 1] if 'resume' in args else str(uuid.uuid4())
print(json.dumps({'type':'thread.started','thread_id':session}), flush=True)
if mode == 'slow': time.sleep(30)
if mode != 'missing':
    result = {'schemaVersion':1,'requestId':root.name,'text':'completed'}
    if mode == 'wrong': result['requestId'] = 'other'
    (root / 'results').mkdir(exist_ok=True)
    (root / 'results' / (root.name + '.json')).write_text(json.dumps(result))
else:
    print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'当前环境仅允许读取文件，无法写入结果 JSON'}}), flush=True)
if mode == 'failed':
    print(json.dumps({'type':'turn.failed','error':{'message':'model unavailable'}}), flush=True)
else:
    print(json.dumps({'type':'turn.completed'}), flush=True)
"#).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        (base, binary.to_string_lossy().into_owned())
    }

    #[cfg(windows)]
    fn fixture() -> (PathBuf, String) {
        // A native executable exercises the real Windows private-profile launcher,
        // argument quoting and pipes; no Python/Node or real account is involved.
        let base = std::env::temp_dir().join(format!("bowerbird codex 测试 {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let source = base.join("fixture.rs");
        let binary = base.join("fake codex.exe");
        std::fs::write(&source, r##"
use std::{fs, io::{self, Read, Write}, path::PathBuf, time::Duration};
fn quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() { match c {
        '\\' => out.push_str("\\\\"), '"' => out.push_str("\\\""),
        '\n' => out.push_str("\\n"), '\r' => out.push_str("\\r"), '\t' => out.push_str("\\t"),
        _ => out.push(c),
    } }
    out.push('"'); out
}
fn main() {
    let root = std::env::current_dir().unwrap();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = fs::read_to_string(root.join("mode")).unwrap_or_default();
    if args.iter().any(|arg| arg == "sandbox") {
        fs::write(root.join("preflight.json"), format!("[{}]", args.iter().map(|s|quote(s)).collect::<Vec<_>>().join(","))).unwrap();
        if mode == "preflight-slow" { std::thread::sleep(Duration::from_secs(30)); }
        if mode == "preflight-denied" || !args.iter().any(|arg| arg == "windows.sandbox=\"unelevated\"") {
            eprintln!("Access is denied (os error 5)"); std::process::exit(1);
        }
        if mode != "preflight-empty" { println!("BOWERBIRD_WRITE_OK"); }
        return;
    }
    fs::write(root.join("args.json"), format!("[{}]", args.iter().map(|s|quote(s)).collect::<Vec<_>>().join(","))).unwrap();
    let mut input = String::new(); io::stdin().read_to_string(&mut input).unwrap();
    fs::write(root.join("stdin.txt"), input).unwrap();
    let session = args.iter().position(|s| s == "resume").map(|i| args[i+1].clone())
        .unwrap_or_else(|| format!("{:08x}-1111-4111-8111-111111111111", std::process::id()));
    println!("{{\"type\":\"thread.started\",\"thread_id\":{}}}", quote(&session)); io::stdout().flush().unwrap();
    if mode == "slow" { std::thread::sleep(Duration::from_secs(30)); }
    if mode != "missing" {
        let id = if mode == "wrong" { "other".into() } else { root.file_name().unwrap().to_string_lossy().into_owned() };
        fs::create_dir_all(root.join("results")).unwrap();
        fs::write(root.join("results").join(format!("{}.json", root.file_name().unwrap().to_string_lossy())),
            format!("{{\"schemaVersion\":1,\"requestId\":{},\"text\":\"completed\"}}", quote(&id))).unwrap();
    } else { println!("{{\"type\":\"item.completed\",\"item\":{{\"type\":\"agent_message\",\"text\":\"当前环境仅允许读取文件，无法写入结果 JSON\"}}}}"); }
    if mode == "failed" { println!("{{\"type\":\"turn.failed\",\"error\":{{\"message\":\"model unavailable\"}}}}"); }
    else { println!("{{\"type\":\"turn.completed\"}}"); }
}
"##).unwrap();
        let output = std::process::Command::new("rustc").arg(&source).args(["--crate-name", "fake_codex"]).arg("-o").arg(&binary).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        (base, binary.to_string_lossy().into_owned())
    }

    fn request(base: &Path, scope: &str, mode: &str) -> (PathBuf, String, DeliveryPayload) {
        let id = format!("1758598261835-{}", uuid::Uuid::new_v4());
        let root = base.join(&id);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("mode"), mode).unwrap();
        let mut payload = build_delivery_payload("instruction", "instruction", &[], &[], None, "now".into());
        payload.target_session_id = Some(scope.into());
        (root, id, payload)
    }

    async fn finish(root: &Path, id: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(result) = result(root, id).unwrap() { return result; }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.unwrap()
    }

    #[tokio::test]
    async fn codex_cards_resume_only_their_own_session_and_duplicate_requests_never_spawn() {
        let (base, binary) = fixture();
        let (root, id, mut payload) = request(&base, "card-a", "success");
        let image = base.join("reference with spaces.png");
        image::RgbaImage::new(1, 1).save(&image).unwrap();
        payload.images.push(DeliveryImage { path: image.to_string_lossy().into_owned(), name: Some("image 1".into()) });
        start_with_binary(root.clone(), id.clone(), payload.clone(), &binary, false).unwrap();
        assert_eq!(finish(&root, &id).await["text"], "completed");
        let args: Vec<String> = serde_json::from_slice(&std::fs::read(root.join("args.json")).unwrap()).unwrap();
        assert!(args.windows(2).any(|args| args == ["--image", image.to_str().unwrap()]));
        assert!(args.contains(&"sandbox_mode=\"workspace-write\"".into()));
        #[cfg(windows)]
        assert!(args.contains(&"windows.sandbox=\"unelevated\"".into()));
        assert!(!args.contains(&"resume".into()));
        assert_eq!(args.last().unwrap(), "-");
        assert!(std::fs::read_to_string(root.join("stdin.txt")).unwrap().contains("instruction"));
        #[cfg(windows)]
        {
            let probe: Vec<String> = serde_json::from_slice(&std::fs::read(root.join("preflight.json")).unwrap()).unwrap();
            assert!(!probe.contains(&"--permission-profile".into()));
            assert!(probe.contains(&"windows.sandbox=\"unelevated\"".into()));
            assert!(!probe.contains(&"exec".into()));
        }
        let first = std::fs::read(base.join("sessions/card-a.json")).unwrap();
        start_with_binary(root.clone(), id.clone(), payload, "/missing/cli", false).unwrap();
        assert_eq!(finish(&root, &id).await["text"], "completed");
        let (root2, id2, payload2) = request(&base, "card-a", "success");
        start_with_binary(root2.clone(), id2.clone(), payload2, &binary, false).unwrap();
        finish(&root2, &id2).await;
        assert_eq!(first, std::fs::read(base.join("sessions/card-a.json")).unwrap());
        let args: Vec<String> = serde_json::from_slice(&std::fs::read(root2.join("args.json")).unwrap()).unwrap();
        let session: String = serde_json::from_slice(&first).unwrap();
        assert!(args.windows(2).any(|args| args == ["resume", &session]));
        // Loop items get fresh sessions without growing or replacing interactive history.
        let mut isolated_sessions = Vec::new();
        for _ in 0..2 {
            let (item_root, item_id, item_payload) = request(&base, "card-a", "success");
            start_with_binary(item_root.clone(), item_id.clone(), item_payload.clone(), &binary, true).unwrap();
            finish(&item_root, &item_id).await;
            let args: Vec<String> = serde_json::from_slice(&std::fs::read(item_root.join("args.json")).unwrap()).unwrap();
            assert!(!args.contains(&"resume".into()));
            let saved = std::fs::read(item_root.join("session.json")).unwrap();
            assert_ne!(saved, first);
            isolated_sessions.push(saved.clone());
            assert_eq!(first, std::fs::read(base.join("sessions/card-a.json")).unwrap());
            start_with_binary(item_root.clone(), item_id.clone(), item_payload, "/missing/cli", true).unwrap();
            assert_eq!(finish(&item_root, &item_id).await["text"], "completed");
            assert_eq!(saved, std::fs::read(item_root.join("session.json")).unwrap());
        }
        assert_ne!(isolated_sessions[0], isolated_sessions[1]);
        let (root3, id3, payload3) = request(&base, "card-b", "success");
        start_with_binary(root3.clone(), id3.clone(), payload3, &binary, false).unwrap();
        finish(&root3, &id3).await;
        assert_ne!(first, std::fs::read(base.join("sessions/card-b.json")).unwrap());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn codex_failures_partial_results_and_interrupted_requests_are_not_success() {
        let (base, binary) = fixture();
        for (mode, expected) in [("failed", "model unavailable"), ("wrong", "格式无效"), ("missing", "当前环境仅允许读取文件")] {
            let (root, id, payload) = request(&base, mode, mode);
            start_with_binary(root.clone(), id.clone(), payload, &binary, false).unwrap();
            let reply = finish(&root, &id).await;
            assert!(reply["error"].as_str().unwrap().contains(expected), "{reply}");
            assert!(reply.get("text").is_none());
        }
        let (root, id, payload) = request(&base, "orphan", "success");
        write_json_atomic(&root.join("request.json"), &payload).unwrap();
        start_with_binary(root.clone(), id.clone(), payload, &binary, false).unwrap();
        assert!(result(&root, &id).unwrap().unwrap()["error"].as_str().unwrap().contains("未自动重发"));
        assert!(!root.join("args.json").exists());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn codex_write_check_failure_and_cancellation_never_start_the_model() {
        let (base, binary) = fixture();
        for mode in ["preflight-denied", "preflight-empty"] {
            let (root, id, payload) = request(&base, mode, mode);
            start_with_binary(root.clone(), id.clone(), payload.clone(), &binary, false).unwrap();
            let reply = finish(&root, &id).await;
            assert!(reply["error"].as_str().unwrap().contains("写入检查失败"), "{reply}");
            assert!(reply["error"].as_str().unwrap().contains("尚未调用模型"));
            if mode == "preflight-denied" { assert!(reply["error"].as_str().unwrap().contains("Access is denied")); }
            if mode == "preflight-empty" { assert!(reply["error"].as_str().unwrap().contains("未返回写入成功确认")); }
            assert!(!root.join("args.json").exists());
            assert!(!root.join("stdin.txt").exists());
            assert!(!base.join("sessions").exists());
            start_with_binary(root.clone(), id.clone(), payload, "/missing/cli", false).unwrap();
            assert_eq!(finish(&root, &id).await, reply);
        }
        let (root, id, payload) = request(&base, "preflight-stop", "preflight-slow");
        start_with_binary(root.clone(), id.clone(), payload, &binary, true).unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while !root.join("preflight.json").exists() { tokio::time::sleep(Duration::from_millis(20)).await; }
        }).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), cancel(&id)).await.unwrap();
        assert!(finish(&root, &id).await["error"].as_str().unwrap().contains("已停止"));
        assert!(!root.join("args.json").exists());
        assert!(!is_active(&id));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "requires installed Codex CLI and Bowerbird launcher; offline, no model or credentials"]
    async fn installed_codex_windows_sandbox_writes_protocol_files_without_a_model() {
        let binary = resolve_codex_binary().expect("installed Codex CLI");
        let base = std::env::temp_dir().join(format!("bowerbird sandbox 中文 '{}'", uuid::Uuid::new_v4()));
        let root = base.join("task");
        let home = base.join("isolated-profile");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        std::fs::write(home.join("config.toml"), "cli_auth_credentials_store = \"file\"\n").unwrap();

        // Read Codex's actual model-visible permissions without making a model call.
        let mut debug = workspace_command(&binary, &root);
        debug.env("CODEX_HOME", &home).args(["debug", "prompt-input", "offline permission check"]).kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(30), debug.output()).await.unwrap().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let input: Value = serde_json::from_slice(&output.stdout).unwrap();
        let prompt = input.to_string();
        assert!(prompt.contains("`sandbox_mode` is `workspace-write`"), "workspace-write was not effective");
        assert!(!prompt.contains("`sandbox_mode` is `read-only`"));

        let (_tx, mut cancel) = watch::channel(false);
        let mut old = codex_command(&binary);
        old.env("CODEX_HOME", &home).current_dir(&root)
            .args(["-a", "never", "-c", "sandbox_mode=\"workspace-write\"", "-C"]).arg(&root);
        let error = check_workspace_write(old, &root, &mut cancel).await.unwrap_err();
        assert!(error.to_string().contains("写入检查失败"), "{error}");
        let mut probe = workspace_command(&binary, &root);
        probe.env("CODEX_HOME", &home);
        check_workspace_write(probe, &root, &mut cancel).await.unwrap();
        assert!(std::fs::read_dir(&root).unwrap().all(|entry| !entry.unwrap().file_name().to_string_lossy().starts_with(".bowerbird-write-probe-")));

        // Real sandbox process: write/rename/read both protocol files and an artifact.
        let mut protocol = workspace_command(&binary, &root);
        protocol.env("CODEX_HOME", &home).args(["sandbox", "--",
            "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", r#"$ErrorActionPreference='Stop';
            foreach ($folder in @('generation-requests','results','artifacts')) {
                New-Item -ItemType Directory -Path $folder -Force | Out-Null;
                Set-Content -LiteralPath (Join-Path $folder 'native-check.tmp') -Value '{"schemaVersion":1,"requestId":"native-check","text":"ok"}';
                Move-Item -LiteralPath (Join-Path $folder 'native-check.tmp') -Destination (Join-Path $folder 'native-check.json');
                if ((Get-Content -LiteralPath (Join-Path $folder 'native-check.json') -Raw | ConvertFrom-Json).text -ne 'ok') { throw 'protocol roundtrip failed' }
            }"#]).kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(30), protocol.output()).await.unwrap().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        for folder in ["generation-requests", "results", "artifacts"] {
            let value: Value = serde_json::from_slice(&std::fs::read(root.join(folder).join("native-check.json")).unwrap()).unwrap();
            assert_eq!(value["text"], "ok");
            assert!(!root.join(folder).join("native-check.tmp").exists());
        }
        assert!(!home.join("auth.json").exists());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn codex_cancel_waits_for_exit_and_releases_only_that_card() {
        let (base, binary) = fixture();
        let (root, id, payload) = request(&base, "cancel-card", "slow");
        start_with_binary(root.clone(), id.clone(), payload, &binary, false).unwrap();
        let (next, next_id, next_payload) = request(&base, "cancel-card", "success");
        assert!(start_with_binary(next.clone(), next_id.clone(), next_payload.clone(), &binary, true).is_err());
        assert!(result(&root, &id).unwrap().is_none());
        tokio::time::timeout(Duration::from_secs(3), async {
            while !root.join("args.json").exists() { tokio::time::sleep(Duration::from_millis(20)).await; }
        }).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), cancel(&id)).await.unwrap();
        assert!(finish(&root, &id).await["error"].as_str().unwrap().contains("已停止"));
        assert!(!is_active(&id));
        start_with_binary(next.clone(), next_id.clone(), next_payload, &binary, false).unwrap();
        assert_eq!(finish(&next, &next_id).await["text"], "completed");
        std::fs::remove_dir_all(base).unwrap();
    }
}
