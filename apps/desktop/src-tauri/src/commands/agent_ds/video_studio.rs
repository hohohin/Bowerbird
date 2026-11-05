//! Task-scoped HyperFrames Studio, isolated from the exploration browser and main IPC.
use super::*;
use tauri::{Manager, LogicalPosition, LogicalSize, WebviewUrl, webview::{WebviewBuilder, NewWindowResponse}};
use tokio::sync::{Mutex, watch};

const LABEL: &str = "video-studio";
struct Session { id: String, editor_session_id: String, scope: String, server: Server }
pub(super) struct Server { pub(super) child: tokio::process::Child, pub(super) url: String }
static SESSION: Mutex<Option<Session>> = Mutex::const_new(None);
static OPENING: std::sync::Mutex<Option<(String, watch::Sender<bool>)>> = std::sync::Mutex::new(None);
struct Opening(String);
impl Drop for Opening {
    fn drop(&mut self) {
        if let Ok(mut opening) = OPENING.lock() {
            if opening.as_ref().is_some_and(|(id, _)| id == &self.0) { *opening = None; }
        }
    }
}
fn cancel_opening(id: Option<&str>) {
    if let Ok(opening) = OPENING.lock() {
        if let Some((current, cancel)) = opening.as_ref() {
            if id.is_none_or(|id| id == current) { let _ = cancel.send(true); }
        }
    }
}

#[derive(Clone, Copy, serde::Deserialize)]
pub struct StudioBounds { x: f64, y: f64, width: f64, height: f64 }

fn validate(bounds: StudioBounds) -> Result<StudioBounds, AppError> {
    if ![bounds.x, bounds.y, bounds.width, bounds.height].iter().all(|n| n.is_finite())
        || bounds.x < 0.0 || bounds.y < 0.0 || !(240.0..=10000.0).contains(&bounds.width) || !(180.0..=10000.0).contains(&bounds.height) {
        return Err(AppError::Other("视频编辑面板尺寸无效".into()));
    }
    Ok(bounds)
}

pub(super) fn ensure_closed(scope: &str) -> Result<(), AppError> {
    let session = SESSION.try_lock().map_err(|_| AppError::Other("视频编辑面板正在切换，请稍后重试".into()))?;
    if session.as_ref().is_some_and(|session| session.scope == scope) {
        return Err(AppError::Other("请先在 Studio 保存修改并关闭面板，再运行本卡片".into()));
    }
    Ok(())
}

pub(super) async fn launch(root: &Path, prepared: video::Prepared, cancel: &watch::Receiver<bool>) -> Result<Server, AppError> {
    if *cancel.borrow() { return Err(AppError::Other("视频编辑器启动已取消".into())); }
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    let mut cmd = prepared.local_command();
    cmd.args(["preview", "--foreground", "--no-open", "--force-new", "--port", &port.to_string()]);
    #[cfg(unix)]
    cmd.process_group(0);
    let log = std::fs::File::create(root.join("video-studio.log"))?;
    cmd.stdin(std::process::Stdio::null()).stdout(log.try_clone()?).stderr(log);
    let mut child = cmd.spawn()?;
    let url = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(1)).build()
        .map_err(|error| AppError::Other(format!("视频编辑连接初始化失败：{error}")))?;
    let project = std::fs::canonicalize(root.join("project"))?;
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while std::time::Instant::now() < deadline {
        if *cancel.borrow() { break; }
        if child.try_wait()?.is_some() { break; }
        if let Ok(response) = client.get(format!("{url}/__hyperframes_config")).send().await {
            if let Ok(config) = response.json::<Value>().await {
                if config["pid"].as_u64() == child.id().map(u64::from)
                    && config["projectDir"].as_str().and_then(|path| std::fs::canonicalize(path).ok()).as_ref() == Some(&project) {
                    return Ok(Server { child, url });
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    video::stop_child(&mut child).await;
    Err(AppError::Other("视频编辑器未能启动，请检查工程后重试".into()))
}

#[tauri::command]
pub async fn agent_video_studio_open(app: tauri::AppHandle, request_id: String, editor_session_id: String, bounds: StudioBounds) -> Result<(), AppError> {
    let bounds = validate(bounds)?;
    uuid::Uuid::parse_str(&editor_session_id).map_err(|_| AppError::Other("视频编辑会话无效".into()))?;
    let root = codex::request_root(&request_id)?;
    let request: Value = serde_json::from_slice(&std::fs::read(root.join("video-request.json"))?)?;
    let scope = request["scope"].as_str().ok_or_else(|| AppError::Other("视频工程身份缺失".into()))?;
    let mut session = SESSION.lock().await;
    if let Some(current) = session.as_mut() {
        if current.id != request_id { return Err(AppError::Other("请先关闭当前视频编辑面板".into())); }
        // A new panel can claim the same live editor; late cleanup belongs to its old token.
        current.editor_session_id = editor_session_id;
        return Ok(());
    }
    if codex::scope_active(scope) { return Err(AppError::Other("视频任务仍在运行，请完成后再打开 Studio".into())); }
    let latest: Value = serde_json::from_slice(&std::fs::read(video::project_root(&root, scope)?.join("latest.json"))?)?;
    if latest["requestId"] != request_id { return Err(AppError::Other("请从本卡片的最新视频工程继续编辑".into())); }
    let (sender, mut cancel) = watch::channel(false);
    *OPENING.lock().map_err(|_| AppError::Other("视频编辑器状态无效，请重启后重试".into()))? = Some((editor_session_id.clone(), sender));
    let _opening = Opening(editor_session_id.clone());
    let prepared = video::prepare(&root, scope, &mut cancel).await?;
    let mut server = launch(&root, prepared, &cancel).await?;
    let result = (|| {
        let origin: tauri::Url = server.url.parse().map_err(|_| AppError::Other("视频编辑地址无效".into()))?;
        let allowed = origin.origin();
        let downloads = allowed.clone();
        let data = app.path().app_data_dir().map_err(|error| AppError::Other(error.to_string()))?.join("video-studio-browser");
        let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(origin))
            .data_directory(data).disable_drag_drop_handler()
            .on_navigation(move |url| url.origin() == allowed)
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(move |_, event| match event {
                tauri::webview::DownloadEvent::Requested { url, .. } => url.origin() == downloads,
                _ => true,
            });
        let main = app.get_window("main").ok_or_else(|| AppError::Other("找不到应用主窗口".into()))?;
        let webview = main.add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width, bounds.height))
            .map_err(|error| AppError::Other(format!("打开视频编辑面板失败：{error}")))?;
        webview.set_focus().map_err(|error| AppError::Other(error.to_string()))?;
        Ok::<_, AppError>(())
    })();
    if let Err(error) = result {
        if let Some(view) = app.get_webview(LABEL) { let _ = view.close(); }
        video::stop_child(&mut server.child).await; return Err(error);
    }
    *session = Some(Session { id: request_id, editor_session_id, scope: scope.into(), server });
    Ok(())
}

#[tauri::command]
pub async fn agent_video_studio_resize(app: tauri::AppHandle, request_id: String, editor_session_id: String, bounds: StudioBounds, visible: bool) -> Result<(), AppError> {
    let bounds = validate(bounds)?;
    let session = SESSION.lock().await;
    if !session.as_ref().is_some_and(|session| session.id == request_id && session.editor_session_id == editor_session_id) { return Ok(()); }
    if let Some(view) = app.get_webview(LABEL) {
        view.set_position(LogicalPosition::new(bounds.x, bounds.y)).map_err(|error| AppError::Other(error.to_string()))?;
        view.set_size(LogicalSize::new(bounds.width, bounds.height)).map_err(|error| AppError::Other(error.to_string()))?;
        (if visible { view.show() } else { view.hide() }).map_err(|error| AppError::Other(error.to_string()))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_video_studio_close(app: tauri::AppHandle, request_id: String, editor_session_id: String) -> Result<(), AppError> {
    cancel_opening(Some(&editor_session_id));
    let mut session = SESSION.lock().await;
    if !session.as_ref().is_some_and(|session| session.id == request_id && session.editor_session_id == editor_session_id) { return Ok(()); }
    if let Some(view) = app.get_webview(LABEL) { view.close().map_err(|error| AppError::Other(error.to_string()))?; }
    if let Some(mut current) = session.take() { video::stop_child(&mut current.server.child).await; }
    Ok(())
}

pub(crate) async fn shutdown() {
    cancel_opening(None);
    if let Some(mut session) = SESSION.lock().await.take() { video::stop_child(&mut session.server.child).await; }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn studio_bounds_reject_invalid_geometry() {
        let bounds = StudioBounds { x: 20.0, y: 60.0, width: 1200.0, height: 700.0 };
        assert!(validate(bounds).is_ok());
        assert!(validate(StudioBounds { x: f64::NAN, ..bounds }).is_err());
        assert!(validate(StudioBounds { height: 0.0, ..bounds }).is_err());
    }
}
