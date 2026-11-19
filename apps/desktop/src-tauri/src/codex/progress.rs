//! Observable execution phases, never time-derived generation percentages.
use super::types::Chunk;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GenerationStage {
    Submitting,
    Processing,
    Queued,
    Generating,
    ToolRunning,
    Querying,
    Saving,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GenerationProgress {
    pub stage: GenerationStage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_position: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_length: Option<u64>,
}

impl GenerationProgress {
    pub fn new(stage: GenerationStage) -> Self {
        Self {
            stage,
            queue_position: None,
            queue_length: None,
        }
    }

    pub fn dreamina(value: &Value) -> Option<Self> {
        // Finish also occurs on failed tasks: only querying describes live work.
        if value["gen_status"].as_str() != Some("querying") {
            return None;
        }
        let queue = &value["queue_info"];
        if queue["queue_status"].as_str() == Some("Finish") {
            return Some(Self::new(GenerationStage::Processing));
        }
        let position = queue["queue_idx"].as_u64().filter(|n| *n > 0);
        let length = queue["queue_length"].as_u64().filter(|n| *n > 0);
        // No assumption about whether queue_idx is zero- or one-based: display
        // the upstream position, never translate it into "people ahead" or %.
        if let (Some(position), Some(length)) = (position, length) {
            if position <= length {
                return Some(Self {
                    stage: GenerationStage::Queued,
                    queue_position: Some(position),
                    queue_length: Some(length),
                });
            }
        }
        Some(Self::new(GenerationStage::Processing))
    }

    pub fn codex(value: &Value) -> Option<Self> {
        let event = value["type"].as_str()?;
        if event == "turn.started" {
            return Some(Self::new(GenerationStage::Processing));
        }
        let item = &value["item"];
        match (event, item["type"].as_str()?) {
            ("item.started" | "item.updated", "image_generation") => {
                Some(Self::new(GenerationStage::Generating))
            }
            ("item.started", "mcp_tool_call" | "command_execution" | "dynamic_tool_call") => {
                Some(Self::new(GenerationStage::ToolRunning))
            }
            (
                "item.completed",
                "image_generation" | "mcp_tool_call" | "command_execution" | "dynamic_tool_call",
            ) => Some(Self::new(GenerationStage::Processing)),
            _ => None,
        }
    }
}

pub async fn send(tx: Option<&mpsc::Sender<Chunk>>, progress: GenerationProgress) {
    if let Some(tx) = tx {
        let _ = tx.send(Chunk::Progress { progress }).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn queue_is_not_generation_percentage_or_terminal_success() {
        let value = json!({"gen_status":"querying","queue_info":{"queue_idx":3,"queue_length":9}});
        let progress = GenerationProgress::dreamina(&value).unwrap();
        assert_eq!(progress.stage, GenerationStage::Queued);
        assert_eq!(progress.queue_position, Some(3));
        for queue in [
            json!({}),
            json!({"queue_idx":0,"queue_length":0}),
            json!({"queue_idx":-1,"queue_length":9}),
            json!({"queue_idx":12,"queue_length":9}),
            json!({"queue_idx":3,"queue_length":9,"queue_status":"Finish"}),
        ] {
            assert_eq!(
                GenerationProgress::dreamina(&json!({"gen_status":"querying","queue_info":queue}))
                    .unwrap()
                    .stage,
                GenerationStage::Processing
            );
        }
        assert_eq!(
            serde_json::to_value(Chunk::Progress { progress }).unwrap(),
            json!({"kind":"progress","stage":"queued","queue_position":3,"queue_length":9})
        );
        for status in ["success", "fail", "unknown"] {
            assert!(GenerationProgress::dreamina(
                &json!({"gen_status":status,"queue_info":{"queue_status":"Finish"}})
            )
            .is_none());
        }
    }
    #[test]
    fn codex_reports_observed_tools_without_exposing_arguments_or_reasoning() {
        assert_eq!(
            GenerationProgress::codex(
                &json!({"type":"item.started","item":{"type":"image_generation"}})
            )
            .unwrap()
            .stage,
            GenerationStage::Generating
        );
        assert_eq!(GenerationProgress::codex(&json!({"type":"item.started","item":{"type":"command_execution","command":"private"}})).unwrap().stage,GenerationStage::ToolRunning);
        assert!(GenerationProgress::codex(
            &json!({"type":"item.completed","item":{"type":"reasoning","text":"private"}})
        )
        .is_none());
        assert!(GenerationProgress::codex(&json!({"type":"turn.completed"})).is_none());
    }
}
