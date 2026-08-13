use std::path::PathBuf;
use std::time::Instant;

use async_trait::async_trait;
use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{ExtendedColorType, ImageBuffer, ImageReader, Rgb};
use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::cloud::{AuthClient, CloudClient, EntitlementService};
use crate::codex::codex_cli::CodexCliProvider;
use crate::codex::types::{CodexRequest, CodexResult};
use crate::codex::GenProvider;
use crate::error::AppError;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnderstandOperation {
    Caption,
    Autoname,
    Classify,
}

impl UnderstandOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Caption => "caption",
            Self::Autoname => "autoname",
            Self::Classify => "classify",
        }
    }
}

#[async_trait]
pub trait UnderstandProvider: Send + Sync {
    fn name(&self) -> &'static str;
    async fn understand(
        &self,
        operation: UnderstandOperation,
        req: CodexRequest,
    ) -> Result<CodexResult, AppError>;
}

pub struct CodexUnderstandProvider(CodexCliProvider);

impl Default for CodexUnderstandProvider {
    fn default() -> Self {
        Self(CodexCliProvider::default())
    }
}

#[async_trait]
impl UnderstandProvider for CodexUnderstandProvider {
    fn name(&self) -> &'static str {
        "codex"
    }

    async fn understand(
        &self,
        _operation: UnderstandOperation,
        req: CodexRequest,
    ) -> Result<CodexResult, AppError> {
        self.0.run(req).await
    }
}

#[derive(Clone)]
pub struct CloudUnderstandProvider {
    cloud: CloudClient,
    auth: AuthClient,
}

impl CloudUnderstandProvider {
    pub fn new(cloud: CloudClient, auth: AuthClient) -> Self {
        Self { cloud, auth }
    }
}

#[derive(Deserialize)]
struct UnderstandResponse {
    text: String,
}

#[async_trait]
impl UnderstandProvider for CloudUnderstandProvider {
    fn name(&self) -> &'static str {
        "bowerbird-cloud"
    }

    async fn understand(
        &self,
        operation: UnderstandOperation,
        req: CodexRequest,
    ) -> Result<CodexResult, AppError> {
        let started = Instant::now();
        let endpoint = self
            .cloud
            .config()
            .endpoint("understand-proxy")
            .ok_or_else(|| AppError::Cloud("当前构建未配置 Bowerbird Cloud".into()))?;
        let image_path = req
            .reference_images
            .first()
            .ok_or_else(|| AppError::Cloud("云理解需要一张图片".into()))?;
        let image = read_image(image_path).await?;
        let response = self
            .auth
            .send_authorized(
                self.cloud.http().post(endpoint).json(&serde_json::json!({
                    "idempotency_key": req.job_id.unwrap_or_else(|| Ulid::new().to_string()),
                    "operation": operation.as_str(),
                    "image": image,
                    "instruction": req.instruction,
                })),
                "云理解请求失败",
            )
            .await?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| AppError::Cloud(format!("读取云理解响应失败: {error}")))?;
        if !status.is_success() {
            let message = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|value| {
                    value
                        .pointer("/error/message")
                        .and_then(|value| value.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| format!("云理解失败（HTTP {}）", status.as_u16()));
            return Err(AppError::Cloud(message));
        }
        let result: UnderstandResponse = serde_json::from_str(&body)
            .map_err(|error| AppError::Cloud(format!("解析云理解响应失败: {error}")))?;
        Ok(CodexResult {
            text: result.text,
            provider: self.name().into(),
            elapsed_ms: started.elapsed().as_millis() as u64,
            session_id: None,
            images: vec![],
        })
    }
}

pub fn resolve_understand_provider(
    provider: Option<&str>,
    cloud: Option<(CloudClient, AuthClient)>,
) -> Result<Box<dyn UnderstandProvider>, AppError> {
    match provider.unwrap_or("codex") {
        "codex" | "default" => Ok(Box::new(CodexUnderstandProvider::default())),
        "bowerbird-cloud" => {
            let (client, auth) =
                cloud.ok_or_else(|| AppError::Cloud("账号服务尚未初始化".into()))?;
            Ok(Box::new(CloudUnderstandProvider::new(client, auth)))
        }
        other => Err(AppError::Cloud(format!("未知理解 provider: {other}"))),
    }
}

/// 按账号权益选择理解 provider：Pro/Studio 使用本机 CLI；免费档仅在明确允许上传时走 Cloud。
pub async fn resolve_entitled_understand_provider(
    entitlement: &EntitlementService,
    cloud: CloudClient,
    auth: AuthClient,
    allow_cloud: bool,
) -> Result<Box<dyn UnderstandProvider>, AppError> {
    let snapshot = entitlement.current_or_sync(&auth).await;
    let provider = snapshot
        .policy
        .understand_provider(allow_cloud)
        .ok_or_else(|| {
            AppError::Cloud(
                "免费版只能使用 Bowerbird Cloud 理解；请登录并明确允许云端理解，或升级 Pro 解锁本机 CLI"
                    .into(),
            )
        })?;
    if provider == "bowerbird-cloud" && !auth.snapshot().logged_in {
        return Err(AppError::Cloud(
            "免费版反推需要先登录 Bowerbird Cloud（每日 10 次）".into(),
        ));
    }
    resolve_understand_provider(Some(provider), Some((cloud, auth)))
}

/// 用户显式选择理解 provider 时使用：按选项 resolve，但仍按权益门控（免费档不能选 codex）。
/// choice = None 时退回自动路由（resolve_entitled_understand_provider）。
pub async fn resolve_understand_provider_with_choice(
    entitlement: &EntitlementService,
    cloud: CloudClient,
    auth: AuthClient,
    choice: Option<&str>,
) -> Result<Box<dyn UnderstandProvider>, AppError> {
    match choice {
        None => resolve_entitled_understand_provider(entitlement, cloud, auth, true).await,
        Some("codex") => {
            let snapshot = entitlement.current_or_sync(&auth).await;
            if !snapshot.policy.can_use_byo {
                return Err(AppError::Cloud("升级 Pro 解锁本机 codex 反推".into()));
            }
            resolve_understand_provider(Some("codex"), None)
        }
        Some("bowerbird-cloud") => {
            if !auth.snapshot().logged_in {
                return Err(AppError::Cloud("反推需要先登录 Bowerbird Cloud".into()));
            }
            resolve_understand_provider(Some("bowerbird-cloud"), Some((cloud, auth)))
        }
        Some(other) => Err(AppError::Cloud(format!("未知理解 provider: {other}"))),
    }
}

async fn read_image(path: &PathBuf) -> Result<serde_json::Value, AppError> {
    let path = path.clone();
    let bytes = tokio::task::spawn_blocking(move || prepare_cloud_image(&path))
        .await
        .map_err(|error| AppError::Cloud(format!("图片预处理任务失败: {error}")))??;
    Ok(serde_json::json!({
        "mime": "image/jpeg",
        "base64": base64::engine::general_purpose::STANDARD.encode(bytes),
    }))
}

const CLOUD_IMAGE_MAX_EDGE: u32 = 1_600;
const CLOUD_IMAGE_JPEG_QUALITY: u8 = 88;

/// 云理解只上传统一的静态 JPEG：限制长边、去除 EXIF/XMP/动画等容器元数据，并把透明区域铺白。
/// 原始素材文件不变；本函数只生成请求期内存数据。
fn prepare_cloud_image(path: &PathBuf) -> Result<Vec<u8>, AppError> {
    let decoded = ImageReader::open(path)
        .and_then(|reader| reader.with_guessed_format())
        .map_err(|error| AppError::Cloud(format!("读取图片 {} 失败: {error}", path.display())))?
        .decode()
        .map_err(|error| AppError::Cloud(format!("解析图片 {} 失败: {error}", path.display())))?;
    let longest = decoded.width().max(decoded.height());
    let normalized = if longest > CLOUD_IMAGE_MAX_EDGE {
        let width =
            ((decoded.width() as u64 * CLOUD_IMAGE_MAX_EDGE as u64) / longest as u64).max(1) as u32;
        let height = ((decoded.height() as u64 * CLOUD_IMAGE_MAX_EDGE as u64) / longest as u64)
            .max(1) as u32;
        decoded.resize(width, height, FilterType::Lanczos3)
    } else {
        decoded
    };

    let rgba = normalized.to_rgba8();
    let (width, height) = rgba.dimensions();
    let rgb = ImageBuffer::<Rgb<u8>, Vec<u8>>::from_fn(width, height, |x, y| {
        let pixel = rgba.get_pixel(x, y).0;
        let alpha = pixel[3] as u16;
        let blend = |channel: u8| ((channel as u16 * alpha + 255 * (255 - alpha)) / 255) as u8;
        Rgb([blend(pixel[0]), blend(pixel[1]), blend(pixel[2])])
    });

    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, CLOUD_IMAGE_JPEG_QUALITY)
        .encode(&rgb, width, height, ExtendedColorType::Rgb8)
        .map_err(|error| AppError::Cloud(format!("编码云理解图片失败: {error}")))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use base64::Engine;
    use image::{DynamicImage, GenericImageView, ImageBuffer, ImageFormat, Rgba};

    use super::{read_image, CLOUD_IMAGE_MAX_EDGE};

    #[tokio::test]
    async fn cloud_image_is_resized_flattened_and_encoded_as_jpeg() {
        let path =
            std::env::temp_dir().join(format!("bowerbird-cloud-image-{}.png", ulid::Ulid::new()));
        let source =
            DynamicImage::ImageRgba8(ImageBuffer::from_pixel(3_200, 1_600, Rgba([10, 20, 30, 0])));
        source.save_with_format(&path, ImageFormat::Png).unwrap();

        let payload = read_image(&path).await.unwrap();
        let encoded = payload["base64"].as_str().unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let output = image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg).unwrap();

        assert_eq!(payload["mime"], "image/jpeg");
        assert_eq!(output.dimensions(), (CLOUD_IMAGE_MAX_EDGE, 800));
        let pixel = output.to_rgb8().get_pixel(0, 0).0;
        assert!(pixel.iter().all(|channel| *channel > 245));
        let _ = std::fs::remove_file(path);
    }
}
