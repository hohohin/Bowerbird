//! SigLIP2-family vector matching (jina-clip-v2, int8 ONNX). The match phase
//! asks this embedder instead of the VLM: an asset matches a label when the
//! cosine between the image embedding and the label's text/example embeddings
//! clears the threshold. The VLM keeps discovery and naming duties.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use ndarray::{Array2, Array4};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use super::data::Label;

/// Pinned upstream artifacts. Hashes come from the Hugging Face LFS oids and
/// the onnxruntime GitHub release; downloads try the mirror first because the
/// primary host is unreachable from mainland China.
const MODEL_BYTES: u64 = 874_350_932;
const MODEL_HASH: &str = "21b8b77a009865faecaa29f076ee55d6334ea42699a9efa14d542ce8d3938a3f";
const TOKENIZER_BYTES: u64 = 17_082_997;
const TOKENIZER_HASH: &str = "6601c4120779a1a3863897ba332fe3481d548e363bec2c91eba10ef8640a5e93";
const REV: &str = "21b8b77a";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const RUNTIME_BYTES: u64 = 32_396_562;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const RUNTIME_HASH: &str = "1268b359718099bde2cedb55787f182a130067bc4f31e8c88478c445b850d3d8";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const RUNTIME_ARCHIVE: &str = "onnxruntime-osx-arm64-1.28.0.tgz";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const RUNTIME_MEMBER: &str = "lib/libonnxruntime.1.28.0.dylib";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const RUNTIME_BYTES: u64 = 78_796_801;
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const RUNTIME_HASH: &str = "abef733dacbe2f571547a7150b479b5cb9cc0df22f96c24983a42cadb1b4f8bc";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const RUNTIME_ARCHIVE: &str = "onnxruntime-win-x64-1.28.0.zip";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const RUNTIME_MEMBER: &str = "lib/onnxruntime.dll";
pub const VECTOR_PACK_ID: &str = "jina-clip-v2-int8-onnxruntime128-v1";

/// Calibrated 2026-09-19 on the 21 onboarding assets: true pairs scored
/// 0.27–0.33, true negatives stayed below 0.22 (see LOCAL-CLASSIFICATION.md).
pub const MATCH_THRESHOLD: f32 = 0.27;

const MEAN: [f32; 3] = [0.48145466, 0.4578275, 0.40821073];
const STD: [f32; 3] = [0.26862954, 0.26130258, 0.27577711];

/// Platforms with a pinned onnxruntime binary. Intel Macs and Linux fall back
/// to the VLM judge until a runtime archive is pinned for them.
pub fn vector_supported() -> bool {
    cfg!(all(target_os = "macos", target_arch = "aarch64"))
        || cfg!(all(target_os = "windows", target_arch = "x86_64"))
}

fn dylib_name() -> &'static str {
    if cfg!(windows) {
        "onnxruntime.dll"
    } else {
        "libonnxruntime.dylib"
    }
}

pub fn vector_installed(root: &Path) -> bool {
    vector_supported()
        && root.join("vector/model_int8.onnx").is_file()
        && root.join("vector/tokenizer.json").is_file()
        && root.join(format!("vector/{}", dylib_name())).is_file()
        && root.join("vector/ready.json").is_file()
}

/// Removes the pack outright. Missing directory is success so the button
/// stays idempotent; the caller holds the busy gate so a live session never
/// loses its files (Windows cannot delete a loaded DLL mid-run).
pub fn uninstall(root: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(root.join("vector")) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("卸载向量模型失败：{e}")),
    }
}

fn verify(path: &Path, hash: &str) -> Result<(), String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    use std::io::Read;
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    if format!("{:x}", digest.finalize()) != hash {
        return Err("向量模型下载文件校验失败，请重新安装".into());
    }
    Ok(())
}

async fn cancellable<T>(
    cancel: &AtomicBool,
    future: impl std::future::Future<Output = Result<T, reqwest::Error>>,
) -> Result<T, String> {
    tokio::pin!(future);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("已停止本地分类任务".into());
        }
        tokio::select! {
            result=&mut future => return result.map_err(|e| e.to_string()),
            _=tokio::time::sleep(std::time::Duration::from_millis(100)) => {},
        }
    }
}

/// Downloads one pinned file, verifying size and SHA-256 before commit.
async fn download(
    root: &Path,
    urls: &[&str],
    name: &str,
    hash: &str,
    expected: u64,
    cancel: &AtomicBool,
    progress: &impl Fn(&str, u64, u64),
) -> Result<(), String> {
    let destination = root.join(name);
    if destination.exists() {
        let path = destination.clone();
        let hash = hash.to_string();
        if tokio::task::spawn_blocking(move || verify(&path, &hash))
            .await
            .map_err(|e| e.to_string())?
            .is_ok()
        {
            progress(name, expected, expected);
            return Ok(());
        }
        tokio::fs::remove_file(&destination)
            .await
            .map_err(|e| e.to_string())?;
    }
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(3600))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = None;
    let mut last_error = String::new();
    for url in urls {
        match cancellable(cancel, client.get(*url).send()).await {
            Ok(result) => match result.error_for_status() {
                Ok(result) => {
                    response = Some(result);
                    break;
                }
                Err(error) => last_error = error.to_string(),
            },
            Err(error) => last_error = error,
        }
        if cancel.load(Ordering::Relaxed) {
            return Err("已停止下载".into());
        }
    }
    let response = response.ok_or_else(|| {
        format!("下载 {name} 失败：{last_error}。请检查系统代理是否可用，以及当前网络能否访问 Hugging Face 镜像 / GitHub。")
    })?;
    let partial = root.join(format!("{name}.part"));
    let mut file = tokio::fs::File::create(&partial)
        .await
        .map_err(|e| e.to_string())?;
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut digest = Sha256::new();
    let mut done = 0u64;
    let mut last = std::time::Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("已停止下载".into());
        }
        let next = tokio::select! {
            next = stream.next() => next,
            _=tokio::time::sleep(std::time::Duration::from_millis(250)) => continue,
        };
        let Some(bytes) = next else { break };
        let bytes = bytes.map_err(|e| format!("下载 {name} 中断：{e}"))?;
        done += bytes.len() as u64;
        if done > expected {
            return Err("下载文件大小与固定版本不符".into());
        }
        file.write_all(&bytes).await.map_err(|e| e.to_string())?;
        digest.update(&bytes);
        if last.elapsed() > std::time::Duration::from_millis(250) {
            progress(name, done, expected);
            last = std::time::Instant::now();
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    if done != expected || format!("{:x}", digest.finalize()) != hash {
        return Err("下载文件校验失败，请重试安装".into());
    }
    tokio::fs::rename(partial, destination)
        .await
        .map_err(|e| e.to_string())?;
    progress(name, done, expected);
    Ok(())
}

/// Installs the vector pack: model, tokenizer and the platform onnxruntime
/// library, each pinned by hash. The library is extracted from the verified
/// archive with the system tar (bsdtar handles both tgz and zip on Windows).
pub async fn vector_install(
    root: &Path,
    cancel: &AtomicBool,
    progress: impl Fn(&str, u64, u64),
) -> Result<(), String> {
    if !vector_supported() {
        return Err("此平台暂无固定的向量模型运行组件，继续使用内置视觉模型判断".into());
    }
    let dir = root.join("vector");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let host = [
        format!("https://hf-mirror.com/jinaai/jina-clip-v2/resolve/{REV}"),
        format!("https://huggingface.co/jinaai/jina-clip-v2/resolve/{REV}"),
    ];
    for (urls, name, hash, size) in [
        (
            [
                format!("{}/onnx/model_int8.onnx", host[0]),
                format!("{}/onnx/model_int8.onnx", host[1]),
            ],
            "model_int8.onnx",
            MODEL_HASH,
            MODEL_BYTES,
        ),
        (
            [
                format!("{}/tokenizer.json", host[0]),
                format!("{}/tokenizer.json", host[1]),
            ],
            "tokenizer.json",
            TOKENIZER_HASH,
            TOKENIZER_BYTES,
        ),
    ] {
        let urls: Vec<&str> = urls.iter().map(|s| s.as_str()).collect();
        download(&dir, &urls, name, hash, size, cancel, &progress).await?;
    }
    let runtime_url = format!(
        "https://github.com/microsoft/onnxruntime/releases/download/v1.28.0/{RUNTIME_ARCHIVE}"
    );
    let runtime_urls = [runtime_url.as_str()];
    download(
        &dir,
        &runtime_urls,
        RUNTIME_ARCHIVE,
        RUNTIME_HASH,
        RUNTIME_BYTES,
        cancel,
        &progress,
    )
    .await?;
    let archive = dir.join(RUNTIME_ARCHIVE);
    let lib = dir.join(dylib_name());
    let extract_dir = dir.clone();
    tokio::task::spawn_blocking(move || {
        let output = std::process::Command::new("tar")
            .arg("-xf")
            .arg(&archive)
            .arg("-C")
            .arg(&extract_dir)
            .arg(RUNTIME_MEMBER)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
        std::fs::rename(extract_dir.join(RUNTIME_MEMBER), &lib).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    tokio::fs::remove_file(dir.join(RUNTIME_ARCHIVE))
        .await
        .map_err(|e| e.to_string())?;
    let ready = serde_json::json!({ "pack": VECTOR_PACK_ID });
    tokio::fs::write(dir.join("ready.json"), ready.to_string())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Decision over embeddings. Pure so the threshold and counter-evidence rules
/// stay testable without a model.
pub fn decide(
    image: &[f32],
    text: Option<&[f32]>,
    positives: &[&[f32]],
    negatives: &[&[f32]],
) -> bool {
    let mut score = text.map_or(0.0, |t| cosine(image, t));
    for positive in positives {
        score = score.max(cosine(image, positive));
    }
    let objection = negatives
        .iter()
        .map(|n| cosine(image, n))
        .fold(0.0_f32, f32::max);
    score >= MATCH_THRESHOLD && objection < score
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// SigLIP preprocessing validated against the reference pipeline: bicubic
/// shortest-side 512, center crop 512×512, CLIP mean/std, CHW layout.
pub fn preprocess(img: &image::DynamicImage) -> Array4<f32> {
    let rgb = img.to_rgb8();
    let (w, h) = (rgb.width(), rgb.height());
    let scale = 512.0 / w.min(h) as f32;
    let nw = ((w as f32) * scale).round().max(1.0) as u32;
    let nh = ((h as f32) * scale).round().max(1.0) as u32;
    let resized = image::imageops::resize(&rgb, nw, nh, image::imageops::FilterType::CatmullRom);
    let (cw, ch) = (nw.min(512), nh.min(512));
    let (x0, y0) = ((nw - cw) / 2, (nh - ch) / 2);
    let mut out = Array4::<f32>::zeros((1, 3, 512, 512));
    for (x, y, px) in resized.enumerate_pixels() {
        if x < x0 || y < y0 || x >= x0 + cw || y >= y0 + ch {
            continue;
        }
        for c in 0..3 {
            out[[0, c, (y - y0) as usize, (x - x0) as usize]] =
                (px[c] as f32 / 255.0 - MEAN[c]) / STD[c];
        }
    }
    out
}

pub struct Embedder {
    session: ort::session::Session,
    tokenizer: tokenizers::Tokenizer,
}

fn init_runtime(dylib: &Path) -> Result<(), String> {
    // ort's environment is process-global; the pack library is the only one
    // ever loaded here, so a second load attempt is a no-op.
    static INIT: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
    INIT.get_or_init(|| {
        ort::init_from(dylib).map_err(|e| e.to_string())?.commit();
        Ok(())
    })
    .clone()
}

impl Embedder {
    pub fn load(root: &Path) -> Result<Self, String> {
        let dir = root.join("vector");
        init_runtime(&dir.join(dylib_name()))?;
        let threads = std::thread::available_parallelism().map_or(4, |n| n.get().min(8));
        let session = ort::session::Session::builder()
            .map_err(|e| e.to_string())?
            .with_intra_threads(threads)
            .map_err(|e| e.to_string())?
            .commit_from_file(dir.join("model_int8.onnx"))
            .map_err(|e| format!("向量模型加载失败：{e}"))?;
        let tokenizer = tokenizers::Tokenizer::from_file(dir.join("tokenizer.json"))
            .map_err(|e| format!("分词器加载失败：{e}"))?;
        Ok(Self { session, tokenizer })
    }

    pub fn embed_text(&mut self, text: &str) -> Result<Vec<f32>, String> {
        let enc = self
            .tokenizer
            .encode(text, true)
            .map_err(|e| e.to_string())?;
        let mut ids: Vec<i64> = enc.get_ids().iter().map(|&i| i as i64).collect();
        ids.truncate(256);
        let ids = Array2::from_shape_vec((1, ids.len()), ids).map_err(|e| e.to_string())?;
        let dummy = Array4::<f32>::zeros((1, 3, 512, 512));
        let outputs = self
            .session
            .run(ort::inputs![
                "input_ids" => ort::value::Tensor::from_array(ids).map_err(|e| e.to_string())?,
                "pixel_values" => ort::value::Tensor::from_array(dummy).map_err(|e| e.to_string())?,
            ])
            .map_err(|e| format!("文本向量计算失败：{e}"))?;
        let emb = outputs["l2norm_text_embeddings"]
            .try_extract_array::<f32>()
            .map_err(|e| e.to_string())?;
        Ok(emb.iter().copied().collect())
    }

    pub fn embed_image(&mut self, img: &image::DynamicImage) -> Result<Vec<f32>, String> {
        let pixels = preprocess(img);
        let enc = self.tokenizer.encode("", true).map_err(|e| e.to_string())?;
        let ids: Vec<i64> = enc.get_ids().iter().map(|&i| i as i64).collect();
        let ids = Array2::from_shape_vec((1, ids.len()), ids).map_err(|e| e.to_string())?;
        let outputs = self
            .session
            .run(ort::inputs![
                "input_ids" => ort::value::Tensor::from_array(ids).map_err(|e| e.to_string())?,
                "pixel_values" => ort::value::Tensor::from_array(pixels).map_err(|e| e.to_string())?,
            ])
            .map_err(|e| format!("图像向量计算失败：{e}"))?;
        let emb = outputs["l2norm_image_embeddings"]
            .try_extract_array::<f32>()
            .map_err(|e| e.to_string())?;
        Ok(emb.iter().copied().collect())
    }
}

/// Run-scoped vector judge: caches label-text and example-image embeddings so
/// each label and each asset is embedded at most once per run.
pub struct Matcher {
    embedder: Embedder,
    texts: HashMap<String, Vec<f32>>,
    images: HashMap<String, Vec<f32>>,
}

impl Matcher {
    pub fn load(root: &Path) -> Result<Self, String> {
        Ok(Self {
            embedder: Embedder::load(root)?,
            texts: HashMap::new(),
            images: HashMap::new(),
        })
    }

    pub fn label_text(&mut self, label: &Label) -> Result<&[f32], String> {
        let key = label.id.clone();
        if !self.texts.contains_key(&key) {
            let text = if label.description.trim().is_empty() {
                label.name.clone()
            } else {
                format!("{}；{}", label.name, label.description.trim())
            };
            let vector = self.embedder.embed_text(&text)?;
            self.texts.insert(key, vector);
        }
        Ok(self.texts[&label.id].as_slice())
    }

    pub fn embed_file(&mut self, key: &str, path: &Path) -> Result<&[f32], String> {
        let owned = key.to_string();
        if !self.images.contains_key(&owned) {
            let img = image::open(path).map_err(|e| format!("示例图读取失败：{e}"))?;
            let vector = self.embedder.embed_image(&img)?;
            self.images.insert(owned, vector);
        }
        Ok(self.images[key].as_slice())
    }

    /// The vectors are cloned out because the borrow checker cannot see that
    /// `decide` only reads them while later calls mutably borrow the cache.
    pub fn judge(
        &mut self,
        image: &[f32],
        label: &Label,
        positives: &[String],
        negatives: &[String],
    ) -> Result<bool, String> {
        let text = self.label_text(label)?.to_vec();
        let mut pos = Vec::new();
        for key in positives {
            pos.push(self.images.get(key).cloned().ok_or("示例向量未预加载")?);
        }
        let mut neg = Vec::new();
        for key in negatives {
            neg.push(self.images.get(key).cloned().ok_or("示例向量未预加载")?);
        }
        let pos: Vec<&[f32]> = pos.iter().map(|v| v.as_slice()).collect();
        let neg: Vec<&[f32]> = neg.iter().map(|v| v.as_slice()).collect();
        Ok(decide(image, Some(&text), &pos, &neg))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(offset: f32) -> Vec<f32> {
        let mut v = vec![0.0; 8];
        v[0] = (1.0 - offset * offset).max(0.0).sqrt();
        v[1] = offset;
        v
    }

    #[test]
    fn decide_requires_threshold_and_respects_counter_evidence() {
        let image = unit(0.0);
        let aligned = unit(0.0);
        let far = vec![
            0.2,
            (1.0 - 0.2_f32 * 0.2).sqrt(),
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
        ];
        // Scaled copies of the image direction reproduce the real model's
        // spread around MATCH_THRESHOLD (cosine = the scale factor).
        let weak = vec![image[0] * 0.2, image[1] * 0.2, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let near = vec![image[0] * 0.4, image[1] * 0.4, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        assert!(decide(&image, Some(&aligned), &[], &[]));
        assert!(!decide(&image, Some(&far), &[], &[]));
        assert!(!decide(&image, Some(&weak), &[], &[]));
        assert!(decide(&image, Some(&far), &[&near], &[]));
        // A rejection example closer than the best evidence vetoes the match.
        let closer = vec![image[0] * 0.5, image[1] * 0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        assert!(!decide(&image, Some(&near), &[&near], &[&closer]));
        let milder = vec![image[0] * 0.3, image[1] * 0.3, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        assert!(decide(&image, Some(&near), &[&near], &[&milder]));
    }

    #[test]
    fn preprocess_resizes_shortest_side_then_center_crops() {
        // 600×400: shortest side 400 → ×1.28 → 768×512, then center crop 512².
        let img = image::DynamicImage::new_rgb8(600, 400);
        let pixels = preprocess(&img);
        assert_eq!(pixels.shape(), &[1, 3, 512, 512]);
        // Black pixels normalize to a constant: (0 - mean) / std.
        let expected = (0.0_f32 - MEAN[0]) / STD[0];
        assert!((pixels[[0, 0, 0, 0]] - expected).abs() < 1e-6);
        assert!((pixels[[0, 1, 256, 256]] - (0.0 - MEAN[1]) / STD[1]).abs() < 1e-6);
    }

    #[test]
    fn uninstall_removes_the_pack_and_tolerates_a_missing_directory() {
        let dir = std::env::temp_dir().join(format!("vector-uninstall-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("vector")).unwrap();
        std::fs::write(dir.join("vector/ready.json"), "{}").unwrap();
        uninstall(&dir).unwrap();
        assert!(!dir.join("vector").exists());
        uninstall(&dir).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn pack_artifacts_are_pinned() {
        for hash in [MODEL_HASH, TOKENIZER_HASH, RUNTIME_HASH] {
            assert_eq!(hash.len(), 64);
            assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
        }
        assert!(MODEL_BYTES > 800_000_000);
        assert!(TOKENIZER_BYTES > 1_000_000);
    }

    /// Real-model smoke: set BOWERBIRD_VECTOR_PACK to a directory holding the
    /// pinned files (model_int8.onnx, tokenizer.json, libonnxruntime.dylib)
    /// and asset-007.png.
    #[test]
    #[ignore]
    fn real_model_orders_labels_correctly() {
        let Ok(pack) = std::env::var("BOWERBIRD_VECTOR_PACK") else {
            return;
        };
        let dir = std::path::PathBuf::from(&pack);
        let root = dir.parent().unwrap().to_path_buf();
        let mut embedder = Embedder::load(&root).unwrap();
        let bottle = embedder.embed_text("矿泉水瓶").unwrap();
        let girl = embedder.embed_text("女孩").unwrap();
        let img = image::open(dir.join("asset-007.png")).unwrap();
        let embedded = embedder.embed_image(&img).unwrap();
        assert!(cosine(&embedded, &bottle) > cosine(&embedded, &girl));
        assert!(cosine(&embedded, &bottle) >= MATCH_THRESHOLD);
    }
}
