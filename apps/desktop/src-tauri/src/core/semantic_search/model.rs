//! Local FP32 SigLIP2 encoders. Text and image towers load only when used.
#![doc = include_str!("model/README.md")]

use std::path::{Path, PathBuf};

use image::{imageops::FilterType, DynamicImage};
use ndarray::{Array2, Array4};
use ort::session::{Session, SessionOutputs};
use tokenizers::Tokenizer;

mod artifacts;
mod ranged_download;

pub(super) use super::embedding::DIMENSIONS;
pub(super) use artifacts::{
    download_bytes, install, installed, installed_bytes, invalidate_ready, known_corrupt,
    supported, uninstall,
};

// SHA-256 of the ordered artifact hashes and the preprocessing contract below.
pub(super) const MODEL_ID: &str =
    "siglip2-cfb1e19ef6223dd57fe414048afc78ed99f94855e5bb331aabe1cb64d2cc9e95";
// This relevance floor is specific to the normalized outputs of this FP32 model.
pub(super) const SEARCH_MIN_COSINE: f32 = 0.085;
const SIDE: usize = 224;
const TEXT_LENGTH: usize = 64;
const PAD: i64 = 0;
const EOS: i64 = 1;

pub(super) struct EncodedText {
    pub(super) vector: Vec<f32>,
    pub(super) truncated: bool,
}

pub(super) struct Embedder {
    root: PathBuf,
    tokenizer: Tokenizer,
    text: Option<Session>,
    image: Option<Session>,
}

impl Embedder {
    pub(super) fn load(root: &Path) -> Result<Self, String> {
        if !installed(root) {
            return Err("语义搜索模型未就绪，请检查下载是否完成。".into());
        }
        let runtime = artifacts::verified_runtime(root)?;
        ort::init_from(runtime)
            .map_err(|error| format!("无法加载语义搜索运行组件：{error}"))?
            .with_telemetry(false)
            .commit();
        Self::from_towers(root)
    }

    fn from_towers(root: &Path) -> Result<Self, String> {
        let mut tokenizer =
            Tokenizer::from_file(artifacts::verified_file(root, &artifacts::TOKENIZER)?)
                .map_err(|error| format!("无法加载语义搜索分词器：{error}"))?;
        if tokenizer.token_to_id("<pad>") != Some(PAD as u32)
            || tokenizer.token_to_id("<eos>") != Some(EOS as u32)
        {
            return Err("语义搜索分词器的特殊标记与模型不匹配。".into());
        }
        // Count the full input before truncation so the caller can report it.
        tokenizer.with_padding(None);
        tokenizer
            .with_truncation(None)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            root: root.to_path_buf(),
            tokenizer,
            text: None,
            image: None,
        })
    }

    /// Open the text tower separately so the caller can check a deadline
    /// again before starting inference after a cold load.
    pub(super) fn prepare_text(&mut self) -> Result<(), String> {
        tower(&mut self.text, &self.root, &artifacts::TEXT).map(|_| ())
    }

    pub(super) fn embed_text(&mut self, text: &str) -> Result<EncodedText, String> {
        let encoding = self
            .tokenizer
            .encode(text.to_lowercase(), false)
            .map_err(|error| format!("无法读取语义搜索文字：{error}"))?;
        let (input, truncated) = text_tokens(encoding.get_ids());
        let input = ort::value::Tensor::from_array(input).map_err(|error| error.to_string())?;
        let session = tower(&mut self.text, &self.root, &artifacts::TEXT)?;
        let outputs = session
            .run(ort::inputs!["input_ids" => input])
            .map_err(|error| format!("无法计算文字向量：{error}"))?;
        Ok(EncodedText {
            vector: pooled(&outputs)?,
            truncated,
        })
    }

    /// Verify and open the shared vision model before any image task is claimed.
    /// This separates package errors from failures specific to an input image.
    pub(super) fn prepare_vision(&mut self) -> Result<(), String> {
        tower(&mut self.image, &self.root, &artifacts::VISION).map(|_| ())
    }

    pub(super) fn embed_image(&mut self, image: &DynamicImage) -> Result<Vec<f32>, String> {
        let input =
            ort::value::Tensor::from_array(pixels(image)).map_err(|error| error.to_string())?;
        let session = tower(&mut self.image, &self.root, &artifacts::VISION)?;
        let outputs = session
            .run(ort::inputs!["pixel_values" => input])
            .map_err(|error| format!("无法计算图片向量：{error}"))?;
        pooled(&outputs)
    }
}

fn tower<'a>(
    slot: &'a mut Option<Session>,
    root: &Path,
    artifact: &artifacts::Artifact,
) -> Result<&'a mut Session, String> {
    match slot {
        Some(session) => Ok(session),
        None => {
            let path = artifacts::verified_file(root, artifact)?;
            let threads =
                std::thread::available_parallelism().map_or(4, |count| count.get().min(4));
            let session = Session::builder()
                .map_err(|error| error.to_string())?
                .with_intra_threads(threads)
                .map_err(|error| error.to_string())?
                .with_inter_threads(1)
                .map_err(|error| error.to_string())?
                .commit_from_file(path)
                .map_err(|error| format!("无法打开语义搜索模型：{error}"))?;
            Ok(slot.insert(session))
        }
    }
}

fn pooled(outputs: &SessionOutputs<'_>) -> Result<Vec<f32>, String> {
    let value = outputs
        .get("pooler_output")
        .ok_or("语义搜索模型缺少向量输出。")?;
    let vector = value
        .try_extract_array::<f32>()
        .map_err(|error| error.to_string())?;
    if vector.shape() != [1, DIMENSIONS] || vector.iter().any(|value| !value.is_finite()) {
        return Err("语义搜索模型产生了无效向量。".into());
    }
    Ok(vector.iter().copied().collect())
}

fn text_tokens(tokens: &[u32]) -> (Array2<i64>, bool) {
    let mut input = Array2::from_elem((1, TEXT_LENGTH), PAD);
    let kept = tokens.len().min(TEXT_LENGTH - 1);
    for (slot, token) in tokens.iter().take(kept).enumerate() {
        input[[0, slot]] = i64::from(*token);
    }
    input[[0, kept]] = EOS;
    (input, kept < tokens.len())
}

fn pixels(image: &DynamicImage) -> Array4<f32> {
    let rgb = if image.color().has_alpha() {
        let rgba = image.to_rgba8();
        image::RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
            let [red, green, blue, alpha] = rgba.get_pixel(x, y).0;
            let alpha = u16::from(alpha);
            image::Rgb([red, green, blue].map(|channel| {
                ((u16::from(channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8
            }))
        })
    } else {
        image.to_rgb8()
    };
    let rgb = image::imageops::resize(&rgb, SIDE as u32, SIDE as u32, FilterType::Triangle);
    Array4::from_shape_fn((1, 3, SIDE, SIDE), |(_, channel, row, column)| {
        f32::from(rgb.get_pixel(column as u32, row as u32)[channel]) / 127.5 - 1.0
    })
}

#[cfg(test)]
mod tests;
