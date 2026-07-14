//! 导入流水线（开发计划 §5.1）：probe → 复制原图 → 缩略图 → pHash → 去重 → 入库。
//! 视频/PSD/SVG 等多格式在 Phase 2 接入；Phase 1 覆盖常见光栅图。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use chrono::Utc;
use ulid::Ulid;

use crate::core::library::Asset;
use crate::core::paths::LibraryPaths;
use crate::db::Database;
use crate::error::{AppError, AppResult};
use crate::media;

/// 导入单个文件。若 pHash 命中已有资产，删除新副本并返回已有资产。
pub fn ingest_file(paths: &LibraryPaths, db: &Database, source: &Path) -> AppResult<Asset> {
    let meta = media::probe::probe(source)?;
    let id = Ulid::new().to_string();
    let name = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled")
        .to_string();

    let store_path = paths.asset_store_path(&id, &meta.ext);
    fs::create_dir_all(store_path.parent().unwrap())?;
    fs::copy(source, &store_path)?;

    // 缩略图：图片用 image resize；视频用 ffmpeg 抽帧；SVG 用原文件（前端直渲染）。
    let thumb_path = if media::probe::is_video(&meta.ext) {
        let p = paths.thumb_path(&id);
        if let Err(e) = media::thumb::generate_video(&store_path, &p, 480) {
            tracing::warn!("video thumb failed for {}: {e}", source.display());
        }
        p
    } else if meta.ext == "svg" {
        store_path.clone()
    } else {
        let p = paths.thumb_path(&id);
        if meta.width > 0 && meta.height > 0 {
            if let Err(e) = media::thumb::generate(&store_path, &p, 480) {
                tracing::warn!("thumb failed for {}: {e}", source.display());
            }
        }
        p
    };

    let phash = media::phash::compute(&store_path).ok().flatten();

    let colors = if meta.width > 0 {
        media::color::extract(&store_path, 5)
            .ok()
            .map(|c| serde_json::to_string(&c).unwrap_or_default())
    } else {
        None
    };

    // 去重：pHash 命中则回滚新副本。
    if let Some(ref h) = phash {
        if let Some(existing) = db.find_asset_by_phash(h)? {
            let _ = fs::remove_file(&store_path);
            let _ = fs::remove_file(&thumb_path);
            return Ok(existing);
        }
    }

    let now = Utc::now().timestamp();
    let file_mtime = fs::metadata(source)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(now);

    let asset = Asset {
        id: id.clone(),
        name,
        ext: Some(meta.ext),
        origin_path: Some(source.to_string_lossy().into_owned()),
        store_path: Some(store_path.to_string_lossy().into_owned()),
        thumb_path: Some(thumb_path.to_string_lossy().into_owned()),
        size: Some(meta.size as i64),
        width: Some(meta.width as i64),
        height: Some(meta.height as i64),
        duration: Some(meta.duration),
        phash,
        colors,
        rating: Some(0),
        source: Some("imported".to_string()),
        source_url: None,
        folder_id: None,
        created_at: Some(now),
        file_mtime: Some(file_mtime),
        generation_session_id: None,
    };
    db.insert_asset(&asset)?;
    link_colors(db, &asset.id, asset.colors.as_deref());
    Ok(asset)
}

/// 导入 codex 生成的图：probe → 复制到 store → 缩略图 → 入库。
///
/// 与 `ingest_file` 的区别：**不做 pHash 去重**——生成的图即便彼此相似（迭代修改的各版）
/// 也应各自保留，去重会让修订版被当重复吞掉；也不算 pHash（生成图不需要采重去重）。
/// `source` 标 `"codex"` 便于在库里区分 / 建智能文件夹。
pub fn ingest_generated(
    paths: &LibraryPaths,
    db: &Database,
    source: &Path,
    session_id: Option<&str>,
) -> AppResult<Asset> {
    let meta = media::probe::probe(source)?;
    let id = Ulid::new().to_string();
    let name = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("generated")
        .to_string();

    let store_path = paths.asset_store_path(&id, &meta.ext);
    fs::create_dir_all(store_path.parent().unwrap())?;
    fs::copy(source, &store_path)?;

    let thumb_path = if meta.ext == "svg" {
        store_path.clone()
    } else {
        let p = paths.thumb_path(&id);
        if meta.width > 0 && meta.height > 0 {
            if let Err(e) = media::thumb::generate(&store_path, &p, 480) {
                tracing::warn!("thumb failed for {}: {e}", source.display());
            }
        }
        p
    };

    let colors = if meta.width > 0 {
        media::color::extract(&store_path, 5)
            .ok()
            .map(|c| serde_json::to_string(&c).unwrap_or_default())
    } else {
        None
    };

    let now = Utc::now().timestamp();
    let asset = Asset {
        id: id.clone(),
        name,
        ext: Some(meta.ext),
        origin_path: Some(source.to_string_lossy().into_owned()),
        store_path: Some(store_path.to_string_lossy().into_owned()),
        thumb_path: Some(thumb_path.to_string_lossy().into_owned()),
        size: Some(meta.size as i64),
        width: Some(meta.width as i64),
        height: Some(meta.height as i64),
        duration: Some(meta.duration),
        phash: None,
        colors,
        rating: Some(0),
        source: Some("codex".to_string()),
        source_url: None,
        folder_id: None,
        created_at: Some(now),
        file_mtime: Some(now),
        generation_session_id: session_id.map(|s| s.to_string()),
    };
    db.insert_asset(&asset)?;
    link_colors(db, &asset.id, asset.colors.as_deref());
    Ok(asset)
}

/// 把 assets.colors（JSON hex 数组）量化成桶写入 asset_colors（P3）。
/// ingest_file / ingest_generated 共用；colors 为空或量化无桶则跳过。
fn link_colors(db: &Database, id: &str, colors: Option<&str>) {
    let Some(json) = colors else { return };
    let buckets = media::color::colors_to_buckets(json);
    if buckets.is_empty() {
        return;
    }
    if let Err(e) = db.set_asset_colors(id, &buckets) {
        tracing::warn!("link_colors {id}: {e}");
    }
}

/// 递归遍历目录，返回所有支持图片格式的文件路径。
pub fn walk_images(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(entries) = fs::read_dir(&d) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if let Some(ext) = p.extension().and_then(|x| x.to_str()) {
                    if media::is_image_ext(ext) {
                        out.push(p);
                    }
                }
            }
        }
    }
    out
}

/// 导入目录下所有图片，返回成功入库的资产（含 dHash 命中的已有资产）。
pub fn ingest_dir(paths: &LibraryPaths, db: &Database, dir: &Path) -> AppResult<Vec<Asset>> {
    let mut assets = Vec::new();
    for p in walk_images(dir) {
        match ingest_file(paths, db, &p) {
            Ok(a) => assets.push(a),
            Err(e) => tracing::warn!("ingest failed for {}: {e}", p.display()),
        }
    }
    Ok(assets)
}

/// 下载扩展采集的图。带浏览器常用请求头，降低图床的基础防盗链拦截概率。
pub async fn ingest_from_url(
    paths: &LibraryPaths,
    db: &Database,
    url: &str,
    page_url: Option<&str>,
) -> AppResult<Asset> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36")
        .build()
        .map_err(|e| AppError::Media(format!("create downloader: {e:#}")))?;
    let mut request = client
        .get(url)
        .header(reqwest::header::ACCEPT, "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8");
    if let Some(referer) = page_url.filter(|value| value.starts_with("http://") || value.starts_with("https://")) {
        request = request.header(reqwest::header::REFERER, referer);
    }
    let resp = request
        .send()
        .await
        .map_err(|e| AppError::Media(format!("download {url}: {e:#}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Media(format!(
            "download {url} status {}",
            resp.status()
        )));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Media(format!("read body: {e:#}")))?;

    // 从 URL 推断扩展名
    let ext = url_path_extension(url);
    let tmp = std::env::temp_dir().join(format!("bowerbird-{}.{}", Ulid::new(), ext));
    fs::write(&tmp, &bytes)?;

    // source 的文件名用于 asset.name
    let source_name = url.rsplit('/').next().unwrap_or("extension-image");
    let source_path = std::env::temp_dir().join(source_name);
    let _ = fs::rename(&tmp, &source_path);

    // ingest_file 不会读 source URL；source 标记靠后面 update。这里直接 ingest，再改 source。
    let mut asset = ingest_file(paths, db, &source_path)?;
    // 标记来源为 extension + source_url。
    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE assets SET source='extension', source_url=?1 WHERE id=?2",
            rusqlite::params![url, asset.id],
        )?;
    }
    asset.source = Some("extension".to_string());
    asset.source_url = Some(url.to_string());

    let _ = fs::remove_file(&source_path);
    Ok(asset)
}

/// 浏览器扩展已经在浏览器登录态内取到图片字节；桌面端只负责落临时文件并走标准入库。
/// 这条路径避免桌面端二次下载丢失 Cookie / 授权头 / 页面会话。
pub fn ingest_from_bytes(
    paths: &LibraryPaths,
    db: &Database,
    bytes: &[u8],
    source_url: &str,
    file_name: Option<&str>,
    content_type: Option<&str>,
) -> AppResult<Asset> {
    if bytes.is_empty() {
        return Err(AppError::Media("extension uploaded an empty image".into()));
    }

    // URL、文件名和 Content-Type 都可能撒谎（拖拽页面链接时甚至会返回 HTML）。
    // 以实际字节能否解码为准，同时用真实格式决定库内扩展名。
    let ext = uploaded_image_extension(bytes, content_type)?;
    let safe_stem = file_name
        .and_then(|name| Path::new(name).file_stem().and_then(|s| s.to_str()))
        .map(|stem| {
            stem.chars()
                .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
                .take(80)
                .collect::<String>()
        })
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or_else(|| "extension-image".to_string());

    let tmp_dir = std::env::temp_dir().join(format!("bowerbird-upload-{}", Ulid::new()));
    fs::create_dir_all(&tmp_dir)?;
    let source_path = tmp_dir.join(format!("{safe_stem}.{ext}"));
    fs::write(&source_path, bytes)?;

    let result = (|| -> AppResult<Asset> {
        let mut asset = ingest_file(paths, db, &source_path)?;
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE assets SET source='extension', source_url=?1 WHERE id=?2",
            rusqlite::params![source_url, asset.id],
        )?;
        asset.source = Some("extension".to_string());
        asset.source_url = Some(source_url.to_string());
        Ok(asset)
    })();
    let _ = fs::remove_dir_all(&tmp_dir);
    result
}

fn uploaded_image_extension(bytes: &[u8], content_type: Option<&str>) -> AppResult<&'static str> {
    let is_svg = content_type
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("image/svg+xml"));
    if is_svg {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| AppError::Media("browser returned invalid SVG bytes".into()))?;
        if text.trim_start().starts_with("<svg") || text.contains("<svg") {
            return Ok("svg");
        }
        return Err(AppError::Media("browser response says SVG but contains no SVG".into()));
    }

    let format = image::guess_format(bytes)
        .map_err(|_| AppError::Media("browser returned content that is not a supported image".into()))?;
    let ext = match format {
        image::ImageFormat::Jpeg => "jpg",
        image::ImageFormat::Png => "png",
        image::ImageFormat::WebP => "webp",
        image::ImageFormat::Gif => "gif",
        image::ImageFormat::Bmp => "bmp",
        _ => {
            return Err(AppError::Media(format!(
                "browser returned unsupported image format: {format:?}"
            )))
        }
    };
    image::load_from_memory_with_format(bytes, format)
        .map_err(|error| AppError::Media(format!("browser returned undecodable image: {error}")))?;
    Ok(ext)
}

fn url_path_extension(url: &str) -> String {
    let path = url.split('?').next().unwrap_or(url);
    let ext = path.rsplit('.').next().unwrap_or("");
    if media::is_image_ext(ext) {
        ext.to_ascii_lowercase()
    } else {
        "jpg".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::paths::LibraryPaths;
    use crate::db::Database;
    use image::{ImageBuffer, Rgb};
    use ulid::Ulid;

    struct Tmp {
        dir: PathBuf,
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn setup() -> (Tmp, LibraryPaths, Database) {
        let dir = std::env::temp_dir().join(format!("bb-test-{}", Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = LibraryPaths::init(dir.clone()).unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        (Tmp { dir }, paths, db)
    }

    fn make_png(path: &Path, w: u32, h: u32, rgb: [u8; 3]) {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_pixel(w, h, Rgb(rgb));
        img.save(path).unwrap();
    }

    /// 带渐变的图（避免纯色图 dHash 退化为全 0）。
    fn make_gradient(path: &Path, seed: u8) {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_fn(64, 64, |x, y| {
            Rgb([
                ((x * 4 + seed as u32) % 256) as u8,
                ((y * 4 + seed as u32) % 256) as u8,
                seed,
            ])
        });
        img.save(path).unwrap();
    }

    #[test]
    fn ingest_basic_and_dedupe() {
        let (tmp, paths, db) = setup();
        let img_path = tmp.dir.join("test.png");
        make_png(&img_path, 100, 80, [255, 0, 0]);

        let asset = ingest_file(&paths, &db, &img_path).unwrap();
        assert_eq!(asset.width, Some(100));
        assert_eq!(asset.height, Some(80));
        assert!(asset.phash.is_some(), "phash should be computed");
        assert_eq!(db.count_assets().unwrap(), 1);

        // 缩略图文件应存在
        let thumb = asset.thumb_path.as_deref().unwrap();
        assert!(Path::new(thumb).exists(), "thumb file should exist");

        // 去重：再导入同一张 → 不新增
        let _ = ingest_file(&paths, &db, &img_path).unwrap();
        assert_eq!(db.count_assets().unwrap(), 1, "duplicate should be deduped");
    }

    #[test]
    fn ingest_browser_uploaded_bytes() {
        let (tmp, paths, db) = setup();
        let source = tmp.dir.join("browser-source.png");
        make_png(&source, 37, 29, [12, 34, 56]);
        let bytes = std::fs::read(&source).unwrap();

        let asset = ingest_from_bytes(
            &paths,
            &db,
            &bytes,
            "https://example.test/protected/image?id=42",
            Some("captured.png"),
            Some("image/png"),
        )
        .unwrap();

        assert_eq!(asset.name, "captured");
        assert_eq!(asset.source.as_deref(), Some("extension"));
        assert_eq!(
            asset.source_url.as_deref(),
            Some("https://example.test/protected/image?id=42")
        );
        assert_eq!(asset.width, Some(37));
        assert_eq!(asset.height, Some(29));
        assert!(Path::new(asset.store_path.as_deref().unwrap()).exists());
        assert_eq!(db.count_assets().unwrap(), 1);
    }

    #[test]
    fn browser_upload_uses_byte_format_instead_of_name() {
        let (tmp, paths, db) = setup();
        let source = tmp.dir.join("actual.webp");
        make_png(&source, 31, 23, [42, 84, 126]);
        let bytes = std::fs::read(&source).unwrap();

        let asset = ingest_from_bytes(
            &paths,
            &db,
            &bytes,
            "https://example.test/image-without-extension",
            Some("extension-image"),
            Some("application/octet-stream"),
        )
        .unwrap();

        // image::save follows the .webp extension above, so byte sniffing must win over metadata.
        assert_eq!(asset.ext.as_deref(), Some("webp"));
        assert!(asset.store_path.as_deref().unwrap().ends_with(".webp"));
        assert!(Path::new(asset.thumb_path.as_deref().unwrap()).exists());
    }

    #[test]
    fn browser_upload_rejects_html_without_creating_asset() {
        let (_tmp, paths, db) = setup();
        let html = b"<!DOCTYPE html><html><body>not an image</body></html>";

        let error = ingest_from_bytes(
            &paths,
            &db,
            html,
            "https://example.test/page",
            Some("extension-image"),
            Some("text/html; charset=utf-8"),
        )
        .unwrap_err();

        assert!(error.to_string().contains("not a supported image"));
        assert_eq!(db.count_assets().unwrap(), 0);
    }

    #[test]
    fn ingest_multiple_different() {
        let (tmp, paths, db) = setup();
        make_gradient(&tmp.dir.join("a.png"), 10);
        make_gradient(&tmp.dir.join("b.png"), 120);
        make_gradient(&tmp.dir.join("c.png"), 200);

        let assets = ingest_dir(&paths, &db, &tmp.dir).unwrap();
        assert_eq!(assets.len(), 3, "three distinct images should all be ingested");
        assert_eq!(db.count_assets().unwrap(), 3);
    }

    #[test]
    fn delete_removes_db_row_and_files() {
        let (tmp, paths, db) = setup();
        let img_path = tmp.dir.join("del.png");
        make_png(&img_path, 100, 80, [10, 20, 30]);

        let asset = ingest_file(&paths, &db, &img_path).unwrap();
        let store = asset.store_path.clone().unwrap();
        let thumb = asset.thumb_path.clone().unwrap();
        assert!(Path::new(&store).exists(), "store file should exist before delete");
        assert!(Path::new(&thumb).exists(), "thumb file should exist before delete");

        db.delete_asset(&asset.id).unwrap();

        assert_eq!(db.count_assets().unwrap(), 0, "db row should be gone");
        assert!(!Path::new(&store).exists(), "store file should be physically deleted");
        assert!(!Path::new(&thumb).exists(), "thumb file should be physically deleted");
    }

    #[test]
    fn set_assets_folder_moves_assets() {
        let (tmp, paths, db) = setup();
        make_gradient(&tmp.dir.join("a.png"), 10);
        make_gradient(&tmp.dir.join("b.png"), 120);
        let a1 = ingest_file(&paths, &db, &tmp.dir.join("a.png")).unwrap();
        let a2 = ingest_file(&paths, &db, &tmp.dir.join("b.png")).unwrap();

        let fid = "01TESTFOLDER".to_string();
        db.create_folder(&fid, "测试", None).unwrap();

        db.set_assets_folder(&[a1.id.clone(), a2.id.clone()], &fid)
            .unwrap();

        let g1 = db.get_asset(&a1.id).unwrap().unwrap();
        let g2 = db.get_asset(&a2.id).unwrap().unwrap();
        assert_eq!(g1.folder_id.as_deref(), Some("01TESTFOLDER"));
        assert_eq!(g2.folder_id.as_deref(), Some("01TESTFOLDER"));
    }

    #[test]
    fn walk_filters_non_images() {
        let (tmp, _paths, _db) = setup();
        for name in ["a.png", "b.jpg", "c.txt", "d.gif", "e.md"] {
            std::fs::write(tmp.dir.join(name), b"x").unwrap();
        }
        let found = walk_images(&tmp.dir);
        let exts: Vec<String> = found
            .iter()
            .filter_map(|p| p.extension().and_then(|e| e.to_str()).map(String::from))
            .collect();
        assert!(exts.contains(&"png".to_string()));
        assert!(exts.contains(&"jpg".to_string()));
        assert!(exts.contains(&"gif".to_string()));
        assert!(!exts.contains(&"txt".to_string()));
        assert!(!exts.contains(&"md".to_string()));
    }
}
