//! Read-only official CLI capabilities and credits. Never submits a generation.
use crate::codex::jimeng::{dreamina_command, resolve_dreamina_binary};
use crate::error::{AppError, AppResult};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

async fn read(args: &[&str]) -> AppResult<String> {
    let binary = resolve_dreamina_binary()
        .ok_or_else(|| AppError::Jimeng("未检测到即梦 CLI，请在设置中安装".into()))?;
    let out = tokio::time::timeout(Duration::from_secs(30), dreamina_command(&binary)
        .args(args).kill_on_drop(true).output()).await
        .map_err(|_| AppError::Jimeng("即梦查询超时，请重试".into()))?
        .map_err(|_| AppError::Jimeng("无法启动即梦查询".into()))?;
    if !out.status.success() {
        return Err(AppError::Jimeng("即梦查询失败，请检查网络或在设置中重新登录即梦".into()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn json(text: &str) -> AppResult<Value> {
    let start = text.find(['{', '[']).ok_or_else(|| AppError::Jimeng("即梦未返回有效数据".into()))?;
    serde_json::Deserializer::from_str(&text[start..]).into_iter().next()
        .ok_or_else(|| AppError::Jimeng("即梦返回空数据".into()))?
        .map_err(|_| AppError::Jimeng("无法解析即梦数据，请更新官方 CLI".into()))
}

fn credit(value: &Value) -> Option<f64> {
    value.as_f64().filter(|v| v.is_finite() && *v >= 0.0)
}

#[tauri::command]
pub async fn dreamina_credit_balance() -> AppResult<f64> {
    let value = json(&read(&["user_credit"]).await?)?;
    value.get("total_credit").and_then(credit)
        .ok_or_else(|| AppError::Jimeng("即梦未返回剩余积分".into()))
}

// Exact task identity is mandatory: a neighboring task or account balance is not a bill.
fn task_credit(value: &Value, id: &str) -> Option<f64> {
    match value {
        Value::Object(map) if map.contains_key("submit_id") => {
            if map.get("submit_id").and_then(Value::as_str) != Some(id) { return None; }
            map.get("commerce_info")?.get("credit_count").and_then(credit)
        }
        Value::Object(map) => map.values().find_map(|v| task_credit(v, id)),
        Value::Array(items) => items.iter().find_map(|v| task_credit(v, id)),
        _ => None,
    }
}

#[tauri::command]
pub async fn dreamina_task_credit(submit_id: String) -> AppResult<Option<f64>> {
    if submit_id.is_empty() || submit_id.len() > 200 || !submit_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(AppError::Jimeng("无效的即梦任务编号".into()));
    }
    let value = json(&read(&["list_task", "--submit_id", &submit_id, "--limit", "1"]).await?)?;
    Ok(task_credit(&value, &submit_id))
}

#[derive(Serialize, Debug)]
pub struct VideoModelCapability {
    model_version: String,
    resolutions: Vec<String>,
    min_duration: u32,
    max_duration: u32,
}

fn capabilities(help: &str) -> Vec<VideoModelCapability> {
    let models = help.lines().find(|line| line.trim_start().starts_with("--model_version ")).unwrap_or("");
    let models = models.split("supported values:").nth(1).unwrap_or("").split(';').next().unwrap_or("");
    let supported: Vec<_> = models.split(',').map(str::trim).collect();
    ["seedance2.5", "seedance2.0", "seedance2.0fast", "seedance2.0_vip", "seedance2.0fast_vip", "seedance2.0mini", "seedance1.5pro", "seedance1.0fast"]
        .into_iter().filter(|model| supported.contains(model)).map(|model| {
            let range = match model { "seedance2.5" => (4, 30), "seedance1.5pro" => (5, 12), "seedance1.0fast" => (5, 10), _ => (4, 15) };
            let line = help.lines().find(|line| line.trim_start().starts_with(&format!("- {model} ->"))).unwrap_or("");
            let resolutions = ["480p", "720p", "1080p", "4k"].into_iter()
                .filter(|r| if line.contains("video_resolution") { line.contains(r) } else { *r == "720p" })
                .map(String::from).collect();
            VideoModelCapability { model_version: model.into(), resolutions, min_duration: range.0, max_duration: range.1 }
        }).collect()
}

#[tauri::command]
pub async fn dreamina_video_models(kind: String) -> AppResult<Vec<VideoModelCapability>> {
    if !matches!(kind.as_str(), "text2video" | "image2video" | "frames2video" | "multimodal2video") {
        return Err(AppError::Jimeng("不支持此视频模式".into()));
    }
    let models = capabilities(&read(&[&kind, "--help"]).await?);
    if models.is_empty() { return Err(AppError::Jimeng("无法读取官方视频模型，请更新即梦 CLI".into())); }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credits_require_exact_task_and_explicit_numeric_amount() {
        let value = serde_json::json!({"tasks":[
            {"submit_id":"other","commerce_info":{"credit_count":999}},
            {"submit_id":"mine","commerce_info":{"credit_count":0}}
        ]});
        assert_eq!(task_credit(&value, "mine"), Some(0.0));
        assert_eq!(task_credit(&value, "missing"), None);
        for amount in [serde_json::json!(-1), Value::Null, serde_json::json!("240")] {
            assert_eq!(task_credit(&serde_json::json!({"submit_id":"mine","commerce_info":{"credit_count":amount}}), "mine"), None);
        }
        assert_eq!(task_credit(&serde_json::json!({"submit_id":"mine","credit_count":240}), "mine"), None);
        assert_eq!(task_credit(&json("notice\n[{\"submit_id\":\"mine\",\"commerce_info\":{\"credit_count\":240}}]").unwrap(), "mine"), Some(240.0));
    }
    #[test]
    fn official_help_limits_models_and_resolutions() {
        let help = "- seedance2.5 -> video_resolution 480p, 720p, or 1080p; duration 4-30s\n- seedance2.0_vip -> video_resolution 720p, 1080p, or 4k; duration 4-15s\n --model_version string supported values: seedance2.5, seedance2.0_vip, seedance1.5pro; default: seedance2.5";
        let models = capabilities(help);
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].resolutions, ["480p", "720p", "1080p"]);
        assert_eq!(models[1].resolutions, ["720p", "1080p", "4k"]);
        assert_eq!(models[2].min_duration, 5);
        assert_eq!(models[2].max_duration, 12);
        assert_eq!(capabilities(&help.replace(", or 1080p", ""))[0].resolutions, ["480p", "720p"]);
        assert!(capabilities("unrecognized help").is_empty());
    }
}
