//! Capture through the embedded browser network stack: proxy, cookies and cache
//! stay in WebView2. No cookie export or remote-page IPC capability is required.
use crate::{
    core::{ingest, library::Asset, paths::LibraryPaths},
    db::Database,
    error::{AppError, AppResult},
};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, Webview};
use crate::core::local_classification::explorer::ExplorerAnalysis;

fn capture_url(raw: &str) -> AppResult<tauri::Url> {
    let url = super::source_browser::parse_http_source_url(raw)?;
    if raw.len() > 8192 {
        return Err(AppError::Other("图片地址过长".into()));
    }
    Ok(url)
}

use super::source_browser_network::browser_bytes;

fn import_capture(
    paths: &LibraryPaths,
    db: &Database,
    bytes: &[u8],
    page_url: &str,
    project_id: Option<&str>,
) -> AppResult<Asset> {
    // The drop's project ID is frozen; switching projects never retargets a download.
    if let Some(id) = project_id {
        if db.get_project(id)?.is_none() {
            return Err(AppError::Other("采集目标项目已被删除，未导入图片".into()));
        }
    }
    let paths = paths.for_project(db, project_id)?;
    let asset = ingest::ingest_from_bytes(&paths, db, bytes, page_url, None, None, "extension")?;
    if let Some(id) = project_id {
        db.add_assets_to_project(id, std::slice::from_ref(&asset.id))?;
    }
    Ok(asset)
}

#[tauri::command]
pub async fn capture_source_browser_image(
    app: AppHandle,
    webview: Webview,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    image_url: String,
    page_url: String,
    project_id: Option<String>,
    drag_id: Option<String>,
) -> AppResult<Asset> {
    if webview.label() != "main" {
        return Err(AppError::Other("只允许从素材库接收拖入图片".into()));
    }
    let original_image = image_url.clone();
    let original_page = page_url.clone();
    let image_url = capture_url(&image_url)?;
    let page_url = capture_url(&page_url)?;
    let browser = app
        .get_webview("source-discovery")
        .ok_or_else(|| AppError::Other("探索浏览器尚未打开".into()))?;
    if browser
        .url()
        .map_err(|e| AppError::Other(e.to_string()))?
        .origin()
        != page_url.origin()
    {
        return Err(AppError::Other("来源页面已切换，请重新拖入图片".into()));
    }
    if let Some(id) = &project_id {
        if db.get_project(id)?.is_none() {
            return Err(AppError::Other("采集目标项目已不存在".into()));
        }
    }
    let analysis = app.state::<ExplorerAnalysis>();
    let preview = if let Some(id) = &drag_id {
        analysis.claim(id, &original_image, &original_page);
        analysis.bytes(id, &original_image, &original_page).await.ok().flatten()
    } else { None };
    let bytes = match preview {
        Some(bytes) => bytes,
        None => Arc::new(browser_bytes(&browser, image_url.as_str()).await?),
    };
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let import_db = db.clone();
    let asset = tokio::task::spawn_blocking(move || {
        import_capture(
            &paths,
            &import_db,
            bytes.as_slice(),
            page_url.as_str(),
            project_id.as_deref(),
        )
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    if let Some(id) = &drag_id { analysis.bind(id, &asset.id); }
    crate::core::autoname::spawn_auto_analyze(app.clone(), db, asset.clone());
    let _ = app.emit("library://assets-changed", ());
    Ok(asset)
}

#[tauri::command]
pub fn claim_source_browser_analysis(
    app: AppHandle, webview: Webview, analysis: State<'_, ExplorerAnalysis>, drag_id: String, image_url: String, page_url: String,
) -> AppResult<bool> {
    if webview.label() != "main" { return Err(AppError::Other("只允许主窗口确认采集".into())); }
    capture_url(&image_url)?;
    capture_url(&page_url)?;
    if !app.state::<Arc<Database>>().local_enabled()? {
        analysis.release(&drag_id);
        return Ok(false);
    }
    // A missed/expired dragstart must not silently turn off classification.
    if !analysis.claim(&drag_id, &image_url, &page_url) {
        analysis.begin(&app, drag_id.clone(), image_url.clone(), page_url.clone()).map_err(AppError::Other)?;
    }
    Ok(analysis.claim(&drag_id, &image_url, &page_url))
}

#[tauri::command]
pub fn release_source_browser_analysis(webview: Webview, analysis: State<'_, ExplorerAnalysis>, drag_id: String) -> AppResult<()> {
    if webview.label() != "main" { return Err(AppError::Other("只允许主窗口取消采集".into())); }
    analysis.release(&drag_id);
    Ok(())
}

#[tauri::command]
pub async fn finish_source_browser_analysis(
    app: AppHandle, webview: Webview, analysis: State<'_, ExplorerAnalysis>, drag_id: String, asset_id: String,
) -> AppResult<Vec<String>> {
    if webview.label() != "main" { return Err(AppError::Other("只允许主窗口完成采集".into())); }
    analysis.finish(&app, &drag_id, &asset_id).await.map_err(AppError::Other)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_import_preserves_extension_provenance_and_project_membership() {
        let root = std::env::temp_dir().join(format!("bb-explorer-test-{}", ulid::Ulid::new()));
        let paths = LibraryPaths::init(root.clone()).unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.create_project("target", "target", "", "target", "blank")
            .unwrap();
        db.create_project("other", "other", "", "other", "blank")
            .unwrap();
        let image = crate::media::phash::testutil::make_photo_file(&root, "fixture.png", 128, 42);
        let bytes = std::fs::read(image).unwrap();
        let url = "https://example.com/pin/123";
        assert!(import_capture(&paths, &db, &bytes, url, Some("deleted")).is_err());
        assert_eq!(db.count_assets(None).unwrap(), 0);
        let asset = import_capture(&paths, &db, &bytes, url, Some("target")).unwrap();
        assert_eq!(asset.source.as_deref(), Some("extension"));
        assert_eq!(asset.source_url.as_deref(), Some(url));
        assert_eq!(asset.origin_path, None);
        assert!(asset
            .thumb_path
            .as_deref()
            .is_some_and(|path| std::path::Path::new(path).is_file()));
        assert_eq!(db.get_project("target").unwrap().unwrap().asset_count, 1);
        assert_eq!(db.get_project("other").unwrap().unwrap().asset_count, 0);
        let repeated = import_capture(&paths, &db, &bytes, url, Some("target")).unwrap();
        assert_eq!(repeated.id, asset.id);
        assert_eq!(db.count_assets(None).unwrap(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn capture_rejects_privileged_urls_and_credentials() {
        for url in [
            "file:///c:/secret",
            "javascript:alert(1)",
            "https://user:pw@example.com/a",
            "data:image/png;base64,a",
        ] {
            assert!(capture_url(url).is_err());
        }
        assert!(capture_url("https://i.pinimg.com/image.png?token=x").is_ok());
    }
}
