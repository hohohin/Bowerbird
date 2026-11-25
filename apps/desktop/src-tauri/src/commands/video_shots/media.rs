use super::{invalid, model::with_long_segments, source_version, Cut, Header, Kind};
use crate::{
    error::AppResult,
    media::tools::{self, Tool},
};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{process::Command, sync::Semaphore};

static DECODERS: Semaphore = Semaphore::const_new(2);

fn ffmpeg() -> AppResult<Command> {
    let mut cmd = Command::from(tools::command(tools::resolve(Tool::Ffmpeg)?));
    cmd.kill_on_drop(true)
        .args(["-hide_banner", "-nostdin", "-loglevel", "error"]);
    Ok(cmd)
}
async fn run(command: &mut Command) -> AppResult<Vec<u8>> {
    let _permit = DECODERS
        .acquire()
        .await
        .map_err(|_| invalid("媒体进程已停止"))?;
    let output = tokio::time::timeout(Duration::from_secs(300), command.output())
        .await
        .map_err(|_| invalid("分镜处理超时，请检查原件后重试"))??;
    if !output.status.success() {
        return Err(invalid("解码失败，请检查原视频和 FFmpeg"));
    }
    Ok(output.stdout)
}
pub(super) async fn frame(
    path: &Path,
    folder: &Path,
    start: i64,
    version: &str,
) -> AppResult<PathBuf> {
    fs::create_dir_all(folder)?;
    let target = folder.join(format!("{start}.jpg"));
    if target.exists() {
        return Ok(target);
    }
    let mut cmd = ffmpeg()?;
    cmd.args(["-ss", &format!("{:.3}", start as f64 / 1000.0), "-i"])
        .arg(path)
        .args([
            "-map",
            "0:V:0",
            "-frames:v",
            "1",
            "-vf",
            "scale=1280:1280:force_original_aspect_ratio=decrease",
            "-an",
            "-sn",
            "-dn",
            "-q:v",
            "2",
            "-f",
            "image2pipe",
            "-c:v",
            "mjpeg",
            "pipe:1",
        ]);
    let bytes = run(&mut cmd).await?;
    if bytes.len() < 4 || !bytes.starts_with(&[0xff, 0xd8]) || !bytes.ends_with(&[0xff, 0xd9]) {
        return Err(invalid("无法提取该镜头首帧"));
    }
    if source_version(path)? != version {
        return Err(invalid("读取首帧期间原件已变化"));
    }
    let mut temporary = tempfile::NamedTempFile::new_in(folder)?;
    temporary.write_all(&bytes)?;
    if let Err(error) = temporary.persist_noclobber(&target) {
        if error.error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(error.error.into());
        }
    }
    Ok(target)
}

pub(super) async fn detect(path: &Path, h: &Header, threshold: f64) -> AppResult<Vec<Cut>> {
    const WINDOW: i64 = 300_000;
    let mut cuts = h
        .layout
        .cuts
        .iter()
        .filter(|c| c.kind == Kind::Manual)
        .cloned()
        .collect::<Vec<_>>();
    let mut detected = Vec::new();
    let filter=format!("scale=320:320:force_original_aspect_ratio=decrease,select='gt(scene,{threshold:.6})',metadata=print:key=lavfi.scene_score:file=-");
    let mut start = 0;
    while start < h.duration_ms {
        // Include a prior second so the first frame in the window has a predecessor for the scene score.
        let seek = (start - 1000).max(0);
        let end = start.saturating_add(WINDOW).min(h.duration_ms);
        let mut cmd = ffmpeg()?;
        cmd.args([
            "-copyts",
            "-start_at_zero",
            "-ss",
            &format!("{:.3}", seek as f64 / 1000.0),
            "-t",
            &format!("{:.3}", (end - seek) as f64 / 1000.0),
            "-i",
        ])
        .arg(path)
        .args([
            "-map",
            "0:V:0",
            "-an",
            "-sn",
            "-dn",
            "-vf",
            &filter,
            "-fps_mode",
            "vfr",
            "-f",
            "null",
            "-",
        ]);
        let bytes = run(&mut cmd).await?;
        for line in String::from_utf8_lossy(&bytes).lines() {
            let Some(time) = line
                .split_once("pts_time:")
                .and_then(|(_, tail)| tail.split_whitespace().next())
                .and_then(|word| word.parse::<f64>().ok())
                .filter(|n| n.is_finite())
            else {
                continue;
            };
            let at = (time * 1000.0).round() as i64;
            if at >= start
                && at < end
                && at >= 300
                && at <= h.duration_ms - 300
                && !h.layout.suppressed.contains(&at)
            {
                detected.push(at);
            }
        }
        if source_version(path)? != h.version {
            return Err(invalid("检测期间原件已变化"));
        }
        start = end;
    }
    let manual: Vec<_> = cuts.iter().map(|c| c.at).collect();
    let mut last = 0;
    for at in detected {
        let next = manual.partition_point(|&t| t < at);
        let near = next
            .checked_sub(1)
            .and_then(|i| manual.get(i))
            .into_iter()
            .chain(manual.get(next))
            .any(|m| (at - *m).abs() < 300);
        if !near && at - last >= 300 {
            cuts.push(Cut {
                at,
                kind: Kind::Scene,
            });
            last = at;
        }
    }
    cuts.sort_unstable_by_key(|c| c.at);
    let mut cuts = with_long_segments(cuts, h.duration_ms);
    cuts.retain(|cut| cut.kind != Kind::Long || !h.layout.suppressed.contains(&cut.at));
    Ok(cuts)
}
