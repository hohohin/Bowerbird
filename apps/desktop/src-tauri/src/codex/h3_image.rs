//! Local MiniMax-H3-Image API graphs derived from Comfy-Org's image_minimax_h3_image templates.
use super::{
    types::{Capabilities, Chunk, CodexRequest, CodexResult, GenOutcome},
    GenProvider,
};
use crate::{
    cloud::AuthClient,
    commands::comfy_video::{client, endpoint, json_response, upload_image_path},
    error::{AppError, AppResult},
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::{io::AsyncWriteExt, sync::mpsc};

pub const KEY: &str = "minimax-h3-image";
const UNET: &str = "minimax_h3_image_pruned_int8_convrot.safetensors";
const CLIP: &str = "qwen3vl_32b_minimax_h3_int8_convrot.safetensors";
const VAE: &str = "minimax_h3_image_vae_fp16.safetensors";
pub fn models(_: bool) -> &'static [&'static str] {
    &[UNET, CLIP, VAE]
}

/// Bind the editor's explicit mentions to H3's actual, unchanged upload order.
pub fn reference_prompt(prompt: &str, names: &[Option<String>]) -> String {
    if names.is_empty() { return prompt.to_owned(); }
    let mut aliases = Vec::new();
    for (i, name) in names.iter().enumerate() {
        if let Some(name) = name.as_deref().filter(|name| !name.is_empty()) {
            aliases.push((format!("@{name}"), format!("<Picture {}>", i + 1)));
        }
    }
    // Match once, longest first: a replacement must not become another mention.
    aliases.sort_by_key(|(alias, _)| std::cmp::Reverse(alias.len()));
    let mut patterns = aliases.iter().map(|(alias, _)| regex::escape(alias)).collect::<Vec<_>>();
    patterns.push("@(?:图片|图|image)(?P<index>[1-9][0-9]*)".into());
    let pattern = patterns.join("|");
    regex::Regex::new(&pattern).unwrap().replace_all(prompt, |caps: &regex::Captures<'_>| {
        if let Some(index) = caps.name("index").and_then(|m| m.as_str().parse::<usize>().ok()).filter(|index| *index <= names.len()) {
            return format!("<Picture {index}>");
        }
        aliases.iter().find(|(alias, _)| alias == &caps[0]).map(|(_, label)| label.clone()).unwrap_or_else(|| caps[0].into())
    }).into_owned()
}
fn err(message: impl Into<String>) -> AppError {
    AppError::Other(message.into())
}

fn dimensions(ratio: Option<&str>, reference: Option<(u32, u32)>) -> AppResult<(u32, u32)> {
    let (w, h) = match ratio {
        None | Some("auto" | "") => reference.unwrap_or((1, 1)),
        Some("1:1") => (1, 1),
        Some("3:4") => (3, 4),
        Some("4:3") => (4, 3),
        Some("2:3") => (2, 3),
        Some("3:2") => (3, 2),
        Some("16:9") => (16, 9),
        Some("9:16") => (9, 16),
        _ => return Err(err("请选择支持的画面比例")),
    };
    let scale = (4.0 * 1024.0 * 1024.0 / (f64::from(w) * f64::from(h))).sqrt();
    let align = |x| ((f64::from(x) * scale / 32.).round() as u32).saturating_mul(32);
    let size = (align(w), align(h));
    if size.0 == 0 || size.1 == 0 || size.0.max(size.1) > 16384 {
        return Err(err("参考图比例过于极端，请指定画面比例"));
    }
    Ok(size)
}

fn graph(
    prompt: &str,
    refs: &[String],
    size: (u32, u32),
    seed: u64,
    request: &str,
) -> AppResult<Value> {
    let mut graph = json!({
        "1":{"class_type":"UNETLoader","inputs":{"unet_name":UNET,"weight_dtype":"default"}},
        "2":{"class_type":"CLIPLoader","inputs":{"clip_name":CLIP,"type":"minimax","device":"default"}},
        "3":{"class_type":"VAELoader","inputs":{"vae_name":VAE}},
        "5":{"class_type":"MiniMaxH3ImageConditioning","inputs":{"clip":["2",0],"vae":["3",0],"prompt":prompt,"width":size.0,"height":size.1}},
        "6":{"class_type":"ConditioningZeroOut","inputs":{"conditioning":["5",0]}},
        "7":{"class_type":"KSampler","inputs":{"seed":seed,"steps":6,"cfg":1.0,"sampler_name":"euler","scheduler":"simple","denoise":1.0,"model":["1",0],"positive":["5",0],"negative":["6",0],"latent_image":["5",1]}},
        "8":{"class_type":"VAEDecode","inputs":{"samples":["7",0],"vae":["3",0]}},
        "9":{"class_type":"SaveImage","inputs":{"images":["8",0],"filename_prefix":format!("Bowerbird/{request}")}}
    });
    if !refs.is_empty() {
        for (index, name) in refs.iter().enumerate() {
            let id = format!("load{}", index + 1);
            graph[&id] = json!({"class_type":"LoadImage","inputs":{"image":name}});
            let source = if index == 0 {
                graph["resize"] = json!({"class_type":"ResizeImageMaskNode","inputs":{"input":[id,0],"resize_type":"scale total pixels","resize_type.megapixels":4.0,"scale_method":"area"}});
                graph["align"] = json!({"class_type":"ResizeImageMaskNode","inputs":{"input":["resize",0],"resize_type":"scale to multiple","resize_type.multiple":32,"scale_method":"area"}});
                "align"
            } else {
                &id
            };
            graph["5"]["inputs"][format!("images.image_{}", index + 1)] = json!([source, 0]);
        }
    }
    Ok(graph)
}

pub async fn check(http: &reqwest::Client, base: &str, edit: bool) -> AppResult<()> {
    let info = json_response(http.get(format!("{base}/object_info"))).await?;
    let refs = if edit {
        vec!["check.png".into()]
    } else {
        vec![]
    };
    for node in graph("", &refs, (2048, 2048), 0, "check")?
        .as_object()
        .unwrap()
        .values()
    {
        let class = node["class_type"].as_str().unwrap();
        if !info[class].is_object() {
            return Err(err(format!(
                "缺少节点 {class}，请准备支持 H3 图片的 ComfyUI 0.45.0 或更新版"
            )));
        }
        for field in ["unet_name", "clip_name", "vae_name"] {
            if let Some(name) = node["inputs"][field].as_str() {
                let field = &info[class]["input"]["required"][field];
                let choices = field[0]
                    .as_array()
                    .or_else(|| field[1]["options"].as_array());
                if !choices.is_some_and(|list| list.iter().any(|v| v == name)) {
                    return Err(err(format!("本机 ComfyUI 缺少模型 {name}")));
                }
            }
        }
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
pub struct Ticket {
    endpoint: String,
    owner: String,
    id: uuid::Uuid,
}
impl Ticket {
    pub fn new(endpoint: String, owner: String) -> Self {
        Self {
            endpoint,
            owner,
            id: uuid::Uuid::new_v4(),
        }
    }
    pub fn encode(&self) -> AppResult<String> {
        Ok(serde_json::to_string(self)?)
    }
    fn check_owner(&self, auth: &AuthClient) -> AppResult<()> {
        if auth.snapshot().user_id.as_deref() != Some(self.owner.as_str()) {
            return Err(err("请使用提交任务时的账号取回 H3 图片"));
        }
        Ok(())
    }
}

pub struct Provider {
    pub ticket: Ticket,
    pub auth: AuthClient,
}
#[async_trait]
impl GenProvider for Provider {
    fn name(&self) -> &str {
        KEY
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            chat: false,
            caption: false,
            generate: true,
        }
    }
    async fn run(&self, _: CodexRequest) -> AppResult<CodexResult> {
        Err(err("MiniMax-H3-Image 仅用于生成图片"))
    }
    async fn generate_image(
        &self,
        req: CodexRequest,
        tx: &mpsc::Sender<Chunk>,
        _: Option<String>,
    ) -> AppResult<GenOutcome> {
        let started = Instant::now();
        let base = endpoint(&self.ticket.endpoint)?;
        let id = self.ticket.id.to_string();
        let http = client()?;
        if req.reference_images.len() > 50 {
            return Err(err("图片编辑最多支持 50 张参考图"));
        }
        let mut refs = Vec::new();
        let mut first = None;
        for (i, path) in req.reference_images.into_iter().enumerate() {
            self.ticket.check_owner(&self.auth)?;
            let (name, size) =
                upload_image_path(&http, &base, path, &id, &format!("ref{}", i + 1)).await?;
            first.get_or_insert(size);
            refs.push(name);
        }
        let size = dimensions(req.ratio.as_deref(), first)?;
        let seed = u64::from_le_bytes(self.ticket.id.as_bytes()[..8].try_into().unwrap()) >> 11;
        let graph = graph(&req.instruction, &refs, size, seed, &id)?;
        self.ticket.check_owner(&self.auth)?;
        let response = json_response(
            http.post(format!("{base}/prompt"))
                .json(&json!({"prompt_id":id,"prompt":graph,"client_id":id})),
        )
        .await?;
        if response["prompt_id"] != id {
            return Err(err("服务未确认指定的任务编号，请检查 ComfyUI 版本"));
        }
        let _ = tx.send(Chunk::Submit { submit_id: id.clone() }).await;
        let (source_images, temp_dir) = retrieve(&self.ticket, &self.auth).await?;
        Ok(GenOutcome {
            text: String::new(),
            session_id: Some(id.clone()),
            submit_id: Some(id.clone()),
            elapsed_ms: started.elapsed().as_millis() as u64,
            source_images,
            temp_dir: Some(temp_dir),
        })
    }
}
pub fn verify_owner(encoded: &str, auth: &AuthClient) -> AppResult<()> {
    serde_json::from_str::<Ticket>(encoded)?.check_owner(auth)
}
pub async fn recover(encoded: &str, auth: &AuthClient) -> AppResult<(Vec<PathBuf>, PathBuf)> {
    retrieve(&serde_json::from_str(encoded)?, auth).await
}
pub fn session(encoded: &str) -> Option<String> {
    serde_json::from_str::<Ticket>(encoded)
        .ok()
        .map(|t| t.id.to_string())
}
pub async fn cancel(encoded: &str, auth: &AuthClient) -> AppResult<()> {
    let ticket: Ticket = serde_json::from_str(encoded)?;
    ticket.check_owner(auth)?;
    let base = endpoint(&ticket.endpoint)?;
    let http = client()?;
    let response = json_response(http.post(format!("{base}/api/jobs/{}/cancel", ticket.id))
        .timeout(Duration::from_secs(8))).await?;
    if response["cancelled"] != true {
        return Err(err("原 H3 图片任务已离开队列或尚未提交，可取回原任务检查结果"));
    }
    let id = ticket.id.to_string();
    for _ in 0..30 {
        ticket.check_owner(auth)?;
        let queue = json_response(http.get(format!("{base}/queue")).timeout(Duration::from_secs(5))).await?;
        let queued = ["queue_running", "queue_pending"].iter().any(|key| {
            queue[*key].as_array().is_some_and(|rows| rows.iter().any(|row| row[1] == id))
        });
        if !queued { return Ok(()); }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err(err("本机图片任务仍在停止中，尚未确认停止，请稍后检查原任务状态"))
}
async fn query_status(http: &reqwest::Client, url: String) -> AppResult<Value> {
    for attempt in 1..=3 {
        match json_response(http.get(&url).timeout(Duration::from_secs(18))).await {
            Err(e) if attempt < 3 && (e.to_string().starts_with("无法连接本机 ComfyUI") || e.to_string().contains("本机服务查询暂时中断")) => tokio::time::sleep(Duration::from_secs(2)).await,
            result => return result,
        }
    }
    unreachable!()
}
async fn retrieve(ticket: &Ticket, auth: &AuthClient) -> AppResult<(Vec<PathBuf>, PathBuf)> {
    let http = client()?;
    let base = endpoint(&ticket.endpoint)?;
    let id = ticket.id.to_string();
    let mut misses = 0;
    loop {
        ticket.check_owner(auth)?;
        let history = query_status(&http, format!("{base}/history/{id}")).await?;
        let result = &history[&id];
        if result["status"]["status_str"] == "error" {
            let reason = result["status"]["messages"]
                .as_array()
                .into_iter()
                .flatten()
                .find_map(|m| m[1]["exception_message"].as_str())
                .unwrap_or("任务中断");
            return Err(err(format!("本机 H3 图片生成失败：{reason}")));
        }
        if result["status"]["completed"] == true {
            let images = result["outputs"]["9"]["images"]
                .as_array()
                .filter(|v| v.len() == 1)
                .ok_or_else(|| err("工作流未返回一张成品图"))?;
            let out = &images[0];
            let filename = out["filename"]
                .as_str()
                .filter(|n| n.ends_with(".png") && !n.contains(['/', '\\']))
                .ok_or_else(|| err("生成图片文件名无效"))?;
            if out["type"] != "output" {
                return Err(err("工作流未返回成品文件"));
            }
            let response = http
                .get(format!("{base}/view"))
                .query(&[
                    ("filename", filename),
                    ("type", "output"),
                    ("subfolder", out["subfolder"].as_str().unwrap_or("")),
                ])
                .send()
                .await
                .map_err(|e| err(e.to_string()))?
                .error_for_status()
                .map_err(|e| err(e.to_string()))?;
            let temp = tempfile::tempdir()?;
            let path = temp.path().join("h3-image.png");
            let mut file = tokio::fs::File::create(&path).await?;
            let mut response = response;
            let mut bytes = 0;
            while let Some(chunk) = response.chunk().await.map_err(|e| err(e.to_string()))? {
                bytes += chunk.len();
                if bytes > 256 * 1024 * 1024 {
                    return Err(err("生成图片超过 256 MiB"));
                }
                file.write_all(&chunk).await?;
            }
            file.flush().await?;
            ticket.check_owner(auth)?;
            return Ok((vec![path], temp.keep()));
        }
        let queue = query_status(&http, format!("{base}/queue")).await?;
        if ["queue_running", "queue_pending"].iter().any(|key| {
            queue[*key]
                .as_array()
                .is_some_and(|q| q.iter().any(|row| row[1] == id))
        }) {
            misses = 0;
        } else {
            misses += 1;
        }
        if misses >= 3 {
            return Err(err("未找到原 H3 图片任务，请确认 ComfyUI 仍保留该任务记录"));
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        routing::{get, post},
        Json, Router,
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[test]
    fn official_graph_preserves_order_and_edit_defaults() {
        let text = graph("draw", &[], dimensions(None, None).unwrap(), 42, "test").unwrap();
        assert_eq!(text["5"]["inputs"]["width"], 2048);
        assert_eq!(text["7"]["inputs"]["steps"], 6);
        assert_eq!(text["7"]["inputs"]["cfg"], 1.0);
        assert_eq!(text["5"]["inputs"]["prompt"], "draw");
        assert!(text.get("10").is_none());
        let edit = graph(
            "把鸟改成白色",
            &["a.png".into(), "b.png".into()],
            dimensions(None, Some((300, 500))).unwrap(),
            42,
            "test",
        )
        .unwrap();
        assert_eq!(edit["5"]["inputs"]["images.image_1"], json!(["align", 0]));
        assert_eq!(edit["5"]["inputs"]["images.image_2"], json!(["load2", 0]));
        assert_eq!(edit["load2"]["inputs"]["image"], "b.png");
        assert_eq!(edit["5"]["inputs"]["prompt"], "把鸟改成白色");
        assert!(edit.as_object().unwrap().values().all(|node| node["class_type"] != "TextGenerateV2" && node["class_type"] != "JsonExtractString"));
        assert!(edit["5"]["inputs"]["height"].as_u64() > edit["5"]["inputs"]["width"].as_u64());
    }

    #[test]
    fn direct_prompt_binds_mentions_without_rewriting_the_edit_or_reordering_images() {
        let names = vec![Some("主持人.png".into()), Some("舞台.png".into())];
        assert_eq!(reference_prompt("保留@主持人.png特写，仅将背景换为@舞台.png，保持景深。", &names),
            "保留<Picture 1>特写，仅将背景换为<Picture 2>，保持景深。");
        assert_eq!(reference_prompt("Edit <Picture 1>. 背景参考@图片2，@图1保持特写。@image2 @图片10", &names),
            "Edit <Picture 1>. 背景参考<Picture 2>，<Picture 1>保持特写。<Picture 2> @图片10");
        assert_eq!(reference_prompt("@a.png @a.png.large", &[Some("a.png".into()), Some("a.png.large".into())]), "<Picture 1> <Picture 2>");
        assert_eq!(reference_prompt("画一只白鸟", &[]), "画一只白鸟");
    }

    #[tokio::test]
    async fn h3_cancel_waits_for_its_own_queue_exit_and_keeps_other_jobs() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ticket = Ticket::new(format!("http://{}", listener.local_addr().unwrap()), "test-user".into());
        let encoded = ticket.encode().unwrap(); let id = ticket.id.to_string();
        let polls = Arc::new(AtomicUsize::new(0)); let count = polls.clone();
        let server = Router::new()
            .route(&format!("/api/jobs/{id}/cancel"), post(|| async { Json(json!({"cancelled":true})) }))
            .route("/queue", get(move || { let (id, count) = (id.clone(), count.clone()); async move {
                let pending = if count.fetch_add(1, Ordering::SeqCst) < 2 { json!([[0,id]]) } else { json!([]) };
                Json(json!({"queue_running":[[1,"other-job"]],"queue_pending":pending}))
            }}));
        let server = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        let auth = AuthClient::with_test_session(crate::cloud::CloudClient::new(crate::cloud::config::CloudConfig::default()).unwrap());
        cancel(&encoded, &auth).await.unwrap();
        assert_eq!(polls.load(Ordering::SeqCst), 3);
        server.abort();
    }

    #[tokio::test]
    async fn local_provider_uploads_then_recovers_only_its_original_png() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("in.png");
        image::RgbImage::new(2, 3).save(&path).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ticket = Ticket::new(
            format!("http://{}", listener.local_addr().unwrap()),
            "test-user".into(),
        );
        let encoded = ticket.encode().unwrap();
        let id = ticket.id.to_string();
        let expected = id.clone();
        let submissions = Arc::new(AtomicUsize::new(0));
        let count = submissions.clone();
        let server=Router::new().route("/upload/image",post(||async{Json(json!({"name":"bird.png","subfolder":"bowerbird"}))}))
            .route("/prompt",post(move|Json(body):Json<Value>|{let id=expected.clone();let count=count.clone();async move{
                assert_eq!(body["prompt_id"],id); assert_eq!(body["prompt"]["load1"]["inputs"]["image"],"bowerbird/bird.png");
                count.fetch_add(1,Ordering::SeqCst);Json(json!({"prompt_id":id}))
            }}))
            .route(&format!("/history/{id}"),get(move||{let id=id.clone();async move{
                Json(json!({(id):{"status":{"completed":true},"outputs":{"9":{"images":[{"type":"output","filename":"bb.png","subfolder":"Bowerbird"}]}}}}))
            }}))
            .route("/view",get(move||{let bytes=bytes.clone();async move{bytes}}));
        let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        let auth = AuthClient::with_test_session(
            crate::cloud::CloudClient::new(crate::cloud::config::CloudConfig::default()).unwrap(),
        );
        let provider = Provider {
            ticket,
            auth: auth.clone(),
        };
        let (tx, _rx) = mpsc::channel(8);
        let req = CodexRequest {
            instruction: "编辑".into(),
            reference_images: vec![path],
            context_prompts: vec![],
            ratio: None,
            job_id: None,
            generate_num: None,
            transparent_background: None,
        };
        let got = provider.generate_image(req, &tx, None).await.unwrap();
        assert_eq!(
            image::image_dimensions(&got.source_images[0]).unwrap(),
            (2, 3)
        );
        std::fs::remove_dir_all(got.temp_dir.unwrap()).unwrap();
        let (paths, dir) = recover(&encoded, &auth).await.unwrap();
        assert_eq!(image::image_dimensions(&paths[0]).unwrap(), (2, 3));
        std::fs::remove_dir_all(dir).unwrap();
        auth.set_test_user("other");
        assert!(recover(&encoded, &auth).await.is_err());
        assert_eq!(submissions.load(Ordering::SeqCst), 1);
        task.abort();
    }
}
