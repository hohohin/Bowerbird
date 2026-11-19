//! Read-only app-server model catalog and per-turn settings. No model is invoked here.
use super::*;
use crate::core::local_chat::ChatCodexOptions;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexChatModel {
    pub id: String,
    pub model: String,
    pub display_name: String,
    pub is_default: bool,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<ReasoningOption>,
    #[serde(default, skip_serializing)]
    hidden: bool,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningOption {
    pub reasoning_effort: String,
    pub description: String,
}

pub(super) async fn catalog(
    reader: &mut (impl tokio::io::AsyncBufRead + Unpin),
    writer: &mut (impl AsyncWrite + Unpin),
) -> AppResult<Vec<CodexChatModel>> {
    let mut models = Vec::new();
    let mut cursor = None::<String>;
    let mut seen = HashSet::new();
    for page in 0..20 {
        let result = rpc(
            reader,
            writer,
            100 + page,
            "model/list",
            json!({"cursor":cursor,"limit":100,"includeHidden":false}),
        )
        .await?;
        let batch: Vec<CodexChatModel> = serde_json::from_value(result["data"].clone())
            .map_err(|_| error("Codex 模型列表格式无效，请更新 CLI 后重试"))?;
        if batch.len() > 100 || models.len() + batch.len() > 1000 {
            return Err(error("Codex 模型列表过大，请更新 CLI 后重试"));
        }
        for model in batch.into_iter().filter(|model| !model.hidden) {
            if model.model.is_empty()
                || model.model.len() > 200
                || model.display_name.is_empty()
                || model.supported_reasoning_efforts.len() > 32
                || !model
                    .supported_reasoning_efforts
                    .iter()
                    .any(|effort| effort.reasoning_effort == model.default_reasoning_effort)
            {
                return Err(error("Codex 模型能力不完整，请更新 CLI 后重试"));
            }
            if !models
                .iter()
                .any(|known: &CodexChatModel| known.model == model.model)
            {
                models.push(model);
            }
        }
        if result["nextCursor"].is_null() {
            if models.is_empty() {
                return Err(error("Codex 暂未提供可用模型，请检查登录后重试"));
            }
            return Ok(models);
        }
        let next = result["nextCursor"]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 4096)
            .ok_or_else(|| error("Codex 模型分页无效，请重试"))?
            .to_owned();
        if !seen.insert(next.clone()) {
            return Err(error("Codex 模型分页重复，请重试"));
        }
        cursor = Some(next);
    }
    Err(error("Codex 模型列表过大，请重试"))
}

pub(super) fn resolve(
    options: &ChatCodexOptions,
    models: &[CodexChatModel],
) -> AppResult<ChatCodexOptions> {
    let model = match &options.model {
        Some(value) => models.iter().find(|model| model.model == *value),
        None => models.iter().find(|model| model.is_default),
    }
    .ok_or_else(|| error("所选 Codex 模型已不可用，请重新选择"))?;
    let effort = options
        .reasoning_effort
        .as_ref()
        .unwrap_or(&model.default_reasoning_effort);
    if !model
        .supported_reasoning_efforts
        .iter()
        .any(|supported| supported.reasoning_effort == *effort)
    {
        return Err(error("所选 Codex 模型不支持该推理强度，请重新选择"));
    }
    Ok(ChatCodexOptions {
        model: Some(model.model.clone()),
        reasoning_effort: Some(effort.clone()),
    })
}

pub(super) fn apply_thread(params: &mut Value, options: &ChatCodexOptions) {
    if let Some(model) = &options.model {
        params["model"] = json!(model);
    }
    if let Some(effort) = &options.reasoning_effort {
        params["config"]["model_reasoning_effort"] = json!(effort);
    }
}
pub(super) fn apply_turn(params: &mut Value, options: &ChatCodexOptions) {
    if let Some(model) = &options.model {
        params["model"] = json!(model);
    }
    if let Some(effort) = &options.reasoning_effort {
        params["effort"] = json!(effort);
    }
}

pub(super) async fn load(binary: &str) -> AppResult<Vec<CodexChatModel>> {
    let root = codex_home()
        .ok_or_else(|| error("Codex 资料目录不可用"))?
        .join("chat-workspaces")
        .join("model-catalog");
    std::fs::create_dir_all(&root)?;
    let mut child = command(binary, &root)
        .spawn()
        .map_err(|_| error("Codex 无法启动，请检查设置中的安装"))?;
    let mut writer = child
        .stdin
        .take()
        .ok_or_else(|| error("Codex 输入连接不可用"))?;
    let mut reader = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| error("Codex 输出连接不可用"))?,
    );
    let stderr = tokio::spawn(read_stderr(
        child
            .stderr
            .take()
            .ok_or_else(|| error("Codex 诊断连接不可用"))?,
    ));
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        rpc(&mut reader,&mut writer,1,"initialize",json!({"clientInfo":{"name":"bowerbird","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}})).await?;
        write_message(&mut writer,json!({"method":"initialized","params":{}})).await?;
        catalog(&mut reader, &mut writer).await
    }).await.map_err(|_|error("Codex 模型列表读取超时，请检查登录后重试"));
    let _ = child.kill().await;
    let _ = child.wait().await;
    stderr.abort();
    result?
}

#[cfg(test)]
#[path = "local_chat_models_tests.rs"]
mod tests;
