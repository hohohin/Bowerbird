// Agent DS（dev-only）：创作板 → 投递「本机 DSH 队列」+ 自动送达本机 DSH 会话。
//
// 定位与 Agent Z/G 同类（harness 拥有模型多回合、上下文与工具选择），区别在**不在此拉起
// harness**：Bowerbird 只把「本条消息 + 参考图绝对路径」写成一份 payload 落到
// `.agent-z/ds-inbox/pending/`，真正干活的是用户原本就开着的那条 DSH 会话（全量工具面、
// 已有上下文）——它读这份 payload、按需直接读图/调 rpc 反推，不占生成 job/ratio/provider/
// entitlement，也不经 DeepSeek key。因此本条命令不依赖 apps/cloud/.env、DSH profile 或 node
// 子进程。
//
// 两条投递腿（文件是权威，HTTP 只是"叫醒"）：
//   1) 落盘：`.agent-z/ds-inbox/pending/<毫秒>-<ulid>.json`（先写 .tmp 再改名）；
//   2) 自动送达：`POST <DSH_WEB_URL>/api/session.prompt`（信封 `{type:"client-request",
//      rpcId, method, payload}`）把同一内容作为一轮 user 消息投进**活着的** GUI 会话——
//      host 侧用 `ctx.agents.get(sessionId)` 命中活 Agent，因此消息直接出现在用户眼前并
//      唤起该轮。目标会话由 `POST /api/session.list` 发现（见 pick_target_session）。
//   第 2 腿失败（GUI 没开、端口变了、找不到匹配会话）只降级为"留在队列等人工 drain"，
//   不阻塞发送；结果回写进 payload 的 `delivery` 字段，进 archive 时自带审计。
//
// 契约（消费方 = DSH 会话）：
//   pending/  新投递（文件名 = <毫秒>-<ulid>.json，名字排序即时间序）
//   archive/  已处理（消费方搬过去，作为「实际交给 harness 的原文」留档）
//   payload v1：{version, kind, createdAt, visualProfileId, message, text, images[{path,name}],
//                delivery?{sessionId, delivered, notice}}
//   message = 用户在创作板输入的原文；text = 注入视觉规范后的实际投递正文（无注入时相同）。
// 本文件只写 pending；archive 由消费方维护。详见 dev-doc/UNIFIED-AGENT-HARNESS-PLAN.md。
//
// 历史：2026-09-21 曾改为 detached CLI 拉起钉版 DSH（ACP，仅 dreamina_generate /
// understand_asset 两个工具，每轮 fresh session + transcript 注入）；该路径及其
// `ds-session.json` 已不参与投递，代码保留待必要时回收。

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::error::AppError;

/// 本机 DSH Web 地址（默认 `dsh web` 的缺省端口）；可用环境变量覆盖以指向别的实例。
const DSH_WEB_URL_ENV: &str = "BOWERBIRD_DSH_WEB_URL";
const DEFAULT_DSH_WEB_URL: &str = "http://127.0.0.1:3080";
/// 自动送达是「叫醒」而不是本轮工作的终点，超时必须短：失败就退回队列语义。
const DSH_RPC_TIMEOUT: Duration = Duration::from_secs(8);

fn ensure_preview_enabled() -> Result<(), AppError> {
    if cfg!(debug_assertions) {
        Ok(())
    } else {
        Err(AppError::Other("Agent DS 仅在开发构建中开放".into()))
    }
}

/// Agent 互通实验资产目录（与 agent_z.rs 的 agent_z_root 同式：目录名 `.agent-z` 为历史，
/// 语义 = Agent 互通实验资产）。
fn agent_root() -> PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(".agent-z")
}

/// 投递根目录（pending/archive 的父目录）。
fn delivery_root() -> PathBuf {
    agent_root().join("ds-inbox")
}

/// 仓库根：目标会话的 cwd 过滤条件（DSH 会话跑在本仓库里才拿得到项目上下文）。
fn repo_root() -> PathBuf {
    agent_root().join("..")
}

/// 一条投递里的一张参考图：绝对路径 + 素材名（名字用于把正文里的 `@素材名` 与
/// ULID 存储文件名对号；前端缺名时为 null）。
#[derive(Debug, Clone, Serialize, PartialEq)]
struct DeliveryImage {
    path: String,
    name: Option<String>,
}

/// 自动送达结果（写进 payload 的 `delivery`，让 archive 自带审计）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct DeliveryReceipt {
    session_id: Option<String>,
    delivered: bool,
    /// 未送达原因（给用户看的短句，来自 HTTP/RPC 层）。
    notice: Option<String>,
}

/// 投递 payload v1（camelCase，与 `.agent-z/ds-session.json` 同风格）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct DeliveryPayload {
    version: u32,
    kind: &'static str,
    created_at: String,
    visual_profile_id: Option<String>,
    /// 用户在创作板里输入的原文（未注入视觉规范）。
    message: String,
    /// 实际投递正文：视觉规范 capsule 已注入（无注入时等于 message）。
    text: String,
    images: Vec<DeliveryImage>,
    /// 自动送达结果；落盘时未知，送达尝试后回写。
    delivery: Option<DeliveryReceipt>,
}

/// 命令返回值：前端据此提示「送到哪了 / 为什么没送到」。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryOutcome {
    pub path: String,
    pub session_id: Option<String>,
    pub session_title: Option<String>,
    pub auto_delivered: bool,
    pub notice: Option<String>,
}

/// 组装 payload（纯函数，单测覆盖）。`text` 是 Rust 侧已注入视觉规范后的正文。
fn build_delivery_payload(
    message: &str,
    text: &str,
    images: &[String],
    names: &[String],
    visual_profile_id: Option<&str>,
    created_at: String,
) -> DeliveryPayload {
    DeliveryPayload {
        version: 1,
        kind: "bowerbird-agent-ds-delivery",
        created_at,
        visual_profile_id: visual_profile_id.map(str::to_string),
        message: message.to_string(),
        text: text.to_string(),
        images: images
            .iter()
            .enumerate()
            .map(|(index, path)| DeliveryImage {
                path: path.clone(),
                name: names
                    .get(index)
                    .map(|name| name.trim())
                    .filter(|name| !name.is_empty())
                    .map(str::to_string),
            })
            .collect(),
        delivery: None,
    }
}

/// 投递给 DSH 会话的正文：来源标记 + 用户原文 + 参考图（名称 → 绝对路径）。
/// 图片只给路径：接收端模型未必声明 image 输入，看图由它自行走 rpc 反推或换模型。
fn compose_delivery_turn(payload: &DeliveryPayload) -> String {
    let mut text = format!("[Agent DS] {}", payload.message.trim());
    for (index, image) in payload.images.iter().enumerate() {
        match image.name.as_deref() {
            Some(name) => text.push_str(&format!("\n参考图{}（{}）：{}", index + 1, name, image.path)),
            None => text.push_str(&format!("\n参考图{}：{}", index + 1, image.path)),
        }
    }
    text
}

/// 路径文本归一化：统一分隔符、去掉 Windows `\\?\` 前缀、去尾分隔符、小写——
/// 只用于把 session.list 报的 cwd 与本地仓库根比较（两侧来源不同，必须同规）。
fn normalize_path_text(text: &str) -> String {
    let slashed = text.replace('\\', "/");
    let stripped = slashed.strip_prefix("//?/").unwrap_or(&slashed).to_string();
    stripped.trim_end_matches('/').to_lowercase()
}

/// 本地路径归一化：先 canonicalize 再按同一规则比较（本仓库根通常带 `..` 未展开）。
fn normalized_local_path(path: &Path) -> String {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    normalize_path_text(&canonical.to_string_lossy())
}

/// 从 `session.list` 的 `result.value` 里挑目标会话：排除子代理（`origin: "subagent"`）
/// 与空白会话，要求 cwd 与仓库根一致，取 `updatedAt` 最大者（同刻并列时 running 优先）。
/// 用户正在看的那条会话通常就是 cwd 命中里最近更新的那条。
fn pick_target_session(value: &Value, repo_root_normalized: &str) -> Option<(String, Option<String>)> {
    let items = value.get("items")?.as_array()?;
    let mut best: Option<(i64, bool, String, Option<String>)> = None;
    for item in items {
        if item.get("origin").and_then(Value::as_str).is_some() {
            continue;
        }
        if item.get("blank").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let Some(cwd) = item.get("cwd").and_then(Value::as_str) else {
            continue;
        };
        if normalize_path_text(cwd) != repo_root_normalized {
            continue;
        }
        let Some(session_id) = item.get("sessionId").and_then(Value::as_str) else {
            continue;
        };
        let updated_at = item.get("updatedAt").and_then(Value::as_i64).unwrap_or(0);
        let running = item.get("running").and_then(Value::as_bool).unwrap_or(false);
        let title = item
            .get("projections")
            .and_then(|projections| projections.get("values"))
            .and_then(|values| values.get("title"))
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
            .map(str::to_string);
        let better = match &best {
            None => true,
            Some((best_at, best_running, _, _)) => {
                updated_at > *best_at || (updated_at == *best_at && running && !*best_running)
            }
        };
        if better {
            best = Some((updated_at, running, session_id.to_string(), title));
        }
    }
    best.map(|(_, _, session_id, title)| (session_id, title))
}

/// 原子落盘一份投递：先写 `.tmp` 再改名，避免消费方读到半个文件。
fn write_json_atomic(target: &Path, payload: &DeliveryPayload) -> Result<(), AppError> {
    let parent = target
        .parent()
        .ok_or_else(|| AppError::Other("Agent DS 投递路径无父目录".into()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| AppError::Other(format!("创建 Agent DS 投递目录失败: {error}")))?;
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "delivery.json".into());
    let temp = parent.join(format!("{name}.tmp"));
    let bytes = serde_json::to_vec_pretty(payload)
        .map_err(|error| AppError::Other(format!("序列化 Agent DS 投递失败: {error}")))?;
    std::fs::write(&temp, bytes)
        .map_err(|error| AppError::Other(format!("写出 Agent DS 投递失败: {error}")))?;
    // Windows 下 std::fs::rename 走 MoveFileEx(REPLACE_EXISTING)，可覆盖回写同一路径。
    std::fs::rename(&temp, target)
        .map_err(|error| AppError::Other(format!("提交 Agent DS 投递失败: {error}")))?;
    Ok(())
}

/// 首次落盘：返回写入的绝对路径（前端提示里显示，便于用户自己打开看原文）。
fn write_delivery(root: &Path, payload: &DeliveryPayload) -> Result<PathBuf, AppError> {
    std::fs::create_dir_all(root.join("archive"))
        .map_err(|error| AppError::Other(format!("创建 Agent DS 归档目录失败: {error}")))?;
    let name = format!(
        "{}-{}.json",
        chrono::Local::now().timestamp_millis(),
        ulid::Ulid::new()
    );
    let target = root.join("pending").join(name);
    write_json_atomic(&target, payload)?;
    Ok(target)
}

/// 一个 DSH Web `/api` 一元 RPC：信封 `{type:"client-request", rpcId, method, payload}`，
/// 成功取其 `result.value`，业务失败（`result.ok=false`）转成可读短句。
async fn dsh_rpc(
    client: &reqwest::Client,
    base: &str,
    method: &str,
    payload: Value,
) -> Result<Value, String> {
    let rpc_id = format!("agent-ds-{}", ulid::Ulid::new());
    let body = json!({
        "type": "client-request",
        "rpcId": rpc_id,
        "method": method,
        "payload": payload,
    });
    let response = client
        .post(format!("{}/api/{method}", base.trim_end_matches('/')))
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("连接本机 DSH 失败（{}）", error_text(&error.to_string())))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("本机 DSH 返回 HTTP {}", status.as_u16()));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("解析本机 DSH 响应失败（{}）", error_text(&error.to_string())))?;
    let result = value.get("result").cloned().unwrap_or(Value::Null);
    if result.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(result.get("value").cloned().unwrap_or(Value::Null))
    } else {
        Err(error_text(&result.get("error").map(Value::to_string).unwrap_or_default()))
    }
}

/// 错误文本收敛：提示条要短，且不把整段 HTML/JSON 塞进 toast。
fn error_text(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "未知错误".into();
    }
    let mut clipped: String = trimmed.chars().take(180).collect();
    if trimmed.chars().count() > 180 {
        clipped.push('…');
    }
    clipped
}

/// 自动送达：发现目标会话并把本轮作为一条 user 消息投进去（`mode: "queue"`，忙时排队
/// 而不是打断当前轮）。返回（sessionId, 标题）。
async fn deliver_to_dsh(
    payload: &DeliveryPayload,
    repo_root_normalized: &str,
) -> Result<(String, Option<String>), String> {
    let base = std::env::var(DSH_WEB_URL_ENV).unwrap_or_else(|_| DEFAULT_DSH_WEB_URL.to_string());
    let client = reqwest::Client::builder()
        .timeout(DSH_RPC_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let list = dsh_rpc(&client, &base, "session.list", json!({})).await?;
    let (session_id, title) = pick_target_session(&list, repo_root_normalized)
        .ok_or_else(|| format!("未找到 cwd 为本仓库的 DSH 会话（{repo_root_normalized}）"))?;
    dsh_rpc(
        &client,
        &base,
        "session.prompt",
        json!({
            "sessionId": session_id,
            "mode": "queue",
            "content": [{ "type": "text", "text": compose_delivery_turn(payload) }],
        }),
    )
    .await?;
    Ok((session_id, title))
}

#[tauri::command]
pub async fn agent_ds_chat(
    db: tauri::State<'_, std::sync::Arc<crate::db::Database>>,
    text: String,
    images: Vec<String>,
    // 与 images 同序的素材名（正文 @名 与路径对号）；缺省 / 长度不齐退化为纯路径。
    image_names: Option<Vec<String>>,
    visual_profile_id: Option<String>,
) -> Result<DeliveryOutcome, AppError> {
    ensure_preview_enabled()?;
    let message = text.trim().to_string();
    if message.is_empty() || message.chars().count() > 12_000 {
        return Err(AppError::Other("消息须为 1–12000 个字符".into()));
    }
    if images.len() > 10 {
        return Err(AppError::Other("Agent DS 最多附带 10 张参考图".into()));
    }
    let text = match visual_profile_id.as_deref() {
        Some(id) => crate::core::visual_profile::inject_visual_profile_prompt(
            &message,
            &db.visual_profile_capsule(id)?,
        ),
        None => message.clone(),
    };
    let mut payload = build_delivery_payload(
        &message,
        &text,
        &images,
        &image_names.unwrap_or_default(),
        visual_profile_id.as_deref(),
        chrono::Local::now().to_rfc3339(),
    );
    // 先落盘：HTTP 那一腿失败也不能丢件。
    let path = write_delivery(&delivery_root(), &payload)?;
    let repo = normalized_local_path(&repo_root());
    let (session_id, session_title, notice) = match deliver_to_dsh(&payload, &repo).await {
        Ok((session_id, title)) => (Some(session_id), title, None),
        Err(reason) => (None, None, Some(reason)),
    };
    let auto_delivered = notice.is_none();
    payload.delivery = Some(DeliveryReceipt {
        session_id: session_id.clone(),
        delivered: auto_delivered,
        notice: notice.clone(),
    });
    // 回写送达结果；失败不影响已完成的投递（archive 里只是少一条注记）。
    if let Err(error) = write_json_atomic(&path, &payload) {
        tracing::warn!("回写 Agent DS 送达结果失败: {error}");
    }
    Ok(DeliveryOutcome {
        path: path.to_string_lossy().into_owned(),
        session_id,
        session_title,
        auto_delivered,
        notice,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agent-ds-{label}-{}-{}",
            std::process::id(),
            ulid::Ulid::new()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_payload() -> DeliveryPayload {
        build_delivery_payload(
            "@海报.jpg 改造调性",
            "[视觉规范] …\n@海报.jpg 改造调性",
            &["D:/lib/a.png".into(), "D:/lib/b.png".into()],
            &["海报.jpg".into(), "  ".into()],
            Some("vp-1"),
            "2026-09-22T02:03:56+08:00".into(),
        )
    }

    #[test]
    fn payload_pairs_images_with_names_and_keeps_raw_message() {
        let payload = sample_payload();
        assert_eq!(payload.version, 1);
        assert_eq!(payload.kind, "bowerbird-agent-ds-delivery");
        assert_eq!(payload.message, "@海报.jpg 改造调性");
        assert!(payload.text.starts_with("[视觉规范]"));
        assert_eq!(payload.visual_profile_id.as_deref(), Some("vp-1"));
        assert_eq!(payload.delivery, None);
        assert_eq!(
            payload.images,
            vec![
                DeliveryImage { path: "D:/lib/a.png".into(), name: Some("海报.jpg".into()) },
                // 空白名退化为纯路径，不写空串
                DeliveryImage { path: "D:/lib/b.png".into(), name: None },
            ]
        );
    }

    #[test]
    fn payload_without_visual_profile_leaves_text_equal_to_message() {
        let payload = build_delivery_payload(
            "只画一只猫",
            "只画一只猫",
            &[],
            &[],
            None,
            "2026-09-22T02:03:56+08:00".into(),
        );
        assert_eq!(payload.text, payload.message);
        assert!(payload.visual_profile_id.is_none());
        assert!(payload.images.is_empty());
    }

    #[test]
    fn delivery_turn_marks_origin_and_lists_images_with_names() {
        let turn = compose_delivery_turn(&sample_payload());
        assert_eq!(
            turn,
            "[Agent DS] @海报.jpg 改造调性\n参考图1（海报.jpg）：D:/lib/a.png\n参考图2：D:/lib/b.png"
        );
    }

    #[test]
    fn delivery_writes_camel_case_json_into_pending_and_sorts_by_name() {
        let root = temp_root("write");
        let first = write_delivery(&root, &sample_payload()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let second = write_delivery(&root, &sample_payload()).unwrap();
        assert!(first.is_file() && second.is_file());
        assert!(first.parent().unwrap().ends_with("pending"));
        assert!(root.join("archive").is_dir());
        let mut names: Vec<String> = std::fs::read_dir(root.join("pending"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names.len(), 2);
        assert!(names[0].starts_with(first.file_name().unwrap().to_str().unwrap()));
        let raw = std::fs::read_to_string(&second).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["kind"], "bowerbird-agent-ds-delivery");
        assert!(parsed.get("createdAt").is_some());
        assert_eq!(parsed["images"].as_array().unwrap().len(), 2);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn delivery_receipt_rewrites_same_file_without_leaving_temp() {
        let root = temp_root("receipt");
        let mut payload = sample_payload();
        let path = write_delivery(&root, &payload).unwrap();
        payload.delivery = Some(DeliveryReceipt {
            session_id: Some("session-abc".into()),
            delivered: true,
            notice: None,
        });
        write_json_atomic(&path, &payload).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["delivery"]["sessionId"], "session-abc");
        assert_eq!(parsed["delivery"]["delivered"], true);
        // 回写不留 .tmp、不改文件名（archive 契约按文件名排序）
        let leftovers: Vec<String> = std::fs::read_dir(root.join("pending"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers.len(), 1);
        assert!(!leftovers[0].ends_with(".tmp"));
        assert_eq!(leftovers[0], path.file_name().unwrap().to_string_lossy());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn target_session_skips_subagents_blank_and_other_cwds_and_takes_newest() {
        let list = serde_json::json!({
            "items": [
                // 子代理会话：更新更近，也必须排除
                { "sessionId": "sub-1", "origin": "subagent", "cwd": "D:\\Repo", "updatedAt": 900, "running": false },
                { "sessionId": "blank-1", "blank": true, "cwd": "D:\\Repo", "updatedAt": 800, "running": false },
                { "sessionId": "other-cwd", "cwd": "D:\\Elsewhere", "updatedAt": 850, "running": false },
                { "sessionId": "older", "cwd": "D:\\Repo", "updatedAt": 100, "running": false,
                  "projections": { "values": { "title": "旧会话" } } },
                { "sessionId": "newest", "cwd": "d:/repo/", "updatedAt": 500, "running": true,
                  "projections": { "values": { "title": "当前会话" } } }
            ]
        });
        assert_eq!(
            pick_target_session(&list, "d:/repo"),
            Some(("newest".to_string(), Some("当前会话".to_string())))
        );
        // running 不压过更新的 updatedAt
        let list = serde_json::json!({
            "items": [
                { "sessionId": "running-old", "cwd": "D:/repo", "updatedAt": 10, "running": true },
                { "sessionId": "idle-new", "cwd": "D:/repo", "updatedAt": 20, "running": false }
            ]
        });
        assert_eq!(pick_target_session(&list, "d:/repo"), Some(("idle-new".to_string(), None)));
        // 无匹配 cwd / 空列表 → 不猜
        assert_eq!(pick_target_session(&list, "d:/other"), None);
        assert_eq!(pick_target_session(&serde_json::json!({ "items": [] }), "d:/repo"), None);
    }

    #[test]
    fn path_normalization_ignores_separators_prefix_and_case() {
        assert_eq!(normalize_path_text(r"\\?\D:\Repo\"), "d:/repo");
        assert_eq!(normalize_path_text("d:/repo"), "d:/repo");
        assert_eq!(normalize_path_text("D:\\Repo"), "d:/repo");
    }
}
