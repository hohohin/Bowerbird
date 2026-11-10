use super::*;

pub(super) async fn plan(root: &Path, id: &str, data: &Value, cloud: &CloudClient, auth: &AuthClient) -> AppResult<Value> {
    let value = read(root,id)?;
    let data = value.get("planInput").unwrap_or(data);
    let analyses = value["analysis"].as_array().ok_or_else(|| error("请先完成视频分析"))?;
    if value["speech"].is_null() { return Err(error("请先完成实际语音识别")); }
    let persona = field(data,"persona"); let rules = field(data,"rules");
    if persona.trim().is_empty() || rules.trim().is_empty() || persona.chars().count()>8000 || rules.chars().count()>15000
        || field(data,"direction").chars().count()>8000 { return Err(error("请检查改写人设、方向与规范长度")); }
    if value.get("planInput").is_none() { patch(root,id,json!({"planInput":data}))?; }
    let mut prompts = Vec::new();
    for analysis in analyses {
        let index = analysis["index"].as_u64().ok_or_else(|| error("分镜编号无效"))?;
        let start = analysis["sourceStart"].as_f64().unwrap_or(0.0);
        let end = analysis["sourceEnd"].as_f64().unwrap_or(start);
        let lines: Vec<Value> = value["speech"]["utterances"].as_array().into_iter().flatten()
            .filter(|u| u["startMs"].as_f64().unwrap_or(0.0) < end*1000.0 && u["endMs"].as_f64().unwrap_or(0.0) > start*1000.0).cloned().collect();
        let input = json!({"shot":analysis,"actualSpeech":lines,"direction":data["direction"]}).to_string();
        let result = stage(root,id,&format!("rewrite-{index:03}"),json!({"operation":"text-rewrite","image":null,
            "rewrite":{"inputText":input,"persona":persona,"rules":format!("{rules}\n只输出这一段可直接交给视频模型的完整提示词。明确主体、动作、机位和实际需要说出的对白；需要对白时明确生成有声视频。不要输出解释、时间戳或字幕。"),"product":null}}),cloud,auth).await?;
        prompts.push(json!({"index":index,"prompt":result["text"],"duration":(end-start).ceil().clamp(4.0,15.0)}));
    }
    patch(root,id,json!({"prompts":prompts,"state":"planned","message":"请检查各段提示词后生成","error":""}))
}

async fn generated(app: &tauri::AppHandle, root: &Path, id: &str, index: usize, prompt: &str, duration: u32, project: &str) -> AppResult<PathBuf> {
    let db = app.state::<Arc<Database>>();
    let job_id = format!("{:x}",Sha256::digest(format!("enhanced:{id}:{index}")))[..32].to_owned();
    let receipt = format!("generation{index}");
    let value = read(root,id)?;
    if value[&receipt].is_null() {
        patch(root,id,json!({receipt.clone():{"jobId":job_id,"pending":true}}))?;
        // Existing command owns entitlement, persistent generation, ingestion and recovery.
        let result = crate::commands::codex::codex_create_image(
            app.clone(),app.state(),app.state(),app.state(),app.state(),app.state(),app.state(),
            prompt.to_owned(),Some(prompt.to_owned()),None,vec![],None,Some(true),Some("video".into()),
            Some(crate::codex::types::VideoOptions { kind:"text2video".into(),model_version:"seedance2.5".into(),duration,video_resolution:"720p".into() }),
            Some(1),Some(false),None,Some(value["ratio"].as_str().unwrap_or("16:9").into()),Some("jimeng".into()),Some(project.into()),None,None,
            job_id.clone(),None,None,None,None,Some(job_id.clone()),None,None,None,None,Some(false),None,
        ).await;
        if let Err(e) = result {
            // This command persists its job before starting provider work. A rejected
            // preflight with no job can be retried after fixing login/entitlement.
            if crate::core::task_queue::Task::by_id(&db,&job_id)?.is_none() { patch(root,id,json!({receipt:Value::Null}))?; }
            return Err(e);
        }
    }
    for _ in 0..720 {
        if let Some(history) = db.generation_history_by_job(&job_id,None)? {
            if let Some(path) = history.turns.iter().filter(|t| t.project_id.as_deref() == Some(project) && t.media == "video")
                .flat_map(|t| &t.images).next() { return Ok(PathBuf::from(path)); }
        }
        let task = crate::core::task_queue::Task::by_id(&db,&job_id)?
            .ok_or_else(|| error("未找到原生成任务；为避免重复提交，请先检查生成记录"))?;
        if matches!(task.status.as_str(),"failed"|"cancelled") { return Err(error("此段生成未完成，请在原生成任务中查看原因；未重新提交")); }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
    Err(error("生成仍在处理，可稍后恢复原任务"))
}

fn timestamp(ms: u64) -> String { format!("{:02}:{:02}:{:02},{:03}",ms/3600000,ms/60000%60,ms/1000%60,ms%1000) }
fn subtitles(speech: &Value, duration: f64, offset: f64) -> AppResult<(String,Vec<Value>)> {
    let mut srt = String::new(); let mut events = Vec::new(); let mut previous = 0.0;
    let lines = speech["utterances"].as_array().ok_or_else(|| error("语音识别结果缺少时间信息"))?;
    for line in lines {
        let start = line["startMs"].as_f64().ok_or_else(|| error("字幕时间无效"))?/1000.0;
        let end = line["endMs"].as_f64().ok_or_else(|| error("字幕时间无效"))?/1000.0;
        if !start.is_finite() || !end.is_finite() || start < previous || end <= start || end > duration+0.25 { return Err(error("字幕时间超出实际视频范围")); }
        previous = end;
        let text = field(line,"text").replace(['\r','\n']," ").replace(['<','>','{','}'], "");
        if text.trim().is_empty() { continue; }
        let end = end.min(duration);
        srt.push_str(&format!("{}\n{} --> {}\n{}\n\n",events.len()+1,timestamp((start*1000.0).round() as u64),timestamp((end*1000.0).round() as u64),text));
        events.push(json!({"text":text,"localStart":start,"localEnd":end,"start":offset+start,"end":offset+end,"words":line["words"]}));
    }
    Ok((srt,events))
}

pub(super) async fn finish(app: &tauri::AppHandle, root: &Path, id: &str, project: &str, data: &Value, cloud: &CloudClient, auth: &AuthClient) -> AppResult<Value> {
    let value = read(root,id)?;
    if value["state"] == "finished" && value["outputPath"].as_str().is_some_and(|path| Path::new(path).is_file()) { return Ok(value); }
    let capabilities = cloud_request(cloud,auth,json!({"action":"replication-capabilities"})).await?;
    if !capabilities["services"].as_array().is_some_and(|services| services.iter().any(|s| s["operation"] == "speech-transcription" && s["available"] == true)) {
        return Err(error("Cloud 语音服务尚未开放，不能开始成片生成"));
    }
    let prompts = data["prompts"].as_array().ok_or_else(|| error("缺少分镜提示词"))?;
    let count = value["slices"].as_array().map_or(0,Vec::len);
    if prompts.len() != count || count == 0 { return Err(error("分镜数量与切片不一致")); }
    for (index,prompt) in prompts.iter().enumerate() {
        if prompt["index"].as_u64() != Some(index as u64) || field(prompt,"prompt").trim().is_empty() || field(prompt,"prompt").chars().count()>12000
            || !matches!(prompt["duration"].as_u64(),Some(4..=15)) { return Err(error("请检查分镜提示词和时长（4–15 秒）")); }
        markers::parse(field(prompt,"prompt"))?;
    }
    if let Some(frozen) = value.get("frozenPrompts") { if frozen != &data["prompts"] { return Err(error("生成已开始，不能改变原任务的提示词")); } }
    else { patch(root,id,json!({"frozenPrompts":data["prompts"]}))?; }
    let directory = folder(root,id)?;
    let mut offset = 0.0; let mut events = Vec::new(); let mut marker_events = Vec::new(); let mut concat = String::new();
    for (index,prompt) in prompts.iter().enumerate() {
        patch(root,id,json!({"message":format!("正在生成及合成第 {} / {} 段",index+1,count)}))?;
        let (clean_prompt,markers) = markers::parse(field(prompt,"prompt"))?;
        let source = generated(app,root,id,index,&clean_prompt,prompt["duration"].as_u64().unwrap() as u32,project).await?;
        let copied = directory.join(format!("generated-{index:03}.mp4"));
        if !copied.exists() { fs::copy(&source,&copied)?; if hash(&source)? != hash(&copied)? { return Err(error("生成视频复制校验失败")); } }
        let meta = crate::media::probe::probe(&copied)?;
        let speech = speech(root,id,&format!("generated-speech-{index:03}"),&copied,cloud,auth).await?;
        let (srt,mut clip_events) = subtitles(&speech,meta.duration,offset)?;
        for mut event in markers::align(&markers,&speech,offset) { event["shotIndex"] = json!(index); marker_events.push(event); }
        let actual = render_clip(&directory,index,&copied,&srt,meta.duration,value["ratio"] == "9:16",speech["timingSource"] == "no-audio-track").await?;
        events.append(&mut clip_events); offset += actual;
        concat.push_str(&format!("file 'finished-{index:03}.mp4'\n"));
    }
    let list = directory.join("concat.txt"); fs::write(&list,concat)?;
    let output = directory.join("finished.mp4");
    let mut args: Vec<std::ffi::OsString> = ["-hide_banner","-loglevel","error","-nostdin","-y","-f","concat","-safe","1","-i"].iter().map(|v| (*v).into()).collect();
    args.push(list.into_os_string()); args.extend(["-c","copy","-movflags","+faststart"].iter().map(|v| (*v).into())); args.push(output.clone().into_os_string()); run(args).await?;
    if (crate::media::probe::probe(&output)?.duration-offset).abs()>0.3 { return Err(error("成片时长校验失败")); }
    patch(root,id,json!({"state":"finished","message":"成片完成","outputPath":output,"duration":offset,"subtitleEvents":events,"markerEvents":marker_events,"error":""}))
}

async fn render_clip(directory: &Path, index: usize, source: &Path, srt: &str, duration: f64, portrait: bool, silent: bool) -> AppResult<f64> {
    let filter_path = format!("captions-{index:03}.srt");
    fs::write(directory.join(&filter_path),srt.as_bytes())?;
    let output = directory.join(format!("finished-{index:03}.mp4"));
    let size = if portrait { "720:1280" } else { "1280:720" };
    let filter = format!("scale={size}:force_original_aspect_ratio=decrease,pad={size}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30{}",
        if srt.is_empty() { String::new() } else { format!(",subtitles=filename='{filter_path}':force_style='FontSize=24,Outline=2,MarginV=28'") });
    let mut args: Vec<std::ffi::OsString> = ["-hide_banner","-loglevel","error","-nostdin","-y","-i"].iter().map(|v| (*v).into()).collect();
    args.push(source.into());
    args.extend(["-f","lavfi","-i","anullsrc=r=48000:cl=stereo","-map","0:v:0","-map"].iter().map(|v| (*v).into()));
    args.push(if silent { "1:a:0" } else { "0:a:0" }.into());
    args.extend(["-vf".into(),filter.into(),"-t".into(),duration.to_string().into()]);
    args.extend(["-c:v","libx264","-preset","veryfast","-crf","20","-pix_fmt","yuv420p","-c:a","aac","-ar","48000","-ac","2","-movflags","+faststart"].iter().map(|v| (*v).into()));
    args.push(output.clone().into_os_string()); run_in(args,Some(directory)).await?;
    let actual = crate::media::probe::probe(&output)?.duration;
    if (actual-duration).abs()>0.15 { return Err(error("字幕合成后时长校验失败")); }
    Ok(actual)
}

#[cfg(test)] mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires local FFmpeg; synthetic files only"]
    async fn real_caption_render_handles_silent_portrait_and_quoted_directory() {
        let directory=std::env::temp_dir().join(format!("caption's test {}",uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let source=directory.join("source.mp4");
        let mut args: Vec<std::ffi::OsString> = ["-v","error","-y","-f","lavfi","-i","color=blue:s=180x320:r=25:d=1","-c:v","libx264","-pix_fmt","yuv420p"].iter().map(|v| (*v).into()).collect();
        args.push(source.clone().into_os_string()); run(args).await.unwrap();
        let speech=json!({"utterances":[{"text":"真实字幕","startMs":100,"endMs":800,"words":[]}]});
        let (srt,_)=subtitles(&speech,1.0,0.0).unwrap();
        let duration=render_clip(&directory,0,&source,&srt,1.0,true,true).await.unwrap();
        assert!((duration-1.0).abs()<0.15);
        let meta=crate::media::probe::probe(&directory.join("finished-000.mp4")).unwrap();
        assert_eq!((meta.width,meta.height),(720,1280));
        fs::remove_dir_all(&directory).unwrap();
    }
    #[test] fn captions_use_actual_local_and_final_times() {
        let speech=json!({"utterances":[{"text":"你好\n世界","startMs":200,"endMs":900,"words":[]}]});
        let (srt,events)=subtitles(&speech,1.0,4.2).unwrap();
        assert!(srt.contains("00:00:00,200 --> 00:00:00,900\n你好 世界"));
        assert_eq!(events[0]["localStart"],0.2); assert_eq!(events[0]["start"],4.4);
        assert!(subtitles(&speech,0.5,0.0).is_err());
        assert!(subtitles(&json!({"utterances":[]}),1.0,0.0).unwrap().0.is_empty());
    }
}
