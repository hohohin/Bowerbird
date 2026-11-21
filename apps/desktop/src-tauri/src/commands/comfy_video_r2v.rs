//! Native Ref2VA input adapters for the official H3 R2V graph.
use std::{path::Path, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{db::Database, error::AppResult, media::{probe, tools::{self, Tool}}};

use super::{error, upload, upload_audio, upload_input, Mode};

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub(super) struct References {
    #[serde(default, rename = "referenceImages", skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    #[serde(default, rename = "referenceVideos", skip_serializing_if = "Vec::is_empty")]
    pub videos: Vec<String>,
    #[serde(default, rename = "referenceAudios", skip_serializing_if = "Vec::is_empty")]
    pub audios: Vec<String>,
}

impl References {
    pub(super) fn ids(&self) -> impl Iterator<Item = &String> {
        self.images.iter().chain(&self.videos).chain(&self.audios)
    }

    pub(super) fn validate(&self, mode: Mode, legacy_inputs: bool) -> AppResult<()> {
        let empty = self.ids().next().is_none();
        if mode != Mode::R2v {
            return if empty { Ok(()) } else { Err(error("多模态参考素材需使用 R2V 模式")) };
        }
        if legacy_inputs || empty || self.ids().any(|id| id.trim().is_empty()) {
            return Err(error("R2V 模式至少需要一项有效的参考素材，不接收首尾帧或旧录音输入"));
        }
        if self.images.len() > 9 || self.videos.len() > 3 || self.audios.len() > 3 {
            return Err(error("R2V 最多支持 9 张参考图片、3 段参考视频及 3 段独立参考音频"));
        }
        Ok(())
    }
}

pub(super) fn check_schema(info: &Value) -> AppResult<()> {
    let optional = &info["MiniMaxH3ReferenceToVideo"]["input"]["optional"];
    if ["ref_images", "ref_videos", "ref_video_audios", "ref_audios"].iter()
        .any(|port| optional[*port][0] != "COMFY_AUTOGROW_V3")
        || !info["LoadVideo"]["input"]["required"]["file"].is_array()
        || info["GetVideoComponents"]["output"][0] != "IMAGE"
        || info["GetVideoComponents"]["output"][1] != "AUDIO" {
        return Err(error("当前 ComfyUI 缺少 H3 R2V 的多模态参考节点，请使用兼容版本"));
    }
    Ok(())
}

pub(super) fn add_reference_nodes(graph: &mut Value, references: &References) {
    for (index, image) in references.images.iter().enumerate() {
        let node = (100 + index).to_string();
        graph[&node] = json!({"class_type":"LoadImage","inputs":{"image":image}});
        graph["9"]["inputs"][format!("ref_images.ref_image_{index}")] = json!([node,0]);
    }
    for (index, video) in references.videos.iter().enumerate() {
        let load = (110 + index * 2).to_string();
        let components = (111 + index * 2).to_string();
        graph[&load] = json!({"class_type":"LoadVideo","inputs":{"file":video}});
        graph[&components] = json!({"class_type":"GetVideoComponents","inputs":{"video":[load,0]}});
        graph["9"]["inputs"][format!("ref_videos.ref_video_{index}")] = json!([components,0]);
        // A silent video produces None from the audio output, which Ref2VA ignores.
        graph["9"]["inputs"][format!("ref_video_audios.ref_video_audio_{index}")] = json!([components,1]);
    }
    for (index, audio) in references.audios.iter().enumerate() {
        let node = (120 + index).to_string();
        graph[&node] = json!({"class_type":"LoadAudio","inputs":{"audio":audio}});
        graph["9"]["inputs"][format!("ref_audios.ref_audio_{index}")] = json!([node,0]);
    }
}

pub(super) async fn upload_references(http: &reqwest::Client, base: &str, db: &Database, sources: &References, request: &str) -> AppResult<(References,(u32,u32))> {
    let mut uploaded = References::default();
    let mut size = None;
    for (index, id) in sources.images.iter().enumerate() {
        let (name, dimensions) = upload(http,base,db,id,request,&format!("ref-image-{index}")).await?;
        size.get_or_insert(dimensions);
        uploaded.images.push(name);
    }
    for (index, id) in sources.videos.iter().enumerate() {
        let role = format!("ref-video-{index}");
        let asset = db.get_asset(id)?.ok_or_else(|| error("参考视频不存在，请重新选择"))?;
        if !asset.ext.as_deref().is_some_and(probe::is_video) {
            return Err(error("请选择有效的视频素材作为参考视频"));
        }
        let original = db.resolve_asset_original(id)?;
        let scratch = tempfile::tempdir()?;
        let output = scratch.path().join("reference.mp4");
        let dimensions = normalize_video(&original,&output).await?;
        let bytes = tokio::fs::read(output).await?;
        let part = reqwest::multipart::Part::bytes(bytes).file_name(format!("{request}-{role}.mp4"));
        uploaded.videos.push(upload_input(http,base,part,"视频").await?);
        size.get_or_insert(dimensions);
    }
    for (index, id) in sources.audios.iter().enumerate() {
        uploaded.audios.push(upload_audio(http,base,db,id,request,&format!("ref-audio-{index}"),Mode::R2v).await?);
    }
    Ok((uploaded,size.unwrap_or((16,9))))
}

async fn normalize_video(original: &Path, output: &Path) -> AppResult<(u32,u32)> {
    const MAX_BYTES: u64 = 64 * 1024 * 1024;
    let ffmpeg = tools::resolve(Tool::Ffmpeg).map_err(|_| error("准备 H3 参考视频需要本机 FFmpeg，请安装后重试"))?;
    let mut command = tokio::process::Command::from(tools::command(ffmpeg));
    command.args(["-nostdin","-hide_banner","-loglevel","error","-y","-protocol_whitelist","file,pipe","-i"]).arg(original)
        .args(["-map","0:v:0","-map","0:a:0?","-sn","-dn","-t","15","-vf",
            "fps=24,scale=w='min(iw,1344)':h='min(ih,1344)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
            "-c:v","libx264","-preset","veryfast","-pix_fmt","yuv420p","-c:a","aac","-ac","2","-ar","32000","-fs"])
        .arg(MAX_BYTES.to_string()).arg(output).kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(120), command.output()).await
        .map_err(|_| error("参考视频转换超时，请先裁剪为短片段"))??;
    if !result.status.success() {
        tracing::warn!("H3 reference video conversion failed: {}", String::from_utf8_lossy(&result.stderr).chars().take(800).collect::<String>());
        return Err(error("无法读取参考视频，请尝试重新导出为 MP4"));
    }
    let metadata = probe::probe(output)?;
    if metadata.size >= MAX_BYTES || metadata.width == 0 || metadata.height == 0 || metadata.duration < 2.0 {
        return Err(error("参考视频需至少 2 秒，且转换后不超过 64 MB"));
    }
    Ok((metadata.width,metadata.height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn normalizes_reference_video_to_24_fps_and_preserves_optional_soundtrack() {
        let (Ok(ffmpeg), Ok(ffprobe)) = (tools::resolve(Tool::Ffmpeg), tools::resolve(Tool::Ffprobe)) else {
            eprintln!("Skipping media normalization fixture without FFmpeg and ffprobe");
            return;
        };
        let scratch = tempfile::tempdir().unwrap();
        for sound in [false,true] {
            let source = scratch.path().join(format!("source-{sound}.mp4"));
            let output = scratch.path().join(format!("normalized-{sound}.mp4"));
            let mut fixture = tools::command(ffmpeg);
            fixture.args(["-nostdin","-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=blue:s=64x96:r=30"]);
            if sound { fixture.args(["-f","lavfi","-i","sine=f=420"]); }
            assert!(fixture.args(["-t","3","-pix_fmt","yuv420p"]).arg(&source).status().unwrap().success());
            assert_eq!(normalize_video(&source,&output).await.unwrap(),(64,96));
            let streams = tools::command(ffprobe).args(["-v","error","-show_entries","stream=codec_type,avg_frame_rate","-of","json"])
                .arg(output).output().unwrap();
            assert!(streams.status.success());
            let body: Value = serde_json::from_slice(&streams.stdout).unwrap();
            let streams = body["streams"].as_array().unwrap();
            assert_eq!(streams[0]["avg_frame_rate"],"24/1");
            assert_eq!(streams.iter().any(|stream| stream["codec_type"] == "audio"),sound);
        }
    }
}
