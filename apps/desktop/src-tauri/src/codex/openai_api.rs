//! OpenAI Images API 生图 spike（非 codex CLI 路线）。
//!
//! 独立于 [`crate::codex::CodexProvider`] trait：直接验证 OpenAI API（`gpt-image-1`）
//! 生图能否在 Bowerbird 跑通——API 调用 → `b64_json` → 解码落盘成临时 PNG → 由
//! command 层 `ingest_generated` 进库。**不接 trait、不动 codex CLI 主线**；跑通后
//! 正式整合（settings + provider 抽象 + UI）是独立后续工作。
//!
//! 凭证经环境变量：`OPENAI_API_KEY`（必需）、`OPENAI_BASE_URL`（可选，默认官方端点，
//! 设中转/兼容网关时用）。HTTP client 默认读 `HTTPS_PROXY`/`https_proxy`（reqwest 行为，
//! 不读系统代理——见 PROJECT.md 踩坑）。

use std::path::PathBuf;
use std::time::Duration;

use base64::Engine;
use ulid::Ulid;

use crate::error::AppError;

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_MODEL: &str = "gpt-image-1";
/// OpenAI `/v1/images/edits` 参考图上限（gpt-image-1）。
const MAX_REF_IMAGES: usize = 16;

pub struct OpenAiImageReq {
    pub prompt: String,
    /// 空 → `/images/generations`（纯文生图）；非空 → `/images/edits`（带参考图，最多 16）。
    pub reference_images: Vec<PathBuf>,
    pub n: u32,
    /// `1024x1024` | `1024x1536` | `1536x1024` | `auto`。
    pub size: String,
    /// `low` | `medium` | `high` | `auto`。
    pub quality: String,
    /// 空串 → 默认 `gpt-image-1`。
    pub model: String,
}

/// 调 OpenAI Images API 生图，把返回的 `b64_json` 解码落盘成临时 PNG，返回源图路径列表
/// （由 command 层 `ingest_generated` 进库）。错误统一带 HTTP 状态 + 响应体摘要，
/// 429 / reset / key 缺失一眼可见。
pub async fn generate_images(req: OpenAiImageReq) -> Result<Vec<PathBuf>, AppError> {
    let api_key = std::env::var("OPENAI_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Codex("未设置 OPENAI_API_KEY 环境变量".into()))?;
    let base_url = std::env::var("OPENAI_BASE_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
    let model = if req.model.trim().is_empty() {
        DEFAULT_MODEL.to_string()
    } else {
        req.model
    };

    // gpt-image-1 复杂编辑/多图官方报告常接近 180s，给宽一些。
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| AppError::Codex(format!("构建 HTTP client 失败: {e}")))?;

    let resp = if req.reference_images.is_empty() {
        // 纯文生图：JSON body。
        let body = serde_json::json!({
            "model": model,
            "prompt": req.prompt,
            "n": req.n,
            "size": req.size,
            "quality": req.quality,
        });
        client
            .post(format!("{base_url}/images/generations"))
            .bearer_auth(&api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Codex(format!("OpenAI generations 请求失败: {e}")))?
    } else {
        // 带参考图编辑：multipart。gpt-image-1 多图用重复的 `image` 字段。
        if req.reference_images.len() > MAX_REF_IMAGES {
            tracing::warn!(
                "OpenAI edits 参考图 {} 张超过上限 {MAX_REF_IMAGES}，已截断",
                req.reference_images.len()
            );
        }
        let mut form = reqwest::multipart::Form::new()
            .text("model", model)
            .text("prompt", req.prompt.clone())
            .text("n", req.n.to_string())
            .text("size", req.size.clone())
            .text("quality", req.quality.clone());
        for p in req.reference_images.iter().take(MAX_REF_IMAGES) {
            let bytes = tokio::fs::read(p)
                .await
                .map_err(|e| AppError::Codex(format!("读取参考图 {} 失败: {e}", p.display())))?;
            let fname = p
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("ref.png")
                .to_string();
            let part = reqwest::multipart::Part::bytes(bytes)
                .file_name(fname)
                .mime_str(guess_mime(p))
                .map_err(|e| AppError::Codex(format!("构造 multipart 失败: {e}")))?;
            form = form.part("image", part);
        }
        client
            .post(format!("{base_url}/images/edits"))
            .bearer_auth(&api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|e| AppError::Codex(format!("OpenAI edits 请求失败: {e}")))?
    };

    // 先按文本取 body：成功失败都要能读（错误体同样在 body 里）。
    let status = resp.status();
    let body_text = resp
        .text()
        .await
        .map_err(|e| AppError::Codex(format!("读取 OpenAI 响应失败: {e}")))?;
    if !status.is_success() {
        let head: String = body_text.trim().chars().take(500).collect();
        return Err(AppError::Codex(format!(
            "OpenAI 返回 HTTP {} | {head}",
            status.as_u16()
        )));
    }

    let v: serde_json::Value = serde_json::from_str(&body_text).map_err(|e| {
        let head: String = body_text.trim().chars().take(300).collect();
        AppError::Codex(format!("解析 OpenAI 响应 JSON 失败: {e} | body: {head}"))
    })?;
    let data = v.get("data").and_then(|d| d.as_array()).ok_or_else(|| {
        let head: String = body_text.trim().chars().take(300).collect();
        AppError::Codex(format!("OpenAI 响应无 data 数组 | body: {head}"))
    })?;

    let mut out = Vec::new();
    for item in data {
        let b64 = item
            .get("b64_json")
            .and_then(|b| b.as_str())
            .ok_or_else(|| AppError::Codex("OpenAI 响应 data 项无 b64_json（gpt-image-1 应返回 base64）".into()))?;
        let img_bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| AppError::Codex(format!("base64 解码失败: {e}")))?;
        let path = std::env::temp_dir().join(format!("bb-oai-{}.png", Ulid::new()));
        tokio::fs::write(&path, &img_bytes)
            .await
            .map_err(|e| AppError::Codex(format!("写入临时图失败: {e}")))?;
        out.push(path);
    }
    Ok(out)
}

/// 按扩展名猜参考图 MIME（OpenAI edits 接受 png/jpeg/webp；其余按 png 兜底）。
fn guess_mime(p: &std::path::Path) -> &'static str {
    match p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "image/png",
    }
}
