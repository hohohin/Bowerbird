//! 可选云端最终校验：TypeSafe Jev（System One Model）把本地候选标签与
//! 视觉描述做蕴含复核。图片永不离开本机；出机的只有描述文本与标签文本。

use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use super::data::{Label, Prediction};

pub const MODEL: &str = "jev-latest";
pub const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
/// noul 概率达到该阈值的候选才写入归属。
pub const THRESHOLD: f64 = 0.6;

pub struct Gate {
    client: reqwest::Client,
    key: String,
    url: String,
}

impl Gate {
    pub fn new(key: String) -> Result<Self, String> {
        Self::at(key, ENDPOINT.into())
    }

    fn at(key: String, url: String) -> Result<Self, String> {
        Ok(Self {
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(20))
                .build()
                .map_err(|e| e.to_string())?,
            key,
            url,
        })
    }

    /// 一次请求并行复核全部候选（matches 先于 tags 排列）。校验失败按错误
    /// 处理而不是放行：此素材不写入任何结果，自动处理由既有逻辑暂停。
    pub async fn apply(
        &self,
        prediction: &mut Prediction,
        labels: &[Label],
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        if prediction.description.trim().is_empty()
            || (prediction.tags.is_empty() && prediction.matches.is_empty())
        {
            return Ok(());
        }
        let mut candidates: Vec<(String, String)> = Vec::new();
        for id in &prediction.matches {
            let label = labels
                .iter()
                .find(|label| &label.id == id)
                .ok_or("云端校验缺少标签定义")?;
            candidates.push((label.name.clone(), label.description.clone()));
        }
        for name in &prediction.tags {
            candidates.push((name.clone(), String::new()));
        }
        let mut questions = serde_json::Map::new();
        for (index, (name, description)) in candidates.iter().enumerate() {
            let detail = if description.trim().is_empty() {
                String::new()
            } else {
                format!("（{description}）")
            };
            questions.insert(
                format!("q{index}"),
                json!({"type":"noul","instructions":format!(
                    "状态中的视觉描述明确表明该素材属于标签「{name}」{detail}；描述没有体现该标签所指内容时返回低值。"
                )}),
            );
        }
        let body = json!({"state": prediction.description, "model": MODEL, "questions": questions});
        if cancel.load(Ordering::Relaxed) {
            return Err("已停止分类".into());
        }
        let request = self
            .client
            .post(&self.url)
            .bearer_auth(&self.key)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.to_string())
            .send();
        tokio::pin!(request);
        let response = loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("已停止分类".into());
            }
            tokio::select! {
                response = &mut request => break response.map_err(|e| format!("Jev 校验请求失败：{e}"))?,
                _ = tokio::time::sleep(Duration::from_millis(100)) => {},
            }
        };
        if !response.status().is_success() {
            return Err(format!("Jev 校验返回 {}", response.status()));
        }
        let result: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Jev 校验响应无效：{e}"))?;
        let answers = result["answers"]
            .as_object()
            .ok_or("Jev 校验缺少判断结果")?;
        let mut keep_matches = vec![false; prediction.matches.len()];
        let mut keep_tags = vec![false; prediction.tags.len()];
        for index in 0..candidates.len() {
            let noul = answers
                .get(&format!("q{index}"))
                .and_then(|answer| answer["noul"].as_f64())
                .ok_or("Jev 校验缺少概率值")?;
            let keep = noul >= THRESHOLD;
            if index < keep_matches.len() {
                keep_matches[index] = keep;
            } else {
                keep_tags[index - keep_matches.len()] = keep;
            }
        }
        retain_all(&mut prediction.matches, &keep_matches);
        retain_all(&mut prediction.tags, &keep_tags);
        Ok(())
    }
}

fn retain_all<T>(values: &mut Vec<T>, keep: &[bool]) {
    let mut index = 0;
    values.retain(|_| {
        let keep = keep[index];
        index += 1;
        keep
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn labels() -> Vec<Label> {
        vec![Label {
            id: "plant".into(),
            name: "植物".into(),
            description: "以植物为主体".into(),
            enabled: true,
            count: 0,
            has_examples: false,
        }]
    }

    async fn mock_jev(
        status: &str,
        body: String,
    ) -> (Gate, tokio::task::JoinHandle<serde_json::Value>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let status = status.to_string();
        let requests = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let (offset, length) = loop {
                let mut buffer = [0u8; 4096];
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(offset) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..offset]).to_lowercase();
                    let length = header
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .unwrap()
                        .parse::<usize>()
                        .unwrap();
                    break (offset + 4, length);
                }
            };
            while bytes.len() < offset + length {
                let mut buffer = [0u8; 4096];
                let count = socket.read(&mut buffer).await.unwrap();
                bytes.extend_from_slice(&buffer[..count]);
            }
            let request: serde_json::Value =
                serde_json::from_slice(&bytes[offset..offset + length]).unwrap();
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            request
        });
        (Gate::at("test-key".into(), url).unwrap(), requests)
    }

    #[tokio::test]
    async fn gate_keeps_candidates_above_threshold_and_shapes_the_request() {
        let (gate, requests) = mock_jev(
            "200 OK",
            r#"{"model":"jev-latest","answers":{
                "q0":{"type":"noul","noul":0.9},
                "q1":{"type":"noul","noul":0.2},
                "q2":{"type":"noul","noul":0.6}},"usage":{"input_tokens":1}}"#
                .into(),
        )
        .await;
        let mut prediction = Prediction {
            description: "矿泉水瓶与纸艺马蹄莲的产品渲染图".into(),
            tags: vec!["梅花".into(), "矿泉水瓶".into()],
            matches: vec!["plant".into()],
        };
        let cancel = AtomicBool::new(false);
        gate.apply(&mut prediction, &labels(), &cancel)
            .await
            .unwrap();
        assert_eq!(prediction.matches, vec!["plant".to_string()]);
        assert_eq!(prediction.tags, vec!["矿泉水瓶".to_string()]);
        let request = requests.await.unwrap();
        assert_eq!(request["state"], "矿泉水瓶与纸艺马蹄莲的产品渲染图");
        assert_eq!(request["model"], "jev-latest");
        let questions = request["questions"].as_object().unwrap();
        assert_eq!(questions.len(), 3);
        assert!(questions["q0"]["instructions"]
            .as_str()
            .unwrap()
            .contains("植物"));
        assert!(questions["q1"]["instructions"]
            .as_str()
            .unwrap()
            .contains("梅花"));
    }

    #[tokio::test]
    async fn gate_failures_are_errors_never_silent_passes() {
        let (gate, _requests) = mock_jev("401 Unauthorized", r#"{"error":"bad key"}"#.into()).await;
        let mut prediction = Prediction {
            description: "描述".into(),
            tags: vec!["植物".into()],
            matches: vec![],
        };
        let cancel = AtomicBool::new(false);
        let error = gate
            .apply(&mut prediction, &labels(), &cancel)
            .await
            .unwrap_err();
        assert!(error.contains("401"), "{error}");
        assert_eq!(prediction.tags, vec!["植物".to_string()]);
    }

    #[tokio::test]
    async fn empty_description_or_no_candidates_skips_the_call() {
        let (gate, requests) = mock_jev("200 OK", "{}".into()).await;
        let cancel = AtomicBool::new(false);
        let mut prediction = Prediction {
            description: "  ".into(),
            tags: vec!["植物".into()],
            matches: vec![],
        };
        gate.apply(&mut prediction, &labels(), &cancel)
            .await
            .unwrap();
        assert_eq!(prediction.tags, vec!["植物".to_string()]);
        let mut empty = Prediction {
            description: "有描述".into(),
            tags: vec![],
            matches: vec![],
        };
        gate.apply(&mut empty, &labels(), &cancel).await.unwrap();
        requests.abort();
    }
}
