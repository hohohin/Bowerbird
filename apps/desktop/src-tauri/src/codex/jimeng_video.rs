//! Seedance CLI：显式模型、四模式、提交一次后持续查询。
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::sync::mpsc;
use ulid::Ulid;

use super::jimeng::dreamina_command;
use super::types::{Chunk, CodexRequest, GenOutcome, VideoOptions};
use crate::error::{AppError, AppResult};

const RATIOS: &[&str] = &["1:1", "3:4", "16:9", "4:3", "9:16", "21:9"];
const QUERY_ERROR_RETRIES: usize = 3;

fn reference_is_video(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(crate::media::probe::is_video)
}

/// 参数验证与命令编译共用，调用前端不能绕过模型、引用数及比例约束。
pub(crate) fn arguments(req: &CodexRequest, options: &VideoOptions) -> AppResult<Vec<OsString>> {
    let error = |message: &str| AppError::Jimeng(message.into());
    let (min, max) = match options.model_version.as_str() {
        "seedance2.5" => (4, 30),
        "seedance2.0" | "seedance2.0fast" | "seedance2.0_vip" | "seedance2.0fast_vip" | "seedance2.0mini" => (4, 15),
        "seedance1.5pro" if matches!(options.kind.as_str(), "image2video" | "frames2video") => (5, 12),
        "seedance1.0fast" if options.kind == "image2video" => (5, 10),
        _ => return Err(error("当前视频模式不支持此模型")),
    };
    if !(min..=max).contains(&options.duration) {
        return Err(error(&format!("当前视频模型时长须为 {min}–{max} 秒")));
    }
    let valid_resolution = match options.model_version.as_str() {
        "seedance2.5" => matches!(options.video_resolution.as_str(), "480p" | "720p" | "1080p"),
        "seedance2.0_vip" => matches!(options.video_resolution.as_str(), "720p" | "1080p" | "4k"),
        _ => options.video_resolution == "720p",
    };
    if !valid_resolution { return Err(error("当前视频模型不支持此分辨率")); }
    let (max_images, max_videos) = if options.model_version == "seedance2.5" { (30, 10) } else { (9, 3) };
    let refs = &req.reference_images;
    let videos = refs.iter().filter(|p| reference_is_video(p)).count();
    let images = refs.len() - videos;
    for path in refs {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !reference_is_video(path)
            && !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "bmp")
        {
            return Err(error("视频参考仅支持图片或视频文件；首版不支持音频"));
        }
    }
    let mut args = vec![OsString::from(&options.kind)];
    match options.kind.as_str() {
        "text2video" if refs.is_empty() => {}
        "image2video" if images == 1 && videos == 0 => {
            args.extend(["--image".into(), refs[0].as_os_str().to_owned()]);
        }
        "frames2video" if images == 2 && videos == 0 => {
            args.extend(["--first".into(), refs[0].as_os_str().to_owned(), "--last".into(), refs[1].as_os_str().to_owned()]);
        }
        "multimodal2video" if !refs.is_empty() && images <= max_images && videos <= max_videos => {
            for path in refs {
                args.extend([if reference_is_video(path) { "--video" } else { "--image" }.into(), path.as_os_str().to_owned()]);
            }
        }
        _ => return Err(error(&format!("视频模式与参考素材不匹配：文生无参考，图生一图，首尾帧两图，多参考最多 {max_images} 图 / {max_videos} 视频"))),
    }
    if req.instruction.trim().is_empty()
        && matches!(options.kind.as_str(), "text2video" | "image2video")
    {
        return Err(error("请填写视频提示词"));
    }
    if !req.instruction.trim().is_empty() {
        args.extend(["--prompt".into(), req.instruction.clone().into()]);
    }
    if matches!(options.kind.as_str(), "text2video" | "multimodal2video") {
        let ratio = req
            .ratio
            .as_deref()
            .filter(|r| !r.trim().is_empty())
            .unwrap_or("16:9");
        if !RATIOS.contains(&ratio) {
            return Err(error("视频比例仅支持 1:1、3:4、16:9、4:3、9:16、21:9"));
        }
        args.extend(["--ratio".into(), ratio.into()]);
    }
    args.extend([
        "--model_version".into(),
        options.model_version.clone().into(),
        "--duration".into(),
        options.duration.to_string().into(),
        "--video_resolution".into(),
        options.video_resolution.clone().into(),
        "--poll".into(),
        "0".into(),
    ]);
    Ok(args)
}

/// 在有计费副作用的提交前发现失效引用，避免生成后才无法入库。
/// 视频元数据（宽高/时长）由进程内 mp4 解析提供，不再要求本机装有 ffmpeg/ffprobe。
pub(crate) fn preflight(req: &CodexRequest, options: &VideoOptions) -> AppResult<()> {
    arguments(req, options)?;
    let max_duration = if options.model_version == "seedance2.5" { 30.0 } else { 15.0 };
    let mut video_duration = 0.0;
    for path in &req.reference_images {
        if !path.is_file() {
            return Err(AppError::Jimeng(format!(
                "视频参考文件不存在：{}",
                path.display()
            )));
        }
        if reference_is_video(path) {
            let meta = crate::media::probe::probe(path)?;
            if !(2.0..=max_duration).contains(&meta.duration) {
                return Err(AppError::Jimeng(format!("每条参考视频须为 2–{max_duration} 秒")));
            }
            video_duration += meta.duration;
        }
    }
    if video_duration > max_duration {
        return Err(AppError::Jimeng(format!("参考视频总时长不得超过 {max_duration} 秒")));
    }
    Ok(())
}

fn response(stdout: &[u8]) -> AppResult<serde_json::Value> {
    let text = String::from_utf8_lossy(stdout);
    let start = text
        .find('{')
        .ok_or_else(|| AppError::Jimeng("dreamina 未返回任务 JSON".into()))?;
    serde_json::Deserializer::from_str(&text[start..])
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Jimeng("dreamina 返回空任务 JSON".into()))?
        .map_err(|e| AppError::Jimeng(format!("dreamina 任务 JSON 无法解析：{e}")))
}

fn remote_failure(value: &serde_json::Value) -> AppError {
    let reason = value
        .get("fail_reason")
        .and_then(|v| v.as_str())
        .unwrap_or("未知原因");
    let hint = if reason.contains("AigcComplianceConfirmationRequired") {
        "；请先到即梦网页完成首次视频生成授权"
    } else if reason.contains("ExceedConcurrencyLimit") {
        "；账号已有远端任务，请完成后重试"
    } else {
        ""
    };
    AppError::Jimeng(format!(
        "即梦视频生成失败：{reason}{hint}（不会切换模型）"
    ))
}

async fn run(binary: &str, args: &[OsString]) -> AppResult<serde_json::Value> {
    let out = tokio::time::timeout(
        Duration::from_secs(180),
        dreamina_command(binary)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| AppError::Jimeng("dreamina 单次命令超时；已提交任务可重新取回".into()))?
    .map_err(|e| AppError::Jimeng(format!("启动 dreamina 失败：{e}")))?;
    let parsed = response(&out.stdout);
    if let Ok(value) = &parsed {
        if value.get("gen_status").and_then(|v| v.as_str()) == Some("fail") {
            return Err(remote_failure(value));
        }
    }
    if !out.status.success() {
        return Err(AppError::Jimeng(format!(
            "dreamina 退出 {}：{}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
                .chars()
                .take(500)
                .collect::<String>()
        )));
    }
    parsed
}

pub(crate) async fn generate(
    binary: &str,
    req: CodexRequest,
    options: VideoOptions,
    tx: &mpsc::Sender<Chunk>,
    resume_session: Option<String>,
) -> AppResult<GenOutcome> {
    let start = Instant::now();
    let value = run(binary, &arguments(&req, &options)?).await?;
    let submit_id = value
        .get("submit_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::Jimeng("视频提交未返回 submit_id；请到即梦核对任务，避免重复提交".into())
        })?
        .to_string();
    tx.send(Chunk::Submit {
        submit_id: submit_id.clone(),
    })
    .await
    .map_err(|_| AppError::Jimeng("视频任务状态通道已关闭".into()))?;
    let (source_images, temp_dir) = poll_video(binary, &submit_id).await?;
    Ok(GenOutcome {
        text: format!("[即梦 {}] 已生成 {} 个视频", options.model_version, source_images.len()),
        session_id: resume_session.or_else(|| Some(submit_id.clone())),
        submit_id: Some(submit_id),
        elapsed_ms: start.elapsed().as_millis() as u64,
        source_images,
        temp_dir: Some(temp_dir),
    })
}

struct DownloadDir(PathBuf);
impl Drop for DownloadDir {
    fn drop(&mut self) {
        if !self.0.as_os_str().is_empty() {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

/// 只识别命令层的临时传输错误，远端 fail（即使原因含 timeout）仍立即返回。
fn retryable_query_error(error: &AppError) -> bool {
    let AppError::Jimeng(message) = error else { return false };
    if message.starts_with("dreamina 单次命令超时") {
        return true;
    }
    message.starts_with("dreamina 退出 ")
        && [
            "context deadline exceeded",
            "Client.Timeout exceeded",
            "i/o timeout",
            "TLS handshake timeout",
            "connection reset by peer",
        ].iter().any(|reason| message.contains(reason))
}

/// querying 持续等待，临时查询错误有限重试；外层取消会 drop 子进程及等待。
pub(crate) async fn poll_video(
    binary: &str,
    submit_id: &str,
) -> AppResult<(Vec<PathBuf>, PathBuf)> {
    poll_video_with_interval(binary, submit_id, Duration::from_secs(10)).await
}

async fn poll_video_with_interval(
    binary: &str,
    submit_id: &str,
    interval: Duration,
) -> AppResult<(Vec<PathBuf>, PathBuf)> {
    let mut dir =
        DownloadDir(std::env::temp_dir().join(format!("bowerbird-video-{}", Ulid::new())));
    std::fs::create_dir_all(&dir.0)?;
    let mut consecutive_errors = 0;
    loop {
        let value = run(
            binary,
            &[
                "query_result".into(),
                "--submit_id".into(),
                submit_id.into(),
                "--download_dir".into(),
                dir.0.as_os_str().to_owned(),
            ],
        )
        .await;
        let value = match value {
            Ok(value) => {
                consecutive_errors = 0;
                value
            }
            Err(error) if retryable_query_error(&error) => {
                if consecutive_errors >= QUERY_ERROR_RETRIES {
                    return Err(AppError::Jimeng(format!(
                        "视频结果查询暂时中断，已重试 {QUERY_ERROR_RETRIES} 次；远端生成状态尚未确认。任务编号已保留，可稍后取回原任务，无需重新生成。最后错误：{error}"
                    )));
                }
                consecutive_errors += 1;
                tracing::info!(retry = consecutive_errors, "即梦视频查询暂时中断，稍后续查原任务");
                tokio::time::sleep(interval).await;
                continue;
            }
            Err(error) => return Err(error),
        };
        match value.get("gen_status").and_then(|v| v.as_str()) {
            Some("querying") => tokio::time::sleep(interval).await,
            Some("success") => {
                let videos = walk_videos(&dir.0);
                if videos.is_empty() {
                    return Err(AppError::Jimeng(
                        "视频任务成功但未下载到视频文件；保留 submit_id 可取回".into(),
                    ));
                }
                let root = std::mem::take(&mut dir.0);
                return Ok((videos, root));
            }
            Some("fail") => return Err(remote_failure(&value)),
            _ => {
                return Err(AppError::Jimeng(
                    "视频查询返回未知状态；保留 submit_id 可核对取回".into(),
                ))
            }
        }
    }
}

pub(crate) fn walk_videos(dir: &Path) -> Vec<PathBuf> {
    let mut videos = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                videos.extend(walk_videos(&path));
            } else if file_type.is_file()
                && reference_is_video(&path)
                && path.metadata().is_ok_and(|m| m.len() > 0)
            {
                videos.push(path);
            }
        }
    }
    videos.sort();
    videos
}

#[cfg(test)]
mod tests {
    use super::*;
    fn req(refs: &[&str]) -> CodexRequest {
        CodexRequest {
            instruction: "A running bird".into(),
            reference_images: refs.iter().map(PathBuf::from).collect(),
            context_prompts: vec![],
            ratio: Some("16:9".into()),
            job_id: None,
            generate_num: None,
            transparent_background: None,
        }
    }
    fn options(kind: &str) -> VideoOptions {
        VideoOptions {
            kind: kind.into(),
            model_version: "seedance2.5".into(),
            duration: 5,
            video_resolution: "720p".into(),
        }
    }
    #[test]
    fn four_modes_use_explicit_seedance25_and_ordered_references() {
        for (kind, refs) in [
            ("text2video", vec![]),
            ("image2video", vec!["first.png"]),
            ("frames2video", vec!["first.png", "last.png"]),
            (
                "multimodal2video",
                vec!["first.png", "clip.mp4", "last.png"],
            ),
        ] {
            let args = arguments(&req(&refs), &options(kind)).unwrap();
            let args: Vec<_> = args
                .iter()
                .map(|s| s.to_string_lossy().to_string())
                .collect();
            assert!(args
                .windows(2)
                .any(|a| a == ["--model_version", "seedance2.5"]));
            assert_eq!(
                args.contains(&"--ratio".into()),
                matches!(kind, "text2video" | "multimodal2video")
            );
            if kind == "frames2video" {
                assert_eq!(&args[1..5], &["--first", "first.png", "--last", "last.png"]);
            }
            if kind == "multimodal2video" {
                assert_eq!(
                    &args[1..7],
                    &[
                        "--image",
                        "first.png",
                        "--video",
                        "clip.mp4",
                        "--image",
                        "last.png"
                    ]
                );
            }
        }
    }
    #[test]
    fn rejects_invalid_model_duration_resolution_mode_and_references() {
        let mut opts = options("text2video");
        for n in [4, 30] {
            opts.duration = n;
            assert!(arguments(&req(&[]), &opts).is_ok());
        }
        for n in [3, 31] {
            opts.duration = n;
            assert!(arguments(&req(&[]), &opts).is_err());
        }
        opts.duration = 5;
        for resolution in ["480p", "720p", "1080p"] {
            opts.video_resolution = resolution.into();
            assert!(arguments(&req(&[]), &opts).is_ok());
        }
        opts.video_resolution = "4k".into();
        assert!(arguments(&req(&[]), &opts).is_err());
        opts = options("text2video");
        opts.model_version = "unknown-model".into();
        assert!(arguments(&req(&[]), &opts).is_err());
        assert!(arguments(&req(&["a.png", "b.png"]), &options("multiframe2video")).is_err());
        assert!(arguments(&req(&["a.mp4"]), &options("image2video")).is_err());
        assert!(arguments(&req(&["a.png"]), &options("frames2video")).is_err());
        assert!(arguments(&req(&["a.png"; 31]), &options("multimodal2video")).is_err());
        assert!(arguments(&req(&["a.mp3"]), &options("multimodal2video")).is_err());
        let mut request = req(&[]);
        request.ratio = Some("2:3".into());
        assert!(arguments(&request, &options("text2video")).is_err());
    }

    #[test]
    fn selected_models_have_exact_arguments_and_distinct_limits() {
        for model in ["seedance2.0", "seedance2.0fast", "seedance2.0_vip", "seedance2.0fast_vip", "seedance2.0mini"] {
            let mut opts = options("text2video");
            opts.model_version = model.into();
            opts.duration = 15;
            let args = arguments(&req(&[]), &opts).unwrap();
            assert!(args.windows(2).any(|pair| pair == ["--model_version", model]));
            opts.duration = 16;
            assert!(arguments(&req(&[]), &opts).is_err());
            opts.duration = 5;
            opts.video_resolution = "4k".into();
            assert_eq!(arguments(&req(&[]), &opts).is_ok(), model == "seedance2.0_vip");
            opts.video_resolution = "720p".into();
            opts.kind = "multimodal2video".into();
            assert!(arguments(&req(&["a.png"; 9]), &opts).is_ok());
            assert!(arguments(&req(&["a.png"; 10]), &opts).is_err());
            assert!(arguments(&req(&["a.mp4"; 4]), &opts).is_err());
        }
        let mut opts = options("image2video");
        opts.model_version = "seedance1.0fast".into();
        opts.duration = 10;
        assert!(arguments(&req(&["a.png"]), &opts).is_ok());
        opts.duration = 11;
        assert!(arguments(&req(&["a.png"]), &opts).is_err());
        opts.model_version = "seedance1.5pro".into();
        opts.kind = "frames2video".into();
        assert!(arguments(&req(&["a.png", "b.png"]), &opts).is_ok());
    }

    #[test]
    fn video_download_scan_ignores_images_empty_files_and_preserves_nested_paths() {
        let dir = DownloadDir(std::env::temp_dir().join(format!("bb-video-scan-{}", Ulid::new())));
        std::fs::create_dir_all(dir.0.join("nested")).unwrap();
        std::fs::write(dir.0.join("poster.png"), b"image").unwrap();
        std::fs::write(dir.0.join("empty.mp4"), b"").unwrap();
        let video = dir.0.join("nested").join("video.MP4");
        std::fs::write(&video, b"video").unwrap();
        assert_eq!(walk_videos(&dir.0), vec![video]);
    }

    #[test]
    fn video_responses_keep_failure_reason_and_reject_invalid_json() {
        let value = response(
            br#"notice {"gen_status":"fail","fail_reason":"AigcComplianceConfirmationRequired"}"#,
        )
        .unwrap();
        let error = remote_failure(&value).to_string();
        assert!(error.contains("首次视频生成授权"));
        assert!(error.contains("不会切换模型"));
        assert!(response(b"not json").is_err());
    }

    #[test]
    fn only_command_transport_errors_are_retryable() {
        for reason in ["context deadline exceeded", "Client.Timeout exceeded", "i/o timeout",
            "TLS handshake timeout", "connection reset by peer"] {
            assert!(retryable_query_error(&AppError::Jimeng(format!("dreamina 退出 exit code: 1：{reason}"))));
            assert!(!retryable_query_error(&remote_failure(&serde_json::json!({"fail_reason": reason}))));
        }
        assert!(retryable_query_error(&AppError::Jimeng("dreamina 单次命令超时；已提交任务可重新取回".into())));
        for reason in ["dreamina 退出 exit code: 1：unauthorized", "启动 dreamina 失败：file not found",
            "dreamina 任务 JSON 无法解析", "视频查询返回未知状态"] {
            assert!(!retryable_query_error(&AppError::Jimeng(reason.into())));
        }
    }

    #[tokio::test]
    async fn offline_cli_submit_download_recovery_and_cancel_protocol() {
        let dir = DownloadDir(std::env::temp_dir().join(format!("bb-video-cli-test-{}", Ulid::new())));
        std::fs::create_dir_all(&dir.0).unwrap();
        let source = dir.0.join("fixture.rs");
        std::fs::write(&source, include_str!("../../tests/fixtures/dreamina-video-cli.rs")).unwrap();
        let binary = dir.0.join(if cfg!(windows) { "dreamina-fixture.exe" } else { "dreamina-fixture" });
        let output = std::process::Command::new("rustc").arg(&source).arg("-o").arg(&binary).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let binary = binary.to_str().unwrap();
        let (tx, mut rx) = mpsc::channel(8);
        let result = generate(binary, req(&[]), options("text2video"), &tx, Some("original-session".into())).await.unwrap();
        assert_eq!(result.session_id.as_deref(), Some("original-session"));
        assert_eq!(result.submit_id.as_deref(), Some("offline-video-submit"));
        assert!(matches!(rx.recv().await, Some(Chunk::Submit { submit_id }) if submit_id == "offline-video-submit"));
        assert_eq!(result.source_images.len(), 1);
        let root = result.temp_dir.unwrap();
        assert!(result.source_images[0].starts_with(&root));
        assert!(result.source_images[0].parent().unwrap() != root);
        std::fs::remove_dir_all(root).unwrap();
        let (restored, root) = poll_video(binary, "offline-video-submit").await.unwrap();
        assert_eq!(restored.len(), 1);
        std::fs::remove_dir_all(root).unwrap();
        assert!(poll_video(binary, "failed").await.unwrap_err().to_string().contains("VIP required"));
        assert!(poll_video(binary, "unknown").await.unwrap_err().to_string().contains("未知状态"));
        assert!(tokio::time::timeout(Duration::from_millis(500), poll_video(binary, "pending")).await.is_err());
        // Three transient failures on either side of a valid querying response reset the budget.
        let (restored, root) = poll_video_with_interval(binary, "transient", Duration::from_millis(1)).await.unwrap();
        assert_eq!(restored.len(), 1);
        std::fs::remove_dir_all(root).unwrap();
        let error = poll_video_with_interval(binary, "timeout", Duration::from_millis(1)).await.unwrap_err().to_string();
        assert!(error.contains("已重试 3 次"));
        assert!(error.contains("远端生成状态尚未确认"));
        assert!(error.contains("取回原任务"));
        assert!(poll_video(binary, "unauthorized").await.unwrap_err().to_string().contains("please login"));
        assert!(poll_video(binary, "remote-timeout").await.unwrap_err().to_string().contains("即梦视频生成失败"));
        // Cancellation also interrupts retry backoff, without another query or submission.
        assert!(tokio::time::timeout(Duration::from_millis(500), poll_video(binary, "timeout")).await.is_err());
        let mut request = req(&[]);
        request.instruction = "submit timeout".into();
        assert!(generate(binary, request, options("text2video"), &tx, None).await.is_err());
        let log = std::fs::read_to_string(dir.0.join("calls.txt")).unwrap();
        assert_eq!(log.lines().filter(|line| line.starts_with("text2video|")).count(), 2, "one normal submission and one explicitly requested submission timeout; never auto-resubmit");
        for (id, expected) in [("offline-video-submit", 3), ("transient", 8), ("timeout", 5), ("unauthorized", 1), ("remote-timeout", 1)] {
            let calls: Vec<_> = log.lines().filter(|line| line.contains(&format!("query_result|--submit_id|{id}|"))).collect();
            assert_eq!(calls.len(), expected, "query count for {id}");
            // Failed/cancelled polls clean up the same directory used across retries.
            for call in calls {
                let path = call.split("|--download_dir|").nth(1).unwrap();
                assert!(!Path::new(path).exists(), "download directory leaked: {path}");
            }
        }
    }
}
