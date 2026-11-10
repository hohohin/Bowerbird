//! Local shot evidence. Model analysis and speech timing remain separate facts.
use super::*;
mod finish;
mod markers;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Slice {
    pub index: usize,
    pub start: f64,
    pub end: f64,
    pub boundary: String,
}

pub(super) async fn frame(root: &Path, project: &str, data: &Value) -> AppResult<Value> {
    let id = field(data, "id");
    let preparation = root.join("enhanced");
    let record = own(&preparation, id, project)?;
    let index = data["index"].as_u64().ok_or_else(|| error("请选择有效镜头"))? as usize;
    let shots: Vec<Slice> = serde_json::from_value(record["slices"].clone())?;
    let shot = shots.iter().find(|s| s.index == index).ok_or_else(|| error("镜头不存在"))?;
    let (reference, source) = verified_reference(root, field(&record, "referenceId"), project)?;
    if reference["hash"] != record["sourceHash"] { return Err(error("原片已改变，请重新获取视频")); }
    let time = (shot.start + shot.end) / 2.0;
    let target = folder(&preparation, id)?.join(format!("frame-{index:03}.jpg"));
    if !target.exists() {
        let mut args: Vec<std::ffi::OsString> = ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss"].iter().map(|v| (*v).into()).collect();
        args.extend([time.to_string().into(), "-i".into(), source.into_os_string()]);
        args.extend(["-frames:v", "1", "-vf", "scale=1280:1280:force_original_aspect_ratio=decrease", "-q:v", "2", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"].iter().map(|v| (*v).into()));
        let bytes = run(args).await?.stdout;
        if bytes.is_empty() { return Err(error("关键帧提取失败，请重试")); }
        fs::write(&target, bytes)?;
    }
    Ok(json!({"index":index,"time":time,"dataUrl":format!("data:image/jpeg;base64,{}",base64::engine::general_purpose::STANDARD.encode(fs::read(target)?))}))
}

fn slices(duration: f64, candidates: &[f64]) -> AppResult<Vec<Slice>> {
    if !duration.is_finite() || duration <= 0.0 || duration > 120.2 {
        return Err(error("参考视频时长无效，请选择不超过两分钟的视频"));
    }
    let mut cuts: Vec<f64> = candidates.iter().copied()
        .filter(|t| t.is_finite() && *t >= 0.3 && *t <= duration - 0.3).collect();
    cuts.sort_by(f64::total_cmp);
    let mut boundaries = vec![(0.0, "start")];
    for cut in cuts {
        if cut - boundaries.last().unwrap().0 >= 0.3 {
            boundaries.push((cut, "scene"));
        }
    }
    boundaries.push((duration, "end"));
    let mut result = Vec::new();
    for pair in boundaries.windows(2) {
        // Long uncut shots are divided for analysis, never described as detected cuts.
        let count = ((pair[1].0 - pair[0].0) / 15.0).ceil() as usize;
        for n in 0..count {
            result.push(Slice { index: result.len(),
                start: pair[0].0 + (pair[1].0 - pair[0].0) * n as f64 / count as f64,
                end: pair[0].0 + (pair[1].0 - pair[0].0) * (n + 1) as f64 / count as f64,
                boundary: if n == 0 { pair[0].1 } else { "duration" }.into() });
        }
    }
    if result.len() > 120 { return Err(error("检测到过多快速切换，请缩短参考视频后再试")); }
    Ok(result)
}

async fn run(args: Vec<std::ffi::OsString>) -> AppResult<std::process::Output> {
    run_in(args,None).await
}
async fn run_in(args: Vec<std::ffi::OsString>, directory: Option<&Path>) -> AppResult<std::process::Output> {
    let mut command = tokio::process::Command::new(crate::media::tools::resolve(crate::media::tools::Tool::Ffmpeg)?);
    #[cfg(windows)] command.creation_flags(0x08000000);
    command.kill_on_drop(true).args(args);
    if let Some(directory) = directory { command.current_dir(directory); }
    let output = tokio::time::timeout(std::time::Duration::from_secs(300), command.output()).await
        .map_err(|_| error("视频切片处理超时，请缩短视频后重试"))??;
    if !output.status.success() { return Err(error("视频切片处理失败，请检查原视频和 FFmpeg")); }
    Ok(output)
}

pub(super) async fn prepare(root: PathBuf, project: String, reference_id: String) -> AppResult<Value> {
    let (reference, source) = verified_reference(&root, &reference_id, &project)?;
    let duration = reference["duration"].as_f64().ok_or_else(|| error("视频时长无效"))?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let preparation_root = root.join("enhanced");
    let directory = folder(&preparation_root, &id)?;
    fs::create_dir_all(&directory)?;
    let mut args: Vec<std::ffi::OsString> = ["-hide_banner", "-nostdin", "-i"].iter().map(|value| (*value).into()).collect();
    args.push(source.clone().into_os_string());
    args.extend(["-an", "-vf", "scale=320:320:force_original_aspect_ratio=decrease,select='gt(scene,0.3)',showinfo", "-fps_mode", "vfr", "-f", "null", "-"].iter().map(|value| (*value).into()));
    let output = run(args).await?;
    let candidates: Vec<f64> = String::from_utf8_lossy(&output.stderr).lines()
        .filter_map(|line| line.split("pts_time:").nth(1)?.split_whitespace().next()?.parse().ok()).collect();
    let shots = slices(duration, &candidates)?;
    for shot in &shots {
        let target = directory.join(format!("slice-{:03}.mp4", shot.index));
        let mut args: Vec<std::ffi::OsString> = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"].iter().map(|value| (*value).into()).collect();
        args.push(source.clone().into_os_string());
        args.extend(["-ss".into(), shot.start.to_string().into(), "-t".into(), (shot.end-shot.start).to_string().into()]);
        args.extend(["-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=10", "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"].iter().map(|value| (*value).into()));
        args.push(target.clone().into_os_string());
        run(args).await?;
        let meta = crate::media::probe::probe(&target)?;
        if meta.size == 0 || meta.size > 35 * 1024 * 1024 || (meta.duration - (shot.end-shot.start)).abs() > 0.25 {
            return Err(error("视频切片校验失败，尚未提交分析"));
        }
    }
    if hash(&source)? != field(&reference, "hash") { return Err(error("处理期间参考视频发生变化，请重新获取")); }
    let meta = crate::media::probe::probe(&source)?;
    let record = json!({"id":id,"kind":"enhanced-preparation","projectId":project,"referenceId":reference_id,"ratio":if meta.height>meta.width {"9:16"} else {"16:9"},
        "sourceHash":reference["hash"],"createdAt":now(),"schemaVersion":1,"duration":duration,"slices":shots});
    save(&preparation_root, &record)?;
    Ok(record)
}

/// Each paid stage has its own immutable receipt. An uncertain submission is queried,
/// never silently replaced by a new request key.
async fn stage(root: &Path, id: &str, name: &str, mut request: Value, cloud: &CloudClient, auth: &AuthClient) -> AppResult<Value> {
    let owner = field(&read(root,id)?,"cloudUserId").to_owned();
    if owner.is_empty() || auth.snapshot().user_id.as_deref() != Some(owner.as_str()) { return Err(error("账号已切换，请登录此强化复刻任务原账号后恢复")); }
    let receipt_root = folder(root, id)?.join("stages");
    fs::create_dir_all(&receipt_root)?;
    let key = format!("replication:{id}:{name}");
    let receipt_id = format!("{:x}", Sha256::digest(name.as_bytes()))[..32].to_owned();
    let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&request)?));
    let mut receipt = match read(&receipt_root, &receipt_id) {
        Ok(value) => {
            if value["inputHash"] != digest { return Err(error("此步骤的输入已改变，请建立新的强化复刻任务")); }
            value
        },
        Err(_) if !folder(&receipt_root, &receipt_id)?.join("record.json").exists() => {
            let value = json!({"id":receipt_id,"stage":name,"inputHash":digest,"pending":false});
            save(&receipt_root,&value)?; value
        },
        Err(e) => return Err(e),
    };
    if !receipt["result"].is_null() { return Ok(receipt["result"].clone()); }
    let mut response = if !field(&receipt,"remoteTaskId").is_empty() {
        cloud_request(cloud,auth,json!({"action":"get","job_id":receipt["remoteTaskId"]})).await?
    } else if receipt["pending"] == true {
        cloud_request(cloud,auth,json!({"action":"get-by-key","idempotency_key":key})).await?
    } else {
        receipt["pending"] = json!(true); save(&receipt_root,&receipt)?;
        request["action"] = json!("create"); request["idempotency_key"] = json!(key);
        let url = cloud.config().endpoint("understand-proxy").ok_or_else(|| error("当前构建未配置 Bowerbird Cloud"))?;
        let response = auth.send_authorized_for_user(cloud.http().post(url).json(&request),"强化复刻 Cloud 请求失败",&owner).await?;
        let status = response.status();
        let result: Value = response.json().await.map_err(|_| error("Cloud 返回格式无效"))?;
        if !status.is_success() {
            // Explicit validation/auth/balance rejections precede durable acceptance.
            // Transport errors and server errors keep the pending receipt for lookup.
            if matches!(status.as_u16(),400|401|402|403) { receipt["pending"] = json!(false); save(&receipt_root,&receipt)?; }
            return Err(error(result.pointer("/error/message").and_then(Value::as_str).unwrap_or("Cloud 请求未完成")));
        }
        result
    };
    if field(&response,"job_id").is_empty() { return Err(error("尚未查到原 Cloud 任务，请稍后恢复；未重复提交")); }
    receipt["remoteTaskId"] = response["job_id"].clone();
    save(&receipt_root,&receipt)?;
    for _ in 0..360 {
        match field(&response,"status") {
            "succeeded" => {
                let text = field(&response,"text");
                if text.is_empty() { return Err(error("Cloud 结果为空或已过期")); }
                receipt["result"] = serde_json::from_str(text).unwrap_or(json!({"text":text}));
                receipt["charge"] = response["charge"].clone(); save(&receipt_root,&receipt)?;
                return Ok(receipt["result"].clone());
            },
            "uploading" | "queued" | "leased" | "running" | "cancel_requested" => (),
            _ => return Err(error(response.pointer("/error/message").and_then(Value::as_str).unwrap_or("Cloud 任务尚未完成"))),
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        response = cloud_request(cloud,auth,json!({"action":"get","job_id":receipt["remoteTaskId"]})).await?;
    }
    Err(error("等待已结束，可稍后恢复原任务"))
}

async fn analyze(root: &Path, id: &str, project: &str, cloud: &CloudClient, auth: &AuthClient) -> AppResult<Value> {
    let value = own(root,id,project)?;
    let capabilities = cloud_request(cloud,auth,json!({"action":"replication-capabilities"})).await?;
    for operation in ["video-analysis","speech-transcription"] {
        if !capabilities["services"].as_array().is_some_and(|services| services.iter().any(|s| s["operation"] == operation && s["available"] == true)) {
            return Err(error("强化复刻所需的 Cloud 分析或语音服务尚未开放"));
        }
    }
    let source_root = root.parent().ok_or_else(|| error("复刻目录无效"))?;
    let (reference, source) = verified_reference(source_root,field(&value,"referenceId"),project)?;
    if reference["hash"] != value["sourceHash"] { return Err(error("参考视频发生变化，请重新准备切片")); }
    let shots: Vec<Slice> = serde_json::from_value(value["slices"].clone())?;
    let directory = folder(root,id)?;
    let mut results = Vec::new();
    for shot in shots {
        patch(root,id,json!({"message":format!("正在分析第 {} 段",shot.index+1)}))?;
        let file = directory.join(format!("slice-{:03}.mp4",shot.index));
        let meta = crate::media::probe::probe(&file)?;
        let request = json!({"operation":"video-analysis","image":null,"video":{"mime":"video/mp4",
            "duration":meta.duration,"base64":base64::engine::general_purpose::STANDARD.encode(fs::read(&file)?),
            "settings":{"fps":2,"transcribe":false,"thinking":"default"}}});
        let analysis = stage(root,id,&format!("analysis-{:03}",shot.index),request,cloud,auth).await?;
        results.push(json!({"index":shot.index,"sourceStart":shot.start,"sourceEnd":shot.end,"analysis":analysis}));
        patch(root,id,json!({"analysis":results}))?;
    }
    patch(root,id,json!({"message":"正在识别原片实际语音"}))?;
    let speech = speech(root,id,"source-speech",&source,cloud,auth).await?;
    patch(root,id,json!({"state":"analyzed","speech":speech,"message":"切片与语音分析完成","error":""}))
}

async fn speech(root: &Path, id: &str, name: &str, source: &Path, cloud: &CloudClient, auth: &AuthClient) -> AppResult<Value> {
    // Probe audio presence explicitly: a failed decoder must not masquerade as silence.
    let mut probe = tokio::process::Command::new(crate::media::tools::resolve(crate::media::tools::Tool::Ffprobe)?);
    #[cfg(windows)] probe.creation_flags(0x08000000);
    probe.kill_on_drop(true).args(["-v","error","-select_streams","a:0","-show_entries","stream=index","-of","json"]).arg(source);
    let output = tokio::time::timeout(std::time::Duration::from_secs(30),probe.output()).await
        .map_err(|_| error("检查音轨超时"))??;
    if !output.status.success() { return Err(error("无法检查视频音轨")); }
    let info: Value = serde_json::from_slice(&output.stdout)?;
    if info["streams"].as_array().is_some_and(|streams| streams.is_empty()) {
        return Ok(json!({"text":"","utterances":[],"timingSource":"no-audio-track"}));
    }
    let target = folder(root,id)?.join(format!("{name}.wav"));
    if !target.exists() {
        let mut args: Vec<std::ffi::OsString> = ["-hide_banner","-loglevel","error","-nostdin","-y","-i"].iter().map(|v| (*v).into()).collect();
        args.push(source.into());
        args.extend(["-map","0:a:0","-vn","-ac","1","-ar","16000","-c:a","pcm_s16le"].iter().map(|v| (*v).into()));
        let temporary = target.with_extension("pending.wav");
        args.push(temporary.clone().into_os_string()); run(args).await?;
        fs::rename(temporary,&target)?;
    }
    let duration = crate::media::audio::decode(&target)?.duration;
    if duration <= 0.0 || duration > 120.2 { return Err(error("提取音轨时长超出两分钟限制")); }
    stage(root,id,name,json!({"operation":"speech-transcription","image":null,"audio":{"mime":"audio/wav",
        "duration":duration,"base64":base64::engine::general_purpose::STANDARD.encode(fs::read(target)?)}}),cloud,auth).await
}

pub(super) fn handle(app: &tauri::AppHandle, root: PathBuf, project: String, action: &str, data: Value) -> AppResult<Value> {
    let root = root.join("enhanced");
    let id = field(&data,"id").to_owned();
    let value = own(&root,&id,&project)?;
    if action == "enhanced-finish" && value["state"] == "finished" && value["outputPath"].as_str().is_some_and(|path| Path::new(path).is_file()) { return Ok(value); }
    if action == "enhanced-save" {
        let active = ACTIVE.lock().unwrap();
        if active.contains(&format!("enhanced:{id}")) || !value["frozenPrompts"].is_null() { return Err(error("任务运行中或已开始生成，不能修改分镜")); }
        let prompts = data["prompts"].as_array().ok_or_else(|| error("分镜格式无效"))?;
        if prompts.len() != value["slices"].as_array().map_or(0,Vec::len) { return Err(error("分镜数量不一致")); }
        for (index,prompt) in prompts.iter().enumerate() {
            if prompt["index"].as_u64() != Some(index as u64) || field(prompt,"prompt").trim().is_empty() || field(prompt,"prompt").chars().count()>12000
                || !matches!(prompt["duration"].as_u64(),Some(4..=15)) { return Err(error("分镜提示词或时长无效")); }
            markers::parse(field(prompt,"prompt"))?;
        }
        return patch(&root,&id,json!({"prompts":prompts,"message":"分镜已保存"}));
    }
    if action == "enhanced-get" {
        if value["state"] == "running" && !ACTIVE.lock().unwrap().contains(&format!("enhanced:{id}")) {
            return patch(&root,&id,json!({"state":"interrupted","message":"任务已中断，可恢复原任务"}));
        }
        return Ok(value);
    }
    if !["enhanced-analyze","enhanced-plan","enhanced-finish"].contains(&action) { return Err(error("未知强化复刻操作")); }
    let auth = app.state::<AuthClient>().inner().clone();
    let owner = auth.snapshot().user_id.ok_or_else(|| error("请先登录 Bowerbird 账号"))?;
    if !field(&value,"cloudUserId").is_empty() && value["cloudUserId"] != owner { return Err(error("请登录此强化复刻任务原账号后恢复")); }
    let action = action.to_owned();
    let active_id = format!("enhanced:{id}");
    if !ACTIVE.lock().unwrap().insert(active_id.clone()) { return Ok(value); }
    let queued = match patch(&root,&id,json!({"state":"running","resumeAction":action,"cloudUserId":owner,"error":""})) {
        Ok(value) => value,
        Err(e) => { ACTIVE.lock().unwrap().remove(&active_id); return Err(e); }
    };
    let cloud = app.state::<CloudClient>().inner().clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = match action.as_str() {
            "enhanced-plan" => finish::plan(&root,&id,&data,&cloud,&auth).await,
            "enhanced-finish" => finish::finish(&app,&root,&id,&project,&data,&cloud,&auth).await,
            _ => analyze(&root,&id,&project,&cloud,&auth).await,
        };
        if let Err(e) = result {
            let _ = patch(&root,&id,json!({"state":"interrupted","error":e.to_string(),"message":"未完成，可恢复原任务"}));
        }
        ACTIVE.lock().unwrap().remove(&active_id);
    });
    Ok(queued)
}

#[cfg(test)] mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires local FFmpeg; synthetic files only"]
    async fn real_scene_detection_prepares_contiguous_verified_clips() {
        let root = std::env::temp_dir().join(format!("enhanced-test-{}",uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("test.mp4");
        let mut args: Vec<std::ffi::OsString> = ["-v","error","-y","-f","lavfi","-i","color=red:s=320x180:r=25:d=1","-f","lavfi","-i","color=blue:s=320x180:r=25:d=1","-filter_complex","[0:v][1:v]concat=n=2:v=1:a=0","-c:v","libx264","-pix_fmt","yuv420p"].iter().map(|v| (*v).into()).collect();
        args.push(source.clone().into_os_string()); run(args).await.unwrap();
        let reference = import_reference(&root,"test",source,None).unwrap();
        let record = prepare(root.clone(),"test".into(),field(&reference,"id").into()).await.unwrap();
        let shots: Vec<Slice> = serde_json::from_value(record["slices"].clone()).unwrap();
        assert_eq!(shots.len(),2); assert!((shots[1].start-1.0).abs()<0.05);
        assert_eq!(shots[0].end,shots[1].start);
        for shot in shots {
            let path=folder(&root.join("enhanced"),field(&record,"id")).unwrap().join(format!("slice-{:03}.mp4",shot.index));
            let meta=crate::media::probe::probe(&path).unwrap();
            assert!(meta.width<=640 && meta.height<=640 && (meta.duration-1.0).abs()<0.15);
        }
        let request = json!({"id":record["id"],"index":1});
        let result = frame(&root,"test",&request).await.unwrap();
        assert!(field(&result,"dataUrl").starts_with("data:image/jpeg;base64,/9j/"));
        assert!((result["time"].as_f64().unwrap()-1.5).abs()<0.05);
        assert_eq!(frame(&root,"test",&request).await.unwrap(),result);
        assert!(frame(&root,"other",&request).await.is_err());
        assert!(frame(&root,"test",&json!({"id":record["id"],"index":999})).await.is_err());
        let (_, source) = verified_reference(&root,field(&reference,"id"),"test").unwrap();
        fs::write(source,b"replaced").unwrap();
        assert!(frame(&root,"test",&request).await.is_err());
        fs::remove_dir_all(&root).unwrap();
    }
    #[test] fn filters_nearby_and_invalid_boundaries_without_gaps() {
        let result = slices(10.0, &[f64::NAN, -1.0, 0.1, 2.0, 2.1, 7.0, 9.9, 12.0]).unwrap();
        assert_eq!(result.len(), 3);
        assert_eq!((result[0].start, result[0].end), (0.0, 2.0));
        for pair in result.windows(2) { assert_eq!(pair[0].end, pair[1].start); }
        assert_eq!(result.last().unwrap().end, 10.0);
    }
    #[test] fn long_shots_have_explicit_duration_boundaries() {
        let result = slices(31.0, &[]).unwrap();
        assert_eq!(result.len(), 3);
        assert_eq!(result[1].boundary, "duration");
        assert!(result.iter().all(|s| s.end-s.start <= 15.0));
        assert!(slices(f64::INFINITY, &[]).is_err());
        assert!(slices(0.0, &[]).is_err());
    }
}
