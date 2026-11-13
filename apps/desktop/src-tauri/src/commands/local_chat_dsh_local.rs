// A fresh, restricted session on the user's DSH host for each app turn.
// The host owns its credentials/model selection; this bridge owns its preset and tools.
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// DSH 0.2+ 把 preset 声明固定在 profile 里：注册表不扫描目录，也不接受 preset 路径。
/// 因此本机建卡工具作为一条 profile 补丁安装一次，每轮只登记会话级连接。
const PRESET_ID: &str = "bowerbird-chat";
const PRESET_ROW: &str = "preset-bowerbird-chat";
const PRESET_BEGIN: &str = "# >>> bowerbird-chat (managed by Bowerbird; rewritten on connect)";
const PRESET_END: &str = "# <<< bowerbird-chat";
const TOOL_PREFIX: &str = "bowerbird-chat-";
const HANDSHAKE: &str = ".bowerbird/current.json";

/// DSH 0.2 网关把每个 Remote 方法挂在 `/api/<resource>/<action>`，方法名必须与端点一致。
const ROUTE_PRESETS: &str = "agentPresets/list";
const ROUTE_CREATE: &str = "session/create";
const ROUTE_PROMPT: &str = "session/prompt";
const ROUTE_EVENTS: &str = "session/events";
const ROUTE_CANCEL: &str = "session/cancel";

#[derive(Serialize, Deserialize)]
struct Pending {
    version: u8,
    base: String,
    session: String,
    rpc_id: String,
    after: i64,
}

fn session_id(turn: &str) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "session-bowerbird-chat-{:x}",
        Sha256::digest(turn.as_bytes())
    )
}

fn local_base(base: &str) -> AppResult<String> {
    dsh::validate_connection(base, None)
}

/// Which gateway generation the host speaks. `Live` sessions own no per-turn preset, so the
/// card tool depends on the profile installation; `Legacy` handlers keep the per-turn preset.
#[derive(Clone, Copy, PartialEq)]
pub(super) struct Health {
    pub(super) live: bool,
    pub(super) preset: bool,
}

struct Host {
    client: reqwest::Client,
    base: String,
}
impl Host {
    async fn connect(base: &str, auth: Option<&str>) -> AppResult<Self> {
        let base = local_base(base)?;
        let client = super::super::agent_ds::dsh_client(&base, auth)
            .await
            .map_err(|_| error("无法连接本机 DSH，请检查服务与登录链接"))?;
        Ok(Self { client, base })
    }

    async fn call(&self, method: &str, payload: Value, rpc_id: &str) -> AppResult<Value> {
        let mut response = self
            .client
            .post(format!("{}/api/{method}", self.base))
            .json(
                &json!({"type":"client-request","rpcId":rpc_id,"method":method,"payload":payload}),
            )
            .send()
            .await
            .map_err(|_| error("本机 DSH 连接中断；未自动重发，请取回原回复"))?;
        // A missing route is the only safe retry. An uncertain prompt may already be running.
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            let endpoint = method.replace('.', "/");
            let mut request = payload;
            if method == "session.prompt" {
                request["requestId"] = json!(rpc_id);
            }
            let args = if matches!(method, "session.list" | "agentPreset.list") {
                json!({"_request":request})
            } else {
                json!({"request":request})
            };
            response = self.client.post(format!("{}/api/{endpoint}", self.base))
                .json(&json!({"type":"client-request","rpcId":rpc_id,"method":endpoint,"payload":{"args":args}}))
                .send().await.map_err(|_| error("本机 DSH 连接中断；未自动重发，请取回原回复"))?;
        }
        finish(response).await
    }

    /// DSH 0.2 gateway call: the endpoint names the method and `payload` carries exactly one
    /// plain-object `args`. No dotted fallback — an unknown route is a version mismatch.
    async fn rpc(&self, route: &str, args: Value) -> AppResult<Value> {
        let rpc_id = uuid::Uuid::new_v4().to_string();
        let response = self
            .client
            .post(format!("{}/api/{route}", self.base))
            .json(&json!({"type":"client-request","rpcId":rpc_id,"method":route,"payload":{"args":args}}))
            .send()
            .await
            .map_err(|_| error("本机 DSH 连接中断；未自动重发，请取回原回复"))?;
        finish(response).await
    }

    async fn history(&self, pending: &Pending) -> AppResult<Vec<Value>> {
        let mut entries = BTreeMap::new();
        let mut before = None;
        for _ in 0..64 {
            let mut request = json!({"sessionId":pending.session,"maxMessages":30});
            if let Some(seq) = before {
                request["beforeSeq"] = json!(seq);
            }
            let page = self
                .call(
                    "session.history",
                    request,
                    &uuid::Uuid::new_v4().to_string(),
                )
                .await?;
            let events = page["events"]
                .as_array()
                .ok_or_else(|| error("本机 DSH 历史格式无效"))?;
            let mut earliest = before.unwrap_or(i64::MAX);
            for entry in events {
                let seq = entry["event"]["seq"]
                    .as_i64()
                    .ok_or_else(|| error("本机 DSH 历史缺少顺序编号"))?;
                earliest = earliest.min(seq);
                if seq > pending.after && !entries.contains_key(&seq) {
                    entries.insert(seq, entry.clone());
                }
            }
            if page["hasMore"] != true || earliest <= pending.after {
                return Ok(entries.into_values().collect());
            }
            if events.is_empty() || before.is_some_and(|seq| earliest >= seq) {
                return Err(error("本机 DSH 历史分页无效"));
            }
            before = Some(earliest);
        }
        Err(error("本机 DSH 本轮记录超过分页限制"))
    }

    /// DSH 0.2 history: `session/events` pages backwards from the log end through `throughSeq`.
    async fn events(&self, pending: &Pending) -> AppResult<Vec<Value>> {
        let mut entries = BTreeMap::new();
        let mut through = None;
        for _ in 0..64 {
            let mut request = json!({
                "address": {"kind": "session", "sessionId": pending.session},
                "maxMessages": 30,
            });
            if let Some(seq) = through {
                request["throughSeq"] = json!(seq);
            }
            let page = self.rpc(ROUTE_EVENTS, json!({"request": request})).await?;
            let records = page["records"]
                .as_array()
                .ok_or_else(|| error("本机 DSH 历史格式无效"))?;
            let mut earliest = i64::MAX;
            for entry in records {
                let seq = entry["event"]["seq"]
                    .as_i64()
                    .ok_or_else(|| error("本机 DSH 历史缺少顺序编号"))?;
                earliest = earliest.min(seq);
                if seq > pending.after {
                    entries.insert(seq, entry.clone());
                }
            }
            let next = earliest.saturating_sub(1);
            if page["hasMore"] != true
                || earliest == i64::MAX
                || next <= pending.after
                || through.is_some_and(|seq| next >= seq)
            {
                return Ok(entries.into_values().collect());
            }
            through = Some(next);
        }
        Err(error("本机 DSH 本轮记录超过分页限制"))
    }
}

async fn finish(response: reqwest::Response) -> AppResult<Value> {
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(error("本机 DSH 登录已失效，请更新登录链接后重试"));
    }
    if !response.status().is_success() {
        return Err(error("本机 DSH 请求未完成，请检查服务后取回原回复"));
    }
    let mut bytes = Vec::new();
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| error("本机 DSH 响应读取中断，请取回原回复"))?
    {
        bytes.extend_from_slice(&chunk);
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| error("本机 DSH 响应格式无效"))?;
    if value["result"]["ok"] != true {
        return Err(error(
            "本机 DSH 未接受请求，请检查模型配置与服务版本；未自动重发",
        ));
    }
    Ok(value["result"]["value"].clone())
}

async fn inspect_host(host: &Host) -> AppResult<Health> {
    if let Ok(value) = host.rpc(ROUTE_PRESETS, json!({})).await {
        let presets = value["presets"]
            .as_array()
            .ok_or_else(|| error("本机 DSH 未返回可用的 Agent preset"))?;
        return Ok(Health {
            live: true,
            preset: presets.iter().any(|row| row["id"] == PRESET_ID),
        });
    }
    let value = host
        .call(
            "agentPreset.list",
            json!({}),
            &uuid::Uuid::new_v4().to_string(),
        )
        .await?;
    if value["authorable"] != true || !value["presets"].is_array() {
        return Err(error("本机 DSH 尚不支持独立对话工具，请更新 DSH 后重试"));
    }
    Ok(Health {
        live: false,
        preset: true,
    })
}

pub(super) async fn inspect(base: &str, auth: Option<&str>) -> AppResult<Health> {
    let host = Host::connect(base, auth).await?;
    inspect_host(&host).await
}

/// DSH 0.2 只从 profile 声明里读取 preset。写入一次补丁与内容寻址的工具模块后，运行中的
/// 宿主会重载补丁（`web` 模板）或需要重启（桌面 profile）。
pub(super) enum Install {
    Active,
    RestartRequired,
}

fn profiles_root() -> AppResult<PathBuf> {
    let root = preset_root()?;
    let home = root.parent().ok_or_else(|| error("本机 DSH 目录无效"))?;
    Ok(home.join("profiles"))
}

fn handshake_path() -> AppResult<PathBuf> {
    let root = preset_root()?;
    Ok(root
        .parent()
        .ok_or_else(|| error("本机 DSH 目录无效"))?
        .join(HANDSHAKE))
}

fn preset_source(handshake: &Path) -> String {
    include_str!("local_chat_dsh_profile_tool.mjs")
        .replace("__STATE__", &json!(handshake.to_string_lossy()).to_string())
        .replace("__TOOL__", &card_tool_spec().to_string())
}

fn module_name(source: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = format!("{:x}", Sha256::digest(source.as_bytes()));
    format!("{TOOL_PREFIX}{}.mjs", &digest[..12])
}

fn preset_block(module: &str) -> String {
    let mut text = format!(
        "{PRESET_BEGIN}\n- insert:\n    - id: {PRESET_ROW}\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: {PRESET_ID}\n        order: 99\n        plugins:\n          - id: persona\n            name: '@deepseek-ai/dsh-persona'\n            config:\n              prefix: |-\n"
    );
    for line in CHAT_INSTRUCTIONS.trim_end().lines() {
        if line.trim().is_empty() {
            text.push('\n');
        } else {
            text.push_str("                ");
            text.push_str(line);
            text.push('\n');
        }
    }
    text.push_str(&format!(
        "          - id: bowerbird-cards\n            name: ./{module}\n{PRESET_END}\n"
    ));
    text
}

/// Replace our own marker block in place, otherwise append it to the user patch list.
fn merge_patch(original: &str, block: &str) -> String {
    if let Some(start) = original.find(PRESET_BEGIN) {
        let end = original[start..]
            .find(PRESET_END)
            .map(|offset| start + offset + PRESET_END.len());
        return match end {
            Some(end) => format!("{}{}{}", &original[..start], block.trim_end(), &original[end..]),
            None => format!("{}{}", &original[..start], block),
        };
    }
    let trimmed = original.trim();
    if trimmed.is_empty() {
        return block.to_string();
    }
    if trimmed == "[]" {
        return original.replacen("[]", block, 1);
    }
    let mut text = original.trim_end().to_string();
    text.push_str("\n\n");
    text.push_str(block);
    text
}

fn write_private(path: &Path, content: &str) -> AppResult<()> {
    use std::io::Write;
    std::fs::create_dir_all(path.parent().ok_or_else(|| error("DSH 配置目录无效"))?)?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> std::io::Result<()> {
        let mut file = options.open(&temp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result.map_err(|_| error("DSH 配置写入失败，请检查目录权限"))
}

/// Only profile directories the DSH launcher owns: a loader root plus its manifest.
fn profile_dirs() -> AppResult<Vec<PathBuf>> {
    let root = profiles_root()?;
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Ok(Vec::new());
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.join("cordis.yml").is_file() && path.join("package.json").is_file() {
            found.push(path);
        }
    }
    found.sort();
    Ok(found)
}

/// The managed block currently written in a profile patch, if any.
fn managed_block(patch: &str) -> Option<&str> {
    let start = patch.find(PRESET_BEGIN)?;
    let end = patch[start..].find(PRESET_END)? + start + PRESET_END.len();
    Some(&patch[start..end])
}

/// Remove only our managed block; an otherwise empty patch must stay loadable.
fn strip_patch(original: &str) -> String {
    let Some(start) = original.find(PRESET_BEGIN) else {
        return original.to_string();
    };
    let end = original[start..]
        .find(PRESET_END)
        .map(|offset| start + offset + PRESET_END.len());
    let mut text = match end {
        Some(end) => format!("{}{}", &original[..start], &original[end..]),
        None => original[..start].to_string(),
    };
    text = text.replace("\n\n\n", "\n\n");
    if text.trim().is_empty() {
        return "[]\n".into();
    }
    text
}

fn preset_files_current(profiles: &[PathBuf], module: &str, block: &str) -> bool {
    let managed = block.trim_end();
    !profiles.is_empty()
        && profiles.iter().all(|profile| {
            profile.join(module).is_file()
                && std::fs::read_to_string(profile.join("cordis.patch.yml"))
                    .ok()
                    .and_then(|text| {
                        managed_block(&text).map(|current| current.trim_end() == managed)
                    })
                    .unwrap_or(false)
        })
}

/// Whether the profiles on disk already point at the module this build ships.
pub(super) fn installed_current() -> bool {
    let Ok(profiles) = profile_dirs() else {
        return false;
    };
    let Ok(handshake) = handshake_path() else {
        return false;
    };
    let source = preset_source(&handshake);
    let module = module_name(&source);
    let block = preset_block(&module);
    preset_files_current(&profiles, &module, &block)
}

async fn preset_listed(host: &Host) -> bool {
    host.rpc(ROUTE_PRESETS, json!({}))
        .await
        .ok()
        .and_then(|value| {
            value["presets"]
                .as_array()
                .map(|rows| rows.iter().any(|row| row["id"] == PRESET_ID))
        })
        .unwrap_or(false)
}

async fn wait_preset(host: &Host, wanted: bool) -> bool {
    for _ in 0..30 {
        if preset_listed(host).await == wanted {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    false
}

fn write_preset(profiles: &[PathBuf], module: &str, source: &str, block: &str) -> AppResult<()> {
    for profile in profiles {
        write_private(&profile.join(module), source)?;
        let patch = profile.join("cordis.patch.yml");
        let original = std::fs::read_to_string(&patch).unwrap_or_default();
        let next = merge_patch(&original, block);
        if next != original {
            write_private(&patch, &next)?;
        }
        // Content-addressed modules are never overwritten, so the preset only points at an
        // immutable file; older revisions stay harmless next to it.
        for stale in std::fs::read_dir(profile).into_iter().flatten().flatten() {
            let name = stale.file_name().to_string_lossy().into_owned();
            if name.starts_with(TOOL_PREFIX) && name.ends_with(".mjs") && name != module {
                let _ = std::fs::remove_file(stale.path());
            }
        }
    }
    Ok(())
}

/// Keeps the profile contract in sync: a newer build must replace an older managed preset, and
/// only a host that actually lists the preset again is reported as active.
pub(super) async fn install(base: &str, auth: Option<&str>) -> AppResult<Install> {
    let profiles = profile_dirs()?;
    if profiles.is_empty() {
        return Err(error("找不到本机 DSH profile，请先启动一次 DSH"));
    }
    let handshake = handshake_path()?;
    let source = preset_source(&handshake);
    let module = module_name(&source);
    let block = preset_block(&module);
    let host = Host::connect(base, auth).await?;
    if preset_files_current(&profiles, &module, &block) {
        return Ok(if preset_listed(&host).await {
            Install::Active
        } else {
            Install::RestartRequired
        });
    }
    // A live host reloads only when the patch text changes. Drop the managed block first: if the
    // preset disappears, this host hot-reloads and the new module is provably loaded; if it never
    // disappears, this profile only applies patches on the next DSH start.
    let managed: Vec<&PathBuf> = profiles
        .iter()
        .filter(|profile| {
            std::fs::read_to_string(profile.join("cordis.patch.yml"))
                .map(|text| text.contains(PRESET_BEGIN))
                .unwrap_or(false)
        })
        .collect();
    if !managed.is_empty() {
        for profile in &managed {
            let patch = profile.join("cordis.patch.yml");
            if let Ok(original) = std::fs::read_to_string(&patch) {
                write_private(&patch, &strip_patch(&original))?;
            }
        }
        if !wait_preset(&host, false).await {
            write_preset(&profiles, &module, &source, &block)?;
            return Ok(Install::RestartRequired);
        }
    }
    write_preset(&profiles, &module, &source, &block)?;
    Ok(if wait_preset(&host, true).await {
        Install::Active
    } else {
        Install::RestartRequired
    })
}

fn handshake_update(session: &str, endpoint: Option<(&str, &str)>) -> AppResult<()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    let path = handshake_path()?;
    let mut all: Value = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({})),
        Err(detail) if detail.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(_) => return Err(error("本机 DSH 工具连接无法读取，请重新连接")),
    };
    match endpoint {
        Some((endpoint, token)) => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_millis() as i64)
                .unwrap_or_default();
            all[session] = json!({"endpoint":endpoint,"token":token,"at":now});
            // A turn that never finished leaves a dead endpoint behind; keep the file small.
            if let Some(map) = all.as_object_mut() {
                map.retain(|_, entry| {
                    entry["at"]
                        .as_i64()
                        .is_some_and(|at| now - at < 86_400_000)
                });
            }
        }
        None => {
            if let Some(map) = all.as_object_mut() {
                map.remove(session);
            }
        }
    }
    write_private(&path, &all.to_string())
}

/// One entry per running turn: the profile preset is shared, the tool resolves its own session.
fn handshake_add(session: &str, endpoint: &str, token: &str) -> AppResult<()> {
    handshake_update(session, Some((endpoint, token)))
}

fn handshake_remove(session: &str) {
    let _ = handshake_update(session, None);
}

#[derive(Default)]
struct Reply {
    text: String,
    target: Option<i64>,
    latest: Option<i64>,
    reason: Option<String>,
    /// Host-reported failure code and message for an `error` turn ending.
    failure: Option<(String, String)>,
}
impl Reply {
    fn status(&self) -> AppResult<Option<&'static str>> {
        match self.reason.as_deref() {
            None => Ok(None),
            Some("completed") => Ok(Some("done")),
            Some("aborted") => Ok(Some("stopped")),
            Some("interrupted") => Ok(Some("interrupted")),
            Some("max-tokens") => Err(error("本机 DSH 回复达到长度上限，已保留收到的内容")),
            Some("blocked") => Err(error("本机 DSH 本轮被阻止，请检查 DSH 后继续")),
            Some("error") => Err(error(&self.failed())),
            _ => Err(error(
                "本机 DSH 本轮未完成，已保留收到的内容；可重跑这张卡片，重跑前请确认本轮已创建的卡片",
            )),
        }
    }

    /// Turn a host failure into an actionable line without echoing host internals or error codes:
    /// the desktop filters messages that carry underscore tokens, which used to replace this text
    /// with a generic fallback.
    fn failed(&self) -> String {
        let (code, detail) = match &self.failure {
            Some((code, detail)) => (code.as_str(), detail.as_str()),
            None => ("", ""),
        };
        let kept = if self.text.trim().is_empty() {
            ""
        } else {
            "，已保留收到的内容"
        };
        // The card tool is the usual culprit: the model streams broken tool arguments and DSH
        // rejects the turn before Bowerbird ever sees the call. An earlier batch of the same turn
        // may already be committed, so the retry hint never promises a clean rerun.
        if detail.contains("tool input is invalid JSON") {
            return format!(
                "本机 DSH 本轮失败：模型返回的卡片工具参数不是合法 JSON；可重跑这张卡片，重跑前请确认本轮已创建的卡片{kept}"
            );
        }
        if code == "MALFORMED_RESPONSE" {
            return format!(
                "本机 DSH 本轮失败：模型回复格式异常；可重跑这张卡片，重跑前请确认本轮已创建的卡片{kept}"
            );
        }
        format!("本机 DSH 本轮失败；可重跑这张卡片，重跑前请确认本轮已创建的卡片{kept}")
    }
}

fn failure_detail(reason: &Value) -> Option<(String, String)> {
    let error = reason["error"].as_object()?;
    let code = error
        .get("code")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let message = error
        .get("message")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let message = if message.chars().count() > 240 {
        format!("{}…", message.chars().take(240).collect::<String>())
    } else {
        message
    };
    Some((code, message))
}

fn fold_history(entries: &[Value], rpc_id: &str, after: i64) -> AppResult<Reply> {
    let mut reply = Reply::default();
    let mut parts: BTreeMap<i64, String> = BTreeMap::new();
    // DSH 0.2 queues the turn as an inbox splice first; the matching user message may only
    // appear after `turn/start`, so remember the correlation until its turn is known.
    let mut armed = false;
    for entry in entries {
        let event = &entry["event"];
        if event["seq"]
            .as_i64()
            .ok_or_else(|| error("本机 DSH 历史编号无效"))?
            <= after
        {
            continue;
        }
        let data = &event["data"];
        match event["type"].as_str() {
            Some("turn/start") => {
                reply.latest = data["turn"].as_i64();
                if armed && reply.target.is_none() {
                    parts.clear(); // Discard provisional output from the preceding turn.
                    reply.target = reply.latest;
                    armed = false;
                }
            }
            Some("agent/inbox/spliced") => {
                let ours = data["inserted"].as_array().is_some_and(|items| {
                    items.iter().any(|item| {
                        item["source"]["rpcId"] == rpc_id || item["source"]["requestId"] == rpc_id
                    })
                });
                if ours {
                    armed = true;
                }
            }
            Some("user/message")
                if data["source"]["rpcId"] == rpc_id || data["source"]["requestId"] == rpc_id =>
            {
                reply.target = reply.latest;
            }
            Some("assistant/chunk")
                if (reply.target.is_some() && data["turn"].as_i64() == reply.target)
                    || (armed && reply.target.is_none() && reply.latest.is_some() && data["turn"].as_i64() == reply.latest) =>
            {
                if data["chunk"]["type"] == "text-delta" {
                    let step = data["step"]
                        .as_i64()
                        .ok_or_else(|| error("本机 DSH 回复步骤无效"))?;
                    parts
                        .entry(step)
                        .or_default()
                        .push_str(data["chunk"]["text"].as_str().unwrap_or(""));
                }
            }
            Some("assistant/message")
                if (reply.target.is_some() && data["turn"].as_i64() == reply.target)
                    || (armed && reply.target.is_none() && reply.latest.is_some() && data["turn"].as_i64() == reply.latest) =>
            {
                // Replacement surface messages are context compaction, not new public replies.
                if event["surfaceOp"].is_object() {
                    continue;
                }
                let step = data["step"]
                    .as_i64()
                    .ok_or_else(|| error("本机 DSH 回复步骤无效"))?;
                let content = data["message"]["content"]
                    .as_array()
                    .ok_or_else(|| error("本机 DSH 回复内容无效"))?;
                let text = content
                    .iter()
                    .filter(|block| block["type"] == "text")
                    .filter_map(|block| block["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("");
                parts.insert(step, text);
            }
            Some("turn/end") if data["turn"].as_i64() == reply.latest => {
                if reply.target.is_none() && armed {
                    reply.target = reply.latest;
                    armed = false;
                }
                if reply.target == reply.latest {
                    let reason = &data["reason"];
                    reply.reason = Some(reason["kind"].as_str().unwrap_or("unknown").into());
                    reply.failure = failure_detail(reason);
                }
            }
            _ => {}
        }
    }
    if reply.target.is_none() { parts.clear(); }
    reply.text = parts
        .into_values()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    Ok(reply)
}

#[derive(Clone)]
struct GatewayState {
    app: AppHandle,
    db: Arc<Database>,
    id: String,
    turn: String,
    session: String,
    token: String,
    active: Arc<std::sync::atomic::AtomicBool>,
}

fn authorized(state: &GatewayState, headers: &axum::http::HeaderMap, body: &Value) -> bool {
    state.active.load(std::sync::atomic::Ordering::Acquire)
        && !headers.contains_key(axum::http::header::ORIGIN)
        && headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            == Some(format!("Bearer {}", state.token).as_str())
        && body["sessionId"] == state.session
        && body["callId"]
            .as_str()
            .is_some_and(|id| !id.is_empty() && id.len() <= 200)
}

async fn tool_call(
    axum::extract::State(state): axum::extract::State<GatewayState>,
    headers: axum::http::HeaderMap,
    axum::Json(body): axum::Json<Value>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    if !authorized(&state, &headers, &body) {
        return (
            axum::http::StatusCode::FORBIDDEN,
            axum::Json(json!({"error":"当前对话工具授权已失效"})),
        );
    }
    let auth = state.app.state::<AuthClient>();
    let entitlement = state.app.state::<EntitlementService>();
    let result = super::super::local_chat_cards::create_cards(
        &state.app,
        &state.db,
        &auth,
        &entitlement,
        &state.id,
        &state.turn,
        body["callId"].as_str().unwrap(),
        &body["arguments"],
    )
    .await;
    let value = match result {
        Ok(action) => json!({"success":true,"action":action}),
        Err(detail) => json!({"success":false,"error":detail.to_string()}),
    };
    (axum::http::StatusCode::OK, axum::Json(value))
}

struct Gateway {
    endpoint: String,
    token: String,
    active: Arc<std::sync::atomic::AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}
impl Gateway {
    async fn start(
        app: &AppHandle,
        db: &Arc<Database>,
        id: &str,
        turn: &str,
        session: &str,
        mut cancel: watch::Receiver<bool>,
    ) -> AppResult<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}/cards", listener.local_addr()?);
        let token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let active = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let state = GatewayState {
            app: app.clone(),
            db: db.clone(),
            id: id.into(),
            turn: turn.into(),
            session: session.into(),
            token: token.clone(),
            active: active.clone(),
        };
        let router = axum::Router::new()
            .route("/cards", axum::routing::post(tool_call))
            .layer(axum::extract::DefaultBodyLimit::max(512_000))
            .with_state(state);
        let cancellation = active.clone();
        let task = tokio::spawn(async move {
            let shutdown = async move {
                let _ = cancel.wait_for(|stop| *stop).await;
                cancellation.store(false, std::sync::atomic::Ordering::Release);
            };
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(shutdown)
                .await;
        });
        Ok(Self {
            endpoint,
            token,
            active,
            task,
        })
    }
}
impl Drop for Gateway {
    fn drop(&mut self) {
        self.active
            .store(false, std::sync::atomic::Ordering::Release);
        self.task.abort();
    }
}

fn preset_source_for_turn(endpoint: &str, token: &str, session: &str) -> String {
    format!(
        "const connection = {};\nconst tool = {};\n{}",
        json!({"endpoint":endpoint,"token":token,"session":session}),
        card_tool_spec(),
        include_str!("local_chat_dsh_tool.mjs")
    )
}

struct Preset {
    id: String,
    directory: PathBuf,
}
impl Drop for Preset {
    fn drop(&mut self) {
        // Only the files exclusively created by this turn; preserve any unexpected contents.
        for name in ["agent.cordis.yml", "bowerbird-tools.mjs"] {
            let _ = std::fs::remove_file(self.directory.join(name));
        }
        let _ = std::fs::remove_dir(&self.directory);
    }
}

fn prepare_preset(
    root: &std::path::Path,
    turn: &str,
    endpoint: &str,
    token: &str,
    session: &str,
) -> AppResult<Preset> {
    // A unique directory is never overwritten, including after interrupted installation.
    ulid::Ulid::from_string(turn).map_err(|_| error("对话轮次编号无效"))?;
    let id = format!("bowerbird-chat-{turn}");
    std::fs::create_dir_all(root)?;
    let directory = root.join(&id);
    std::fs::create_dir(&directory)?;
    let preset = Preset { id, directory };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&preset.directory, std::fs::Permissions::from_mode(0o700))?;
    }
    let rows = json!([
        {"id":"persona","name":"@deepseek-ai/dsh-persona","config":{"text":CHAT_INSTRUCTIONS,"complete":true,"includeRuntimeContext":false}},
        {"id":"bowerbird-cards","name":"./bowerbird-tools.mjs"}
    ]);
    std::fs::write(
        preset.directory.join("bowerbird-tools.mjs"),
        preset_source_for_turn(endpoint, token, session),
    )?;
    // JSON is a strict subset of YAML. Publish the discoverable composition last.
    std::fs::write(
        preset.directory.join("agent.cordis.yml"),
        serde_json::to_vec(&rows)?,
    )?;
    Ok(preset)
}

fn preset_root() -> AppResult<PathBuf> {
    if let Some(home) = std::env::var_os("DSH_HOME").filter(|value| !value.is_empty()) {
        let home = PathBuf::from(home);
        if !home.is_absolute() {
            return Err(error("DSH_HOME 须为本机绝对目录"));
        }
        return Ok(home.join(".agent-presets"));
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .ok_or_else(|| error("无法定位本机 DSH 用户目录"))?;
    Ok(PathBuf::from(home).join(".dsh/.agent-presets"))
}

pub(super) async fn run(
    app: &AppHandle,
    db: &Arc<Database>,
    id: &str,
    turn: &str,
    base: &str,
    auth: Option<&str>,
    cancel: watch::Receiver<bool>,
) -> AppResult<&'static str> {
    let host = Host::connect(base, auth).await?;
    let health = inspect_host(&host).await?;
    if health.live {
        run_live(app, db, id, turn, &host, health.preset, cancel).await
    } else {
        run_legacy(app, db, id, turn, &host, cancel).await
    }
}

/// DSH 0.2 session: the profile preset (when installed) or the user's default preset.
async fn run_live(
    app: &AppHandle,
    db: &Arc<Database>,
    id: &str,
    turn: &str,
    host: &Host,
    preset: bool,
    cancel: watch::Receiver<bool>,
) -> AppResult<&'static str> {
    if *cancel.borrow() {
        return Ok("stopped");
    }
    let session = session_id(turn);
    let gateway = Gateway::start(app, db, id, turn, &session, cancel.clone()).await?;
    if preset {
        handshake_add(&session, &gateway.endpoint, &gateway.token)?;
    }
    let result = live_turn(app, db, id, turn, host, &session, preset, &gateway, cancel).await;
    handshake_remove(&session);
    result
}

#[allow(clippy::too_many_arguments)]
async fn live_turn(
    app: &AppHandle,
    db: &Arc<Database>,
    id: &str,
    turn: &str,
    host: &Host,
    session: &str,
    preset: bool,
    gateway: &Gateway,
    cancel: watch::Receiver<bool>,
) -> AppResult<&'static str> {
    let mut create = json!({"sessionId":session,"cwd":preset_root()?.parent()});
    if preset {
        create["agentPreset"] = json!(PRESET_ID);
    }
    let created = host
        .rpc(ROUTE_CREATE, json!({"request": create}))
        .await?;
    if created["sessionId"] != session || (preset && created["agentPreset"] != PRESET_ID) {
        return Err(error("本机 DSH 未启用本轮独立工具，未发送对话"));
    }
    let chat = db
        .get_local_chat(id)?
        .ok_or_else(|| error("对话记录不存在"))?;
    // Agent 卡片由流程逐轮驱动；重复附带上轮 JSON 历史会让模型产出非法工具参数。
    let include_history = db.local_chat_turn_uses_history(turn)?;
    let pending = Pending {
        version: 1,
        base: host.base.clone(),
        session: session.to_string(),
        rpc_id: uuid::Uuid::new_v4().to_string(),
        after: -1,
    };
    // Save before dispatch: a lost acknowledgement must never create a second model turn.
    db.set_local_chat_provider_turn(turn, &serde_json::to_string(&pending)?)?;
    if *cancel.borrow() {
        return Ok("stopped");
    }
    let accepted = host
        .rpc(
            ROUTE_PROMPT,
            json!({"request": {
                "sessionId": session,
                "mode": "queue",
                "requestId": pending.rpc_id,
                "content": [{"type":"text","text":dsh::prompt(&chat, turn, include_history)?}],
            }}),
        )
        .await?;
    if accepted["accepted"] != true {
        return Err(error("本机 DSH 未确认接收，请取回原回复；未自动重发"));
    }
    let start = Instant::now();
    let mut cancellation = None;
    let mut cancel_sent = false;
    let mut saved = String::new();
    loop {
        let reply = fold_history(&host.events(&pending).await?, &pending.rpc_id, pending.after)?;
        if reply.text != saved {
            db.update_local_chat_text(id, turn, &reply.text)?;
            saved = reply.text.clone();
            emit(app, db, id);
        }
        if let Some(status) = reply.status()? {
            return Ok(status);
        }
        if *cancel.borrow() {
            gateway
                .active
                .store(false, std::sync::atomic::Ordering::Release);
            cancellation.get_or_insert_with(Instant::now);
            if !cancel_sent && reply.target.is_some() {
                if reply.latest != reply.target {
                    return Err(error(
                        "本机 DSH 会话已发生变化，未中断其他轮次；请取回原回复",
                    ));
                }
                host.rpc(ROUTE_CANCEL, json!({"request": {"sessionId": session}}))
                    .await?;
                cancel_sent = true;
            }
        }
        if cancellation.is_some_and(|sent| sent.elapsed() > Duration::from_secs(20)) {
            return Err(error(
                "本机 DSH 尚未确认停止，工具通道已关闭；请稍后取回原回复",
            ));
        }
        if start.elapsed() > Duration::from_secs(1800) {
            return Err(error("本机 DSH 回复等待超时，未自动重发；请取回原回复"));
        }
        tokio::time::sleep(Duration::from_millis(750)).await;
    }
}

/// DSH 0.1 session: one throwaway preset directory per turn carries the card tool.
async fn run_legacy(
    app: &AppHandle,
    db: &Arc<Database>,
    id: &str,
    turn: &str,
    host: &Host,
    cancel: watch::Receiver<bool>,
) -> AppResult<&'static str> {
    if *cancel.borrow() {
        return Ok("stopped");
    }
    let session = session_id(turn);
    let gateway = Gateway::start(app, db, id, turn, &session, cancel.clone()).await?;
    let root = preset_root()?;
    let preset = prepare_preset(&root, turn, &gateway.endpoint, &gateway.token, &session)?;
    let cwd = root.parent().ok_or_else(|| error("本机 DSH 目录无效"))?;
    let created = host
        .call(
            "session.create",
            json!({"sessionId":session,"cwd":cwd,"agentPreset":preset.id}),
            &uuid::Uuid::new_v4().to_string(),
        )
        .await?;
    if created["sessionId"] != session || created["agentPreset"] != preset.id {
        return Err(error("本机 DSH 未启用本轮独立工具，未发送对话"));
    }
    let chat = db
        .get_local_chat(id)?
        .ok_or_else(|| error("对话记录不存在"))?;
    // Agent 卡片由流程逐轮驱动；重复附带上轮 JSON 历史会让模型产出非法工具参数。
    let include_history = db.local_chat_turn_uses_history(turn)?;
    let pending = Pending {
        version: 1,
        base: host.base.clone(),
        session,
        rpc_id: uuid::Uuid::new_v4().to_string(),
        after: -1,
    };
    // Save before dispatch: a lost acknowledgement must never create a second model turn.
    db.set_local_chat_provider_turn(turn, &serde_json::to_string(&pending)?)?;
    if *cancel.borrow() {
        return Ok("stopped");
    }
    let accepted=host.call("session.prompt",json!({"sessionId":pending.session,"mode":"queue","content":[{"type":"text","text":dsh::prompt(&chat,turn,include_history)?}]}),&pending.rpc_id).await?;
    if accepted["accepted"] != true {
        return Err(error("本机 DSH 未确认接收，请取回原回复；未自动重发"));
    }
    let start = Instant::now();
    let mut cancellation = None;
    let mut cancel_sent = false;
    let mut saved = String::new();
    loop {
        let reply = fold_history(
            &host.history(&pending).await?,
            &pending.rpc_id,
            pending.after,
        )?;
        if reply.text != saved {
            db.update_local_chat_text(id, turn, &reply.text)?;
            saved = reply.text.clone();
            emit(app, db, id);
        }
        if let Some(status) = reply.status()? {
            return Ok(status);
        }
        if *cancel.borrow() {
            gateway
                .active
                .store(false, std::sync::atomic::Ordering::Release);
            cancellation.get_or_insert_with(Instant::now);
            if !cancel_sent && reply.target.is_some() {
                if reply.latest != reply.target {
                    return Err(error(
                        "本机 DSH 会话已发生变化，未中断其他轮次；请取回原回复",
                    ));
                }
                host.call(
                    "session.cancel",
                    json!({"sessionId":pending.session}),
                    &uuid::Uuid::new_v4().to_string(),
                )
                .await?;
                cancel_sent = true;
            }
        }
        if cancellation.is_some_and(|sent| sent.elapsed() > Duration::from_secs(20)) {
            return Err(error(
                "本机 DSH 尚未确认停止，工具通道已关闭；请稍后取回原回复",
            ));
        }
        if start.elapsed() > Duration::from_secs(1800) {
            return Err(error("本机 DSH 回复等待超时，未自动重发；请取回原回复"));
        }
        tokio::time::sleep(Duration::from_millis(750)).await;
    }
}

pub(super) async fn recover(
    db: &Database,
    id: &str,
    base: &str,
    auth: Option<&str>,
) -> AppResult<()> {
    let (turn, saved) = db.local_chat_recovery(id)?;
    let pending: Pending =
        serde_json::from_str(&saved).map_err(|_| error("原本机 DSH 任务记录不完整"))?;
    if pending.version != 1
        || pending.base != local_base(base)?
        || pending.session != session_id(&turn)
    {
        return Err(error("本机 DSH 服务已改变，请连接原服务后取回回复"));
    }
    let host = Host::connect(base, auth).await?;
    let health = inspect_host(&host).await?;
    let mut reply = if health.live {
        fold_history(&host.events(&pending).await?, &pending.rpc_id, pending.after)?
    } else {
        fold_history(
            &host.history(&pending).await?,
            &pending.rpc_id,
            pending.after,
        )?
    };
    let complete = match reply.status() {
        Ok(Some("done")) => true,
        Ok(Some(_)) => false,
        Err(detail) => {
            reply.text.push_str(&format!("\n\n{detail}"));
            false
        }
        Ok(None) => return Err(error("原本机 DSH 任务尚未结束或无法确认；未重新发送")),
    };
    db.restore_local_chat_reply(id, &turn, &saved, &reply.text, complete)
}

#[cfg(test)]
#[path = "local_chat_dsh_local_tests.rs"]
mod tests;
