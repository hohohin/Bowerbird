//! Per-request local ComfyUI progress. Never mixes another prompt's events into a card.
use std::{collections::HashMap, sync::{Arc, LazyLock, Mutex}, time::{Duration, Instant}};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
pub(super) struct Progress { pub label: String, pub value: Option<f64>, pub max: Option<f64> }
struct Watch {
    task: tokio::task::JoinHandle<()>,
    touched: Arc<Mutex<Instant>>,
    sample: Arc<Mutex<Option<(String, Progress)>>>,
}
static WATCHES: LazyLock<Mutex<HashMap<String, Watch>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn parse(event: &Value) -> Option<(String, Progress)> {
    let data = &event["data"];
    let prompt = data["prompt_id"].as_str()?;
    let node = data["node"].as_str()?;
    let label = match node {
        "1" | "2" | "3" | "4" | "7" | "8" => "加载模型",
        "5" | "30" | "9" => "准备首尾帧与提示词",
        "10" | "11" | "12" | "13" | "14" => "生成视频",
        "15" => "解码画面", "16" => "解码音频", "26" => "合成视频", "27" => "保存视频",
        _ => return None,
    };
    let (value, max) = match event["type"].as_str()? {
        "executing" => (None, None),
        "progress" => {
            let value = data["value"].as_f64()?;
            let max = data["max"].as_f64()?;
            if !value.is_finite() || !max.is_finite() || max <= 0.0 || value < 0.0 || value > max { return None; }
            (Some(value), Some(max))
        }
        _ => return None,
    };
    Some((prompt.into(), Progress { label: label.into(), value, max }))
}

pub(super) async fn watch(request: &str, base: &str) {
    {
        let mut watches = WATCHES.lock().unwrap();
        watches.retain(|_, watch| !watch.task.is_finished());
        if let Some(watch) = watches.get(request) {
            *watch.touched.lock().unwrap() = Instant::now();
            return;
        }
    }
    let url = format!("ws://{}/ws?clientId={request}", base.trim_start_matches("http://"));
    // Connect before /prompt so even a cached/fast task can report its first events.
    let socket = tokio::time::timeout(Duration::from_secs(2), tokio_tungstenite::connect_async(&url)).await;
    let socket = socket.ok().and_then(Result::ok).map(|(socket, _)| socket);
    let touched = Arc::new(Mutex::new(Instant::now()));
    let sample = Arc::new(Mutex::new(None));
    let last_poll = touched.clone(); let output = sample.clone();
    let task = tokio::spawn(async move {
        let mut socket = socket;
        while last_poll.lock().unwrap().elapsed() < Duration::from_secs(180) {
            if socket.is_none() {
                *output.lock().unwrap() = None;
                tokio::time::sleep(Duration::from_secs(2)).await;
                socket = tokio::time::timeout(Duration::from_secs(2), tokio_tungstenite::connect_async(&url))
                    .await.ok().and_then(Result::ok).map(|(socket, _)| socket);
                continue;
            }
            match tokio::time::timeout(Duration::from_secs(5), socket.as_mut().unwrap().next()).await {
                Ok(Some(Ok(message))) if message.is_text() => {
                    if let Ok(event) = serde_json::from_str::<Value>(message.to_text().unwrap_or("")) {
                        if let Some(progress) = parse(&event) { *output.lock().unwrap() = Some(progress); }
                    }
                }
                Ok(Some(Ok(message))) if !message.is_close() => {}
                Err(_) => {}
                _ => { socket = None; *output.lock().unwrap() = None; }
            }
        }
    });
    WATCHES.lock().unwrap().insert(request.into(), Watch { task, touched, sample });
}
pub(super) fn current(request: &str, prompt: Option<&str>) -> Option<Progress> {
    let watches = WATCHES.lock().unwrap();
    let watch = watches.get(request)?;
    let sample = watch.sample.lock().unwrap();
    sample.as_ref().filter(|(id, _)| Some(id.as_str()) == prompt).map(|(_, progress)| progress.clone())
}
pub(super) fn stop(request: &str) {
    if let Some(watch) = WATCHES.lock().unwrap().remove(request) { watch.task.abort(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[tokio::test]
    async fn h3_progress_socket_filters_prompt_and_stops_subscription() {
        use futures_util::SinkExt;
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base=format!("http://{}",listener.local_addr().unwrap());
        let server=tokio::spawn(async move {
            let (stream,_)=listener.accept().await.unwrap();
            let mut socket=tokio_tungstenite::accept_async(stream).await.unwrap();
            socket.send(tokio_tungstenite::tungstenite::Message::Text(json!({"type":"progress","data":{"prompt_id":"own","node":"14","value":3,"max":8}}).to_string())).await.unwrap();
            while let Some(Ok(_))=socket.next().await {}
        });
        let request=uuid::Uuid::new_v4().to_string();
        watch(&request,&base).await;
        tokio::time::timeout(Duration::from_secs(2),async {
            while current(&request,Some("own")).is_none() { tokio::time::sleep(Duration::from_millis(10)).await; }
        }).await.unwrap();
        assert_eq!(current(&request,Some("own")).unwrap().value,Some(3.0));
        assert!(current(&request,Some("other")).is_none());
        stop(&request);assert!(current(&request,Some("own")).is_none());
        server.abort();let _=server.await;
    }
    #[test]
    fn h3_progress_uses_real_steps_and_resets_for_each_stage() {
        let (_, p) = parse(&json!({"type":"progress","data":{"prompt_id":"own","node":"14","value":3,"max":8}})).unwrap();
        assert_eq!(p.value, Some(3.0)); assert_eq!(p.max, Some(8.0)); assert_eq!(p.label, "生成视频");
        let (_, p) = parse(&json!({"type":"executing","data":{"prompt_id":"own","node":"15"}})).unwrap();
        assert_eq!(p.value, None); assert_eq!(p.label, "解码画面");
        for data in [json!({"node":"14","value":3,"max":8}), json!({"prompt_id":"own","node":"14","value":9,"max":8}),
            json!({"prompt_id":"own","node":"14","value":0,"max":0})] {
            assert!(parse(&json!({"type":"progress","data":data})).is_none());
        }
    }
}
