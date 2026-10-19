//! Fixed local H3 adapter. No Cloud generation, arbitrary graph execution or global interrupt.
use std::{fs, path::{Path, PathBuf}, sync::Arc, time::Duration};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use rusqlite::OptionalExtension;
use tauri::{AppHandle, Emitter, State};
use crate::{cloud::{AuthClient, EntitlementService}, core::{ingest, library::Asset, paths::LibraryPaths}, db::Database, error::{AppError, AppResult}};

static IO: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const WORKFLOW: &str = "10_H3_768p_Turbo8_Review_First";
const UNET: &str = "minimax_h3_fl2va_pruned_int8_convrot.safetensors";
const CLIP: &str = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors";
const VAE: &str = "minimax_h3_video_vae_int8_convrot.safetensors";
const AUDIO: &str = "minimax_h3_audio_vae_fp32.safetensors";
const LORA: &str = "minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors";

fn error(message: impl Into<String>) -> AppError { AppError::Other(message.into()) }
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Input { endpoint: String, seconds: f64, ratio: String, resolution: f64, first_frame: String, last_frame: Option<String>, prompt: String }
#[derive(Deserialize, Serialize)]
struct Record { account: String, project: String, input: Input, prompt_id: Option<String>, submitted: bool, asset_id: Option<String>, failure: Option<String> }
#[derive(Serialize)]
pub struct Status { status: &'static str, message: String, asset: Option<Asset> }
fn status(state: &'static str, message: &str) -> Status { Status { status: state, message: message.into(), asset: None } }

pub(super) fn endpoint(value: &str) -> AppResult<String> {
    let url = reqwest::Url::parse(value).map_err(|_| error("请输入本机 ComfyUI 地址，例如 http://127.0.0.1:8000"))?;
    if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"))
        || !url.username().is_empty() || url.password().is_some() || url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(error("ComfyUI 仅支持本机 HTTP 地址（127.0.0.1、localhost 或 [::1]），不能包含路径或凭据"));
    }
    Ok(url.as_str().trim_end_matches('/').into())
}
fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(120)).build().map_err(|e| error(e.to_string()))
}
async fn json_response(request: reqwest::RequestBuilder) -> AppResult<Value> {
    let response = request.send().await.map_err(|e| error(format!("无法连接本机 ComfyUI：{e}")))?;
    let code = response.status();
    let body: Value = response.json().await.map_err(|_| error("ComfyUI 返回了无法识别的响应"))?;
    if !code.is_success() { return Err(error(format!("ComfyUI 请求失败（{code}）：{}", body.to_string().chars().take(1500).collect::<String>()))); }
    Ok(body)
}
fn dimensions(input: &Input) -> AppResult<(u32, u32, u32)> {
    let (w, h) = match input.ratio.as_str() { "9:16" => (9.0_f64,16.0), "16:9" => (16.0,9.0), "4:3" => (4.0,3.0), _ => return Err(error("不支持的宽高比")) };
    if ![0.6,0.8,1.0].contains(&input.resolution) || !input.seconds.is_finite() || !(1.0..=15.0).contains(&input.seconds) {
        return Err(error("时长需为 1–15 秒，分辨率需为 0.6、0.8 或 1.0"));
    }
    let scale = (input.resolution * 1024.0 * 1024.0 / (w*h)).sqrt();
    Ok((((w*scale/32.0).round()*32.0) as u32, ((h*scale/32.0).round()*32.0) as u32, (((input.seconds*24.0-5.0)/17.0).ceil()*17.0+5.0).max(5.0) as u32))
}
fn graph(input: &Input, first: &str, last: Option<&str>, seed: u64, request: &str) -> AppResult<Value> {
    let (width,height,length) = dimensions(input)?;
    let mut graph = json!({
        "1":{"class_type":"UNETLoader","inputs":{"unet_name":UNET,"weight_dtype":"default"}},
        "2":{"class_type":"CLIPLoader","inputs":{"clip_name":CLIP,"type":"minimax","device":"default"}},
        "3":{"class_type":"VAELoader","inputs":{"vae_name":VAE}},
        "4":{"class_type":"VAELoader","inputs":{"vae_name":AUDIO}},
        "5":{"class_type":"LoadImage","inputs":{"image":first}},
        "7":{"class_type":"LoraLoaderModelOnly","inputs":{"model":["1",0],"lora_name":LORA,"strength_model":1.0}},
        "8":{"class_type":"MiniMaxH3SigmaShift","inputs":{"model":["7",0],"shift_video":6.0,"shift_audio":3.0}},
        "9":{"class_type":"MiniMaxH3ImageToVideo","inputs":{"clip":["2",0],"vae":["3",0],"first_frame":["5",0],"width":width,"height":height,"length":length,"prompt":input.prompt}},
        "10":{"class_type":"RandomNoise","inputs":{"noise_seed":seed}},
        "11":{"class_type":"BasicGuider","inputs":{"model":["8",0],"conditioning":["9",0]}},
        "12":{"class_type":"KSamplerSelect","inputs":{"sampler_name":"euler"}},
        "13":{"class_type":"BasicScheduler","inputs":{"model":["8",0],"scheduler":"simple","steps":8,"denoise":1.0}},
        "14":{"class_type":"SamplerCustomAdvanced","inputs":{"noise":["10",0],"guider":["11",0],"sampler":["12",0],"sigmas":["13",0],"latent_image":["9",1]}},
        "15":{"class_type":"VAEDecode","inputs":{"samples":["14",0],"vae":["3",0]}},
        "16":{"class_type":"VAEDecodeAudio","inputs":{"samples":["14",0],"vae":["4",0]}},
        "26":{"class_type":"CreateVideo","inputs":{"images":["15",0],"audio":["16",0],"fps":24.0,"bit_depth":8,"color_space":"sRGB","codec":"none"}},
        "27":{"class_type":"SaveVideo","inputs":{"video":["26",0],"filename_prefix":format!("video/Bowerbird/{request}"),"format":"mp4","format.codec":"auto"}}
    });
    if let Some(last) = last { graph["30"] = json!({"class_type":"LoadImage","inputs":{"image":last}}); graph["9"]["inputs"]["last_frame"] = json!(["30",0]); }
    Ok(graph)
}
pub(super) async fn check(http: &reqwest::Client, base: &str) -> AppResult<()> {
    let info = json_response(http.get(format!("{base}/object_info"))).await?;
    let sample = Input { endpoint: base.into(), seconds:8.0, ratio:"9:16".into(), resolution:0.8, first_frame:"".into(), last_frame:None, prompt:"".into() };
    for node in graph(&sample,"",None,0,"check")?.as_object().unwrap().values() {
        let class = node["class_type"].as_str().unwrap();
        if !info[class].is_object() { return Err(error("本机 ComfyUI 尚不支持此 H3 工作流，需要准备兼容版本")); }
    }
    for (class,field,model,label) in [("UNETLoader","unet_name",UNET,"视频主模型"),("CLIPLoader","clip_name",CLIP,"文本理解模型"),("VAELoader","vae_name",VAE,"画面解码模型"),("VAELoader","vae_name",AUDIO,"音频解码模型"),("LoraLoaderModelOnly","lora_name",LORA,"8 步加速模型")] {
        if !info[class]["input"]["required"][field][0].as_array().is_some_and(|list| list.iter().any(|v| v.as_str() == Some(model))) {
            return Err(error(format!("缺少{label}，需要下载完整的 H3 模型包")));
        }
    }
    Ok(())
}
pub(super) async fn account(auth: &AuthClient, entitlement: &EntitlementService) -> AppResult<String> {
    let snapshot = entitlement.current_or_sync(auth).await;
    let login = auth.snapshot();
    if !login.logged_in || !snapshot.is_test_account || login.user_id.as_deref() != Some(snapshot.user_id.as_str())
        || !matches!(snapshot.offline_state, Some(crate::cloud::entitlement::OfflineState::Fresh | crate::cloud::entitlement::OfflineState::Grace)) { return Err(error("本地 H3 视频仅对有效测试账号开放")); }
    Ok(snapshot.user_id)
}
#[tauri::command]
pub async fn comfy_video_check(auth: State<'_, AuthClient>, entitlement: State<'_, EntitlementService>, endpoint: String) -> AppResult<String> {
    account(&auth,&entitlement).await?;
    check(&client()?, &self::endpoint(&endpoint)?).await?;
    Ok(format!("已连接 · {WORKFLOW} 所需节点与模型可用"))
}
fn save(path: &Path, record: &Record) -> AppResult<()> {
    let temp = path.with_extension("tmp");
    fs::write(&temp, serde_json::to_vec_pretty(record)?)?;
    fs::rename(temp,path)?;
    Ok(())
}
async fn upload(http: &reqwest::Client, base: &str, db: &Database, id: &str, request: &str, role: &str) -> AppResult<String> {
    let asset = db.get_asset(id)?.ok_or_else(|| error("输入图片不存在"))?;
    let path = asset.store_path.ok_or_else(|| error("输入图片没有本地文件"))?;
    // Decode and normalize to PNG: no arbitrary local files are forwarded to ComfyUI.
    let bytes = tokio::task::spawn_blocking(move || -> AppResult<Vec<u8>> {
        let image = image::open(path)?;
        let mut bytes = std::io::Cursor::new(Vec::new());
        image.write_to(&mut bytes,image::ImageFormat::Png)?;
        Ok(bytes.into_inner())
    }).await.map_err(|e| error(e.to_string()))??;
    let part = reqwest::multipart::Part::bytes(bytes).file_name(format!("{request}-{role}.png")).mime_str("image/png").map_err(|e| error(e.to_string()))?;
    let result = json_response(http.post(format!("{base}/upload/image")).multipart(reqwest::multipart::Form::new().part("image",part).text("type","input").text("overwrite","true").text("subfolder","bowerbird"))).await?;
    let name = result["name"].as_str().ok_or_else(|| error("ComfyUI 未返回上传图片名称"))?;
    let folder = result["subfolder"].as_str().unwrap_or("");
    Ok(if folder.is_empty() { name.into() } else { format!("{folder}/{name}") })
}
// /prompt has no idempotency guarantee: a durable submitted marker prevents retries.
async fn start(http: &reqwest::Client, db: &Database, path: &Path, record: &mut Record, request: &str, owner: &(dyn Fn() -> AppResult<()> + Sync)) -> AppResult<()> {
    let base = endpoint(&record.input.endpoint)?;
    check(http,&base).await?;
    let first = upload(http,&base,db,&record.input.first_frame,request,"first").await?;
    let last = match record.input.last_frame.as_deref() { Some(id) => Some(upload(http,&base,db,id,request,"last").await?), None => None };
    let seed = u64::from_le_bytes(uuid::Uuid::new_v4().as_bytes()[..8].try_into().unwrap()) & ((1_u64<<53)-1);
    let prompt = graph(&record.input,&first,last.as_deref(),seed,request)?;
    owner()?;
    record.submitted = true; save(path,record)?;
    let response = http.post(format!("{base}/prompt")).json(&json!({"prompt":prompt,"client_id":request,"extra_data":{"bowerbird_request_id":request,"workflow":WORKFLOW}}))
        .send().await.map_err(|e| error(format!("提交结果未知：{e}")))?;
    let code = response.status();
    let response: Value = response.json().await.map_err(|_| error("提交结果未知，请继续查询原任务"))?;
    if !code.is_success() {
        let message = format!("ComfyUI 拒绝生成（{code}）：{}",response.to_string().chars().take(1500).collect::<String>());
        record.failure = Some(message.clone()); save(path,record)?; return Err(error(message));
    }
    record.prompt_id = Some(response["prompt_id"].as_str().ok_or_else(|| error("ComfyUI 提交结果未知，请继续取回原任务"))?.into());
    save(path,record)
}
fn request_match(item: &Value, request: &str) -> bool { item[3]["bowerbird_request_id"].as_str() == Some(request) }
async fn poll(http: &reqwest::Client, db: &Database, paths: &LibraryPaths, path: &Path, record: &mut Record, request: &str, owner: &(dyn Fn() -> AppResult<()> + Sync)) -> AppResult<Status> {
    owner()?;
    if let Some(id) = &record.asset_id { return Ok(Status { status:"done",message:"视频已生成".into(),asset:Some(db.get_asset(id)?.ok_or_else(|| error("生成的视频已被删除"))?) }); }
    if let Some(message) = &record.failure { return Ok(status("failed",message)); }
    if !record.submitted { return Ok(status("failed","尚未提交到 ComfyUI，请停止后重新运行")); }
    let base = endpoint(&record.input.endpoint)?;
    let queue = json_response(http.get(format!("{base}/queue"))).await?;
    let history = json_response(http.get(match &record.prompt_id { Some(id) => format!("{base}/history/{id}"), None => format!("{base}/history?max_items=500") })).await?;
    if record.prompt_id.is_none() {
        record.prompt_id = queue["queue_running"].as_array().into_iter().flatten().chain(queue["queue_pending"].as_array().into_iter().flatten())
            .find(|item| request_match(item,request)).and_then(|item| item[1].as_str()).map(str::to_owned)
            .or_else(|| history.as_object().and_then(|items| items.iter().find(|(_,item)| request_match(&item["prompt"],request)).map(|(id,_)| id.clone())));
        save(path,record)?;
    }
    let Some(id) = &record.prompt_id else { return Ok(status("unknown","提交结果尚无法确认；继续只查找原任务，不会重复生成")); };
    let result = &history[id];
    if result["status"]["status_str"] == "error" {
        let message = result["status"]["messages"].as_array().and_then(|messages| messages.iter().find(|m| m[0] == "execution_error" || m[0] == "execution_interrupted"))
            .map(|m| format!("ComfyUI 生成失败：{}",m[1]["exception_message"].as_str().unwrap_or("任务被中断"))).unwrap_or_else(|| "ComfyUI 生成失败".into());
        record.failure = Some(message.clone()); save(path,record)?; return Ok(status("failed",&message));
    }
    if result["status"]["completed"] != true {
        return Ok(if queue["queue_running"].as_array().is_some_and(|items| items.iter().any(|item| item[1].as_str() == Some(id))) { status("running","本机正在生成视频") }
            else if queue["queue_pending"].as_array().is_some_and(|items| items.iter().any(|item| item[1].as_str() == Some(id))) { status("queued","已加入本机队列") }
            else { status("unknown","原任务暂不可见，请确认 ComfyUI 仍在运行；不会自动重新提交") });
    }
    let outputs = result["outputs"]["27"]["images"].as_array().filter(|v| v.len()==1).ok_or_else(|| error("基准工作流未返回唯一视频"))?;
    let output = &outputs[0];
    let filename = output["filename"].as_str().filter(|v| v.ends_with(".mp4") && !v.contains(['/', '\\'])).ok_or_else(|| error("ComfyUI 视频文件名无效"))?;
    if output["type"] != "output" { return Err(error("ComfyUI 未返回输出文件")); }
    let mut response = http.get(format!("{base}/view")).query(&[("filename",filename),("subfolder",output["subfolder"].as_str().unwrap_or("")),("type","output")]).send().await.map_err(|e| error(e.to_string()))?.error_for_status().map_err(|e| error(e.to_string()))?;
    let video = path.with_extension("mp4");
    let mut file = fs::File::create(&video)?;
    let mut size = 0_u64;
    while let Some(chunk) = response.chunk().await.map_err(|e| error(e.to_string()))? {
        size += chunk.len() as u64;
        if size > 2*1024*1024*1024 { return Err(error("生成视频超过 2 GB")); }
        std::io::Write::write_all(&mut file,&chunk)?;
    }
    drop(file);
    owner()?;
    // Recover an import committed before the job-file update (e.g. app closed at that boundary).
    let previous: Option<String> = db.conn.lock().unwrap().query_row(
        "SELECT id FROM assets WHERE origin_path=?1 AND source='comfy-h3' LIMIT 1",
        [video.to_string_lossy().as_ref()], |row| row.get(0)).optional()?;
    let asset = if let Some(id) = previous { db.get_asset(&id)?.ok_or_else(|| error("已导入视频不存在"))? } else {
        let destination = paths.for_project(db,Some(&record.project))?;
        ingest::ingest_generated(&destination,db,&video,None,"comfy-h3")?
    };
    db.add_assets_to_project(&record.project,&[asset.id.clone()])?;
    record.asset_id = Some(asset.id.clone()); save(path,record)?;
    let _ = fs::remove_file(video);
    Ok(Status { status:"done",message:"视频已生成".into(),asset:db.get_asset(&asset.id)? })
}
#[tauri::command]
pub async fn comfy_video(app: AppHandle, db: State<'_, Arc<Database>>, paths: State<'_, Arc<LibraryPaths>>, auth: State<'_, AuthClient>, entitlement: State<'_, EntitlementService>,
    action: String, project_id: String, request_id: String, input: Option<Input>) -> AppResult<Status> {
    let account = account(&auth,&entitlement).await?;
    let request = uuid::Uuid::parse_str(&request_id).map_err(|_| error("任务身份无效"))?.to_string();
    if db.get_project(&project_id)?.is_none() { return Err(error("项目不存在")); }
    let _guard = IO.lock().await;
    let directory: PathBuf = paths.root.join("comfy-video"); fs::create_dir_all(&directory)?;
    let path = directory.join(format!("{request}.json"));
    let mut record: Record = if path.exists() { serde_json::from_slice(&fs::read(&path)?)? } else {
        if action != "start" { return Ok(status("unknown","未找到本地提交记录；请核对本机队列，不会重新提交")); }
        let input = input.clone().ok_or_else(|| error("缺少视频参数"))?;
        endpoint(&input.endpoint)?; dimensions(&input)?;
        if input.first_frame.is_empty() || input.prompt.trim().is_empty() || input.prompt.chars().count() > 16000 { return Err(error("请提供首帧及 1–16000 字提示词")); }
        Record { account:account.clone(),project:project_id.clone(),input,prompt_id:None,submitted:false,asset_id:None,failure:None }
    };
    if record.account != account || record.project != project_id || input.as_ref().is_some_and(|i| i != &record.input) { return Err(error("任务归属或参数不匹配")); }
    let http = client()?;
    let owner = || { let login = auth.snapshot(); if login.logged_in && login.user_id.as_deref() == Some(account.as_str()) { Ok(()) } else { Err(error("账号已切换，请登录原账号后继续")) } };
    if action == "start" && !path.exists() { save(&path,&record)?; start(&http,&db,&path,&mut record,&request,&owner).await?; }
    else if !matches!(action.as_str(),"start"|"status") { return Err(error("未知的视频操作")); }
    let result = poll(&http,&db,&paths,&path,&mut record,&request,&owner).await?;
    if result.asset.is_some() { let _ = app.emit("library://assets-changed",()); }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Input { Input { endpoint:"http://127.0.0.1:8188".into(), seconds:8.0, ratio:"9:16".into(), resolution:0.8, first_frame:"first".into(), last_frame:None, prompt:"test prompt".into() } }
    #[test]
    fn h3_graph_preserves_native_audio_branch_and_exact_parameters() {
        let mut i=input();
        for (ratio,resolution,expected) in [("9:16",0.6,(608,1056)),("9:16",0.8,(672,1216)),("9:16",1.0,(768,1376)),("16:9",1.0,(1376,768)),("4:3",0.6,(928,672))] {
            i.ratio=ratio.into();i.resolution=resolution;
            let (w,h,frames)=dimensions(&i).unwrap();assert_eq!((w,h),expected);assert_eq!(frames,192);
        }
        let graph=graph(&i,"first.png",Some("last.png"),42,"request").unwrap();
        assert_eq!(graph["9"]["inputs"]["last_frame"],json!(["30",0]));
        assert_eq!(graph["30"]["inputs"]["image"],"last.png");
        assert_eq!(graph["10"]["inputs"]["noise_seed"],42);
        assert_eq!(graph["26"]["inputs"]["audio"],json!(["16",0]));
        assert_eq!(graph["13"]["inputs"]["steps"],8);
        assert_eq!(graph["27"]["inputs"]["format.codec"],"auto");
        assert_eq!(graph.as_object().unwrap().values().filter(|v|v["class_type"]=="SaveVideo").count(),1);
        assert!(!graph.to_string().contains("Upscale"));
        let single=super::graph(&i,"first.png",None,42,"request").unwrap();
        assert!(single.get("30").is_none());assert!(single["9"]["inputs"].get("last_frame").is_none());
        i.seconds=11.0;assert_eq!(dimensions(&i).unwrap().2,277);
        for seconds in [0.0,16.0,f64::NAN] { i.seconds=seconds;assert!(dimensions(&i).is_err()); }
        i=input();i.ratio="1:1".into();assert!(dimensions(&i).is_err());
        i=input();i.resolution=0.98;assert!(dimensions(&i).is_err());
    }
    #[test]
    fn h3_endpoint_is_loopback_only_and_has_no_credentials_or_extra_routes() {
        for url in ["http://127.0.0.1:8188","http://localhost:8000/","http://[::1]:8188"] { assert!(endpoint(url).is_ok(),"{url}"); }
        for url in ["https://example.com","http://192.168.1.2:8188","http://127.0.0.1:8188/prompt","http://user:pass@localhost:8188","http://localhost:8188/?x=1","file:///tmp"] { assert!(endpoint(url).is_err(),"{url}"); }
    }
    #[tokio::test]
    #[ignore = "isolated loopback mock and synthetic FFmpeg fixture; never invokes ComfyUI"]
    async fn h3_mock_upload_submit_recover_download_and_idempotent_import() {
        use axum::{Router, routing::{get,post}, Json, extract::State as AxumState};
        use std::sync::{Mutex,atomic::{AtomicUsize,Ordering}};
        struct Mock { prompt: Mutex<Option<Value>>, uploads: AtomicUsize, posts: AtomicUsize, phase: AtomicUsize, video: Vec<u8> }
        let root=std::env::temp_dir().join(format!("bowerbird-h3-{}",uuid::Uuid::new_v4()));
        let paths=LibraryPaths::init(root.clone()).unwrap();
        let db=Database::open_in_memory().unwrap();db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)",[]).unwrap();
        let source=root.join("frame.png");image::RgbImage::new(32,32).save(&source).unwrap();
        let frame=ingest::ingest_generated(&paths,&db,&source,None,"test").unwrap();
        let video=root.join("fixture.mp4");
        let output=crate::media::tools::command(crate::media::tools::resolve(crate::media::tools::Tool::Ffmpeg).unwrap())
            .args(["-y","-f","lavfi","-i","color=c=blue:s=64x96:r=24","-t","0.25","-pix_fmt","yuv420p"]).arg(&video).output().unwrap();
        assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
        let shared=Arc::new(Mock { prompt:Mutex::new(None),uploads:AtomicUsize::new(0),posts:AtomicUsize::new(0),phase:AtomicUsize::new(0),video:fs::read(video).unwrap() });
        let mut info=json!({});
        for node in graph(&input(),"x",None,0,"r").unwrap().as_object().unwrap().values() { info[node["class_type"].as_str().unwrap()]=json!({"input":{"required":{}}}); }
        for (class,field,models) in [("UNETLoader","unet_name",vec![UNET]),("CLIPLoader","clip_name",vec![CLIP]),("VAELoader","vae_name",vec![VAE,AUDIO]),("LoraLoaderModelOnly","lora_name",vec![LORA])] { info[class]["input"]["required"][field]=json!([models]); }
        async fn history(AxumState(s): AxumState<Arc<Mock>>) -> Json<Value> {
            let prompt=s.prompt.lock().unwrap().clone().unwrap();
            match s.phase.load(Ordering::SeqCst) {
                0 => Json(json!({})),
                1 => Json(json!({"mock-id":{"prompt":[0,"mock-id",prompt["prompt"],prompt["extra_data"],[]],"status":{"completed":true,"status_str":"success"},"outputs":{"27":{"images":[{"filename":"clip.mp4","subfolder":"video/Bowerbird","type":"output"}]}}}})),
                _ => Json(json!({"mock-id":{"status":{"completed":false,"status_str":"error","messages":[["execution_error",{"exception_message":"mock GPU error"}]]}}}))
            }
        }
        let app=Router::new().route("/object_info",get(move || async move {Json(info)}))
            .route("/upload/image",post(|AxumState(s): AxumState<Arc<Mock>>, body: axum::body::Bytes| async move {
                assert!(body.windows(8).any(|w|w==b"\x89PNG\r\n\x1a\n"));
                let n=s.uploads.fetch_add(1,Ordering::SeqCst);Json(json!({"name":format!("{n}.png"),"subfolder":"bowerbird","type":"input"}))
            }))
            .route("/prompt",post(|AxumState(s): AxumState<Arc<Mock>>, Json(body): Json<Value>| async move {
                s.posts.fetch_add(1,Ordering::SeqCst);*s.prompt.lock().unwrap()=Some(body);Json(json!({"prompt_id":"mock-id"}))
            }))
            .route("/queue",get(|AxumState(s): AxumState<Arc<Mock>>| async move {
                let prompt=s.prompt.lock().unwrap().clone().unwrap();
                Json(if s.phase.load(Ordering::SeqCst)==0 {json!({"queue_running":[[0,"mock-id",prompt["prompt"],prompt["extra_data"],[]]],"queue_pending":[]})} else {json!({"queue_running":[],"queue_pending":[]})})
            })).route("/history",get(history)).route("/history/:id",get(history))
            .route("/view",get(|AxumState(s): AxumState<Arc<Mock>>| async move {s.video.clone()})).with_state(shared.clone());
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base=format!("http://{}",listener.local_addr().unwrap());
        let server=tokio::spawn(async move {axum::serve(listener,app).await.unwrap()});
        let mut i=input();i.endpoint=base;i.first_frame=frame.id.clone();i.last_frame=Some(frame.id.clone());
        let request=uuid::Uuid::new_v4().to_string();let path=root.join(format!("{request}.json"));
        let mut record=Record {account:"tester".into(),project:"p".into(),input:i,prompt_id:None,submitted:false,asset_id:None,failure:None};
        save(&path,&record).unwrap();let http=client().unwrap();
        start(&http,&db,&path,&mut record,&request,&|| Ok(())).await.unwrap();
        assert_eq!(shared.uploads.load(Ordering::SeqCst),2);assert_eq!(shared.posts.load(Ordering::SeqCst),1);
        // Simulate losing the POST response; recovery discovers the original queue item.
        record.prompt_id=None;save(&path,&record).unwrap();
        assert_eq!(poll(&http,&db,&paths,&path,&mut record,&request,&|| Ok(())).await.unwrap().status,"running");
        assert_eq!(record.prompt_id.as_deref(),Some("mock-id"));
        shared.phase.store(1,Ordering::SeqCst);
        let done=poll(&http,&db,&paths,&path,&mut record,&request,&|| Ok(())).await.unwrap();
        let asset=done.asset.unwrap();assert_eq!(done.status,"done");assert_eq!(asset.ext.as_deref(),Some("mp4"));assert_eq!(asset.width,Some(64));
        // Simulate a crash after DB import but before the JSON checkpoint.
        record.asset_id=None;save(&path,&record).unwrap();
        let again=poll(&http,&db,&paths,&path,&mut record,&request,&|| Ok(())).await.unwrap();assert_eq!(again.asset.unwrap().id,asset.id);
        assert_eq!(db.count_assets(None).unwrap(),2);assert_eq!(shared.posts.load(Ordering::SeqCst),1);
        record.asset_id=None;shared.phase.store(2,Ordering::SeqCst);
        let failed=poll(&http,&db,&paths,&path,&mut record,&request,&|| Ok(())).await.unwrap();assert_eq!(failed.status,"failed");assert!(failed.message.contains("mock GPU error"));
        let mut denied=Record {account:"tester".into(),project:"p".into(),input:record.input.clone(),prompt_id:None,submitted:false,asset_id:None,failure:None};
        let denied_path=root.join("denied.json");
        assert!(start(&http,&db,&denied_path,&mut denied,"denied",&|| Err(error("account switched"))).await.is_err());
        assert!(!denied.submitted);assert_eq!(shared.posts.load(Ordering::SeqCst),1);
        assert!(poll(&http,&db,&paths,&path,&mut record,&request,&|| Err(error("account switched"))).await.is_err());
        server.abort();let _=server.await;drop(db);fs::remove_dir_all(root).unwrap();
    }
}
