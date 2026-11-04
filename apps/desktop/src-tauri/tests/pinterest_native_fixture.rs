//! Debug-only isolated native runner: real commands, synthetic registered image.
use crate::{commands::{pinterest_search, source_browser}, core::paths::LibraryPaths, db::Database};
use std::sync::Arc;

struct FixtureAsset(String);

#[tauri::command]
fn smoke_asset(asset: tauri::State<'_, FixtureAsset>) -> String { asset.0.clone() }

#[tauri::command]
fn smoke_exit(app: tauri::AppHandle) { app.exit(0); }

#[tauri::command]
async fn smoke_region(app: tauri::AppHandle, points: Vec<(f64, f64)>) -> Result<Vec<bool>, String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        use windows::Win32::{Foundation::{HWND, RECT}, Graphics::Gdi::{CreateRectRgn, GetWindowRgn, PtInRegion, DeleteObject, HGDIOBJ}, UI::WindowsAndMessaging::GetClientRect};
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.get_webview("source-discovery").ok_or("missing source")?.with_webview(move |view| unsafe {
            let mut hwnd = HWND::default(); view.controller().ParentWindow(&mut hwnd).unwrap();
            let mut rect = RECT::default(); GetClientRect(hwnd, &mut rect).unwrap();
            let region = CreateRectRgn(0, 0, 0, 0);
            let clipped = GetWindowRgn(hwnd, region).0 != 0;
            let points = points.into_iter().map(|(x,y)| !clipped || PtInRegion(region, (x * rect.right as f64) as i32, (y * rect.bottom as f64) as i32).as_bool()).collect();
            let _ = DeleteObject(HGDIOBJ(region.0)); let _ = tx.send(points);
        }).map_err(|error| error.to_string())?;
        rx.await.map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = (app, points); Err("Windows-only region probe".into()) }
}

pub fn run_pinterest_search_fixture() {
    assert!(cfg!(debug_assertions), "fixture must never run in a release build");
    let root = std::path::PathBuf::from(std::env::var_os("BOWERBIRD_PINTEREST_TEST_ROOT").expect("isolated test root required"));
    let root = root.canonicalize().expect("existing isolated root");
    assert!(!root.join("library").exists(), "new fixture library required");
    let paths = Arc::new(LibraryPaths::init(root.join("library")).unwrap());
    let db = Arc::new(Database::open(&paths.db).unwrap()); db.migrate().unwrap();
    let original = root.join("synthetic.png");
    image::RgbaImage::from_pixel(16, 12, image::Rgba([24, 64, 128, 255])).save(&original).unwrap();
    let asset = db.index_connected_file(&paths, &original, None).unwrap();
    std::env::set_var("BOWERBIRD_EXPLORER_TEST_DATA_DIR", root.join("sites"));
    std::env::set_var("BOWERBIRD_EXPLORER_TEST_DEBUG_PORT", "9568");
    let mut context = tauri::generate_context!("tests/fixtures/explorer/tauri.conf.json");
    context.config_mut().app.windows[0].data_directory = Some(root.join("main"));
    context.config_mut().app.windows[0].additional_browser_args = Some("--remote-debugging-port=9567 --remote-debugging-address=127.0.0.1".into());
    context.config_mut().app.windows[0].visible = false;
    tauri::Builder::default()
        .manage(paths).manage(db).manage(FixtureAsset(asset.id))
        .manage(pinterest_search::PinterestSearchState::default())
        .manage(source_browser::SourcePinterestHooks {
            loaded: pinterest_search::on_page_finished,
            notice: pinterest_search::on_notice,
        })
        .invoke_handler(tauri::generate_handler![
            source_browser::open_source_browser, source_browser::resize_source_browser,
            source_browser::navigate_source_browser, source_browser::hide_source_browser,
            source_browser::source_browser_back, source_browser::source_browser_forward,
            source_browser::reload_source_browser,
            pinterest_search::start_pinterest_image_search,
            pinterest_search::cancel_pinterest_image_search,
            smoke_asset, smoke_exit, smoke_region,
        ])
        .run(context).expect("isolated Pinterest native fixture failed");
}
