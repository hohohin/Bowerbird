use std::fs::File;
use std::io::{Cursor, Read};
use std::path::Path;

use image::{
    codecs::{jpeg::JpegDecoder, png::PngDecoder, webp::WebPDecoder},
    DynamicImage, ImageDecoder, ImageFormat,
};
use sha2::{Digest, Sha256};

const MAX_BYTES: u64 = 128 * 1024 * 1024;
const HEIC_MAX_BYTES: u64 = 50 * 1024 * 1024;
const MAX_PIXELS: u64 = 40_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Failure {
    Unavailable,
    Changed,
    Unsupported,
    ResourceLimit,
    Decode,
    Model,
    Interrupted,
}

impl From<std::io::Error> for Failure {
    fn from(error: std::io::Error) -> Self {
        tracing::debug!(%error, "semantic index could not read an original");
        Self::Unavailable
    }
}

impl From<image::ImageError> for Failure {
    fn from(error: image::ImageError) -> Self {
        tracing::debug!(%error, "semantic index image decoder rejected an original");
        if matches!(error, image::ImageError::Limits(_)) {
            Self::ResourceLimit
        } else {
            Self::Decode
        }
    }
}

pub(super) struct Bytes {
    data: Vec<u8>,
    pub(super) sha256: String,
}

fn checked_open(path: &Path) -> Result<File, Failure> {
    let file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(Failure::Unavailable);
    }
    if metadata.len() > MAX_BYTES {
        return Err(Failure::ResourceLimit);
    }
    Ok(file)
}

pub(super) fn read(path: &Path) -> Result<Bytes, Failure> {
    let file = checked_open(path)?;
    let mut data = Vec::new();
    let expected_length = file.metadata()?.len();
    file.take(MAX_BYTES + 1).read_to_end(&mut data)?;
    if data.len() as u64 > MAX_BYTES {
        return Err(Failure::ResourceLimit);
    }
    if data.len() as u64 != expected_length {
        return Err(Failure::Changed);
    }
    let sha256 = format!("{:x}", Sha256::digest(&data));
    Ok(Bytes { data, sha256 })
}

pub(super) fn digest_at_path(path: &Path) -> Result<String, Failure> {
    let mut file = checked_open(path)?.take(MAX_BYTES + 1);
    let mut hasher = Sha256::new();
    let mut read = 0;
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let length = file.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        read += length as u64;
        hasher.update(&buffer[..length]);
    }
    if read > MAX_BYTES {
        return Err(Failure::ResourceLimit);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

impl Bytes {
    pub(super) fn decode(&self) -> Result<DynamicImage, Failure> {
        let cursor = Cursor::new(&self.data);
        match image::guess_format(&self.data) {
            Ok(ImageFormat::Jpeg) => decode(JpegDecoder::new(cursor)?),
            Ok(ImageFormat::Png) => {
                let decoder = PngDecoder::new(cursor)?;
                if decoder.is_apng()? {
                    return Err(Failure::Unsupported);
                }
                decode(decoder)
            }
            Ok(ImageFormat::WebP) => {
                let decoder = WebPDecoder::new(cursor)?;
                if decoder.has_animation() {
                    return Err(Failure::Unsupported);
                }
                decode(decoder)
            }
            _ if crate::media::heic::is_heic(&self.data) => {
                if self.data.len() as u64 > HEIC_MAX_BYTES {
                    return Err(Failure::ResourceLimit);
                }
                let options = heic_rs::DecodeOptions::default()
                    .with_layout(heic_rs::PixelLayout::Rgba8)
                    .with_max_pixels(Some(MAX_PIXELS))
                    .with_strict(true);
                let image = heic_rs::decode(&self.data, &options).map_err(|error| {
                    tracing::debug!(%error, "semantic index HEIC decoder rejected an original");
                    Failure::Decode
                })?;
                image::RgbaImage::from_raw(image.width, image.height, image.data)
                    .map(DynamicImage::ImageRgba8)
                    .ok_or(Failure::Decode)
            }
            Err(_) => Err(Failure::Decode),
            _ => Err(Failure::Unsupported),
        }
    }
}

fn decode(mut decoder: impl ImageDecoder) -> Result<DynamicImage, Failure> {
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(Failure::ResourceLimit);
    }
    let orientation = decoder.orientation()?;
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    Ok(image)
}
