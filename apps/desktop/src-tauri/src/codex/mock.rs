//! Mock provider：开发/离线/测试用，不发真实请求。
//! 模拟「单轮」与「流式」两条通路，验证整条管线（命令 → trait → 前端 event）。

use std::time::{Duration, Instant};

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::codex::types::{Chunk, CodexRequest, CodexResult};
use crate::codex::CodexProvider;
use crate::error::AppError;

pub struct MockProvider {
    /// 流式推送时每个分片之间的延时（便于前端看到「逐字」效果）。
    pub tick: Duration,
}

impl Default for MockProvider {
    fn default() -> Self {
        Self {
            tick: Duration::from_millis(20),
        }
    }
}

fn compose(req: &CodexRequest) -> String {
    let mut s = String::new();
    s.push_str(&format!("[Mock] 指令：{}\n", req.instruction));
    if !req.reference_images.is_empty() {
        s.push_str(&format!("参考图：{} 张\n", req.reference_images.len()));
        for p in &req.reference_images {
            s.push_str(&format!("  - {}\n", p.display()));
        }
    }
    if !req.context_prompts.is_empty() {
        s.push_str(&format!("上下文提示词：\n"));
        for p in &req.context_prompts {
            s.push_str(&format!("  - {}\n", p));
        }
    }
    s
}

#[async_trait]
impl CodexProvider for MockProvider {
    fn name(&self) -> &'static str {
        "mock"
    }

    async fn run(&self, req: CodexRequest) -> Result<CodexResult, AppError> {
        let start = Instant::now();
        let text = compose(&req);
        Ok(CodexResult {
            text,
            structured: None,
            provider: self.name().to_string(),
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    }

    async fn run_stream(
        &self,
        req: CodexRequest,
        tx: mpsc::Sender<Chunk>,
    ) -> Result<(), AppError> {
        let start = Instant::now();
        let full = compose(&req);
        // 按 3 个汉字/字符一组推送，模拟 token 流。
        let chars: Vec<char> = full.chars().collect();
        for chunk in chars.chunks(3) {
            let s: String = chunk.iter().collect();
            if tx.send(Chunk::Delta { text: s }).await.is_err() {
                break; // 接收端关闭
            }
            tokio::time::sleep(self.tick).await;
        }
        let result = CodexResult {
            text: full,
            structured: None,
            provider: self.name().to_string(),
            elapsed_ms: start.elapsed().as_millis() as u64,
        };
        let _ = tx.send(Chunk::Done(result)).await;
        Ok(())
    }
}
