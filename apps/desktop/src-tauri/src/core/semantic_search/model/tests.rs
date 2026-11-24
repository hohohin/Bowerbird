use std::sync::atomic::AtomicBool;

use image::RgbImage;
use sha2::{Digest, Sha256};

use crate::core::semantic_search::embedding::Embedding;

use super::*;

#[test]
fn model_id_covers_weight_tokenizer_and_preprocessing_fingerprints() {
    let contract = "siglip2-224-rgba-on-white-bilinear-minus1_to1-chw-v1+unicode-lower-eos1-pad0-seq64-v1+fp32-pooler-output-l2-768-v1";
    let manifest = [
        artifacts::TEXT.sha256,
        artifacts::VISION.sha256,
        artifacts::TOKENIZER.sha256,
        contract,
    ]
    .join("\n");
    assert_eq!(MODEL_ID, format!("siglip2-{:x}", Sha256::digest(manifest)));
}

#[test]
fn text_tensor_pads_and_preserves_eos_on_truncation() {
    let (input, truncated) = text_tokens(&[12, 34]);
    assert_eq!(input.shape(), &[1, 64]);
    assert_eq!(&input.as_slice().unwrap()[..4], &[12, 34, EOS, PAD]);
    assert!(!truncated);

    let (input, truncated) = text_tokens(&[12; 64]);
    assert_eq!(input[[0, 62]], 12);
    assert_eq!(input[[0, 63]], EOS);
    assert!(truncated);
    assert!(!text_tokens(&[12; 63]).1);
}

#[test]
fn image_tensor_resizes_and_normalizes_rgb_in_chw_order() {
    let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(35, 17, image::Rgb([0, 127, 255])));
    let input = pixels(&image);
    assert_eq!(input.shape(), &[1, 3, 224, 224]);
    assert_eq!(input[[0, 0, 0, 0]], -1.0);
    assert!((input[[0, 1, 223, 223]] + 1.0 / 255.0).abs() < 1e-6);
    assert_eq!(input[[0, 2, 223, 223]], 1.0);
}

#[test]
fn transparent_colors_do_not_influence_the_embedding_input() {
    let image =
        |pixel| DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(16, 16, image::Rgba(pixel)));
    assert_eq!(
        pixels(&image([20, 16, 8, 0])),
        pixels(&image([255, 255, 255, 255]))
    );
    assert_eq!(
        pixels(&image([128, 5, 160, 0])),
        pixels(&image([255, 255, 255, 255]))
    );
}

#[tokio::test]
#[ignore = "requires pinned FP32 artifacts in an isolated BOWERBIRD_SEMANTIC_MODEL_TEST_ROOT"]
async fn semantic_search_real_fp32_chinese_retrieval() {
    let root = PathBuf::from(std::env::var_os("BOWERBIRD_SEMANTIC_MODEL_TEST_ROOT").unwrap());
    install(&root, &AtomicBool::new(false), |name, bytes, total| {
        println!("{name}: {bytes}/{total}");
    })
    .await
    .unwrap();
    let start = std::time::Instant::now();
    let mut model = Embedder::load(&root).unwrap();
    model.prepare_vision().unwrap();
    let samples = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/onboarding-v0917");
    let images: Vec<_> = ["asset-007.png", "asset-011.png", "asset-016.png"]
        .iter()
        .map(|name| {
            let image = image::open(samples.join(name)).unwrap();
            Embedding::normalize(model.embed_image(&image).unwrap()).unwrap()
        })
        .collect();
    model.prepare_text().unwrap();
    for (expected, query) in ["矿泉水瓶产品摄影", "少年和一只小狗", "网球运动员挥拍"]
        .iter()
        .enumerate()
    {
        let text = model.embed_text(query).unwrap();
        assert!(!text.truncated);
        let text = Embedding::normalize(text.vector).unwrap();
        let scores: Vec<_> = images.iter().map(|image| text.similarity(image)).collect();
        let best = scores
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.total_cmp(b))
            .unwrap()
            .0;
        println!("{query}: {scores:?}");
        assert_eq!(best, expected);
    }
    assert!(model.embed_text(&"网球和狗 ".repeat(96)).unwrap().truncated);
    println!("FP32 native model and retrieval took {:?}", start.elapsed());
}
