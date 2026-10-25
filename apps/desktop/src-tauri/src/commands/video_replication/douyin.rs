use super::*;
use std::time::Duration;
use tauri::{
    webview::{DownloadEvent, NewWindowResponse},
    Url, WebviewUrl, WebviewWindowBuilder,
};
#[path = "douyin_media.rs"]
mod media;
use media::{domain, download, media_url, secure};
#[path = "douyin_browser.rs"]
mod browser;

const WINDOW: &str = "replication-douyin";
const PAGE_HOSTS: &[&str] = &[
    "douyin.com",
    "www.douyin.com",
    "v.douyin.com",
    "iesdouyin.com",
    "www.iesdouyin.com",
];
static RUNNING: Mutex<Option<(String, tokio::task::AbortHandle)>> = Mutex::new(None);
fn page_allowed(url: &Url) -> bool {
    secure(url)
        && domain(
            url.host_str().unwrap_or(""),
            &["douyin.com", "iesdouyin.com"],
        )
}
fn video_id(url: &Url) -> Option<String> {
    if !PAGE_HOSTS.contains(&url.host_str()?) {
        return None;
    }
    let path = url.path().trim_end_matches('/');
    let id = path
        .strip_prefix("/video/")
        .or_else(|| path.strip_prefix("/share/video/"));
    let query = url
        .query_pairs()
        .find(|(key, _)| key == "modal_id")
        .map(|(_, value)| value.into_owned());
    let id = id.or_else(|| {
        if path.is_empty() {
            query.as_deref()
        } else {
            None
        }
    })?;
    ((12..=24).contains(&id.len()) && id.bytes().all(|c| c.is_ascii_digit())).then(|| id.to_owned())
}
fn share_url(text: &str) -> AppResult<Url> {
    if text.trim().is_empty() || text.chars().count() > 8000 {
        return Err(error("请粘贴抖音分享文案，最多 8000 字"));
    }
    let mut urls = Vec::new();
    for token in text.split(|c: char| c.is_whitespace() || "<>[]（）()\"'“”‘’".contains(c))
    {
        let Some(start) = token.find("https://") else {
            continue;
        };
        let raw = token[start..].trim_end_matches(|c: char| ".,，。！!；;：:、?？".contains(c));
        let Ok(url) = Url::parse(raw) else { continue };
        if !secure(&url) || !PAGE_HOSTS.contains(&url.host_str().unwrap_or("")) {
            continue;
        }
        let canonical = if let Some(id) = video_id(&url) {
            format!("https://www.douyin.com/video/{id}")
        } else if url.host_str() == Some("v.douyin.com")
            && (3..=100).contains(&url.path().trim_matches('/').len())
            && url
                .path()
                .trim_matches('/')
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        {
            format!("https://v.douyin.com/{}/", url.path().trim_matches('/'))
        } else {
            continue;
        };
        if !urls.contains(&canonical) {
            urls.push(canonical);
        }
    }
    if urls.len() != 1 {
        return Err(error(
            "请提供一个抖音视频链接，支持完整分享文案、分享短链或作品链接",
        ));
    }
    Url::parse(&urls[0]).map_err(|_| error("分享链接无效"))
}
fn selected(value: Value, expected: &str) -> AppResult<Value> {
    if field(&value, "videoId") != expected {
        return Err(error("未取得目标作品的视频"));
    }
    match field(&value, "blocked") {
        "image" => return Err(error("此链接为图文作品，请选择视频")),
        "protected" => return Err(error("此视频受播放保护，无法获取")),
        _ => (),
    }
    if value["duration"]
        .as_f64()
        .is_some_and(|v| !v.is_finite() || v > 120.0)
    {
        return Err(error("参考视频最多 120 秒，请截取后上传"));
    }
    let urls = value["urls"]
        .as_array()
        .ok_or_else(|| error("未取得播放地址"))?;
    if urls.is_empty()
        || urls.len() > 6
        || urls
            .iter()
            .all(|u| media_url(u.as_str().unwrap_or("")).is_err())
    {
        return Err(error("未取得可用的抖音播放地址"));
    }
    Ok(value)
}

async fn acquire(
    app: &tauri::AppHandle,
    root: &Path,
    task: &Value,
    interactive: bool,
) -> AppResult<Option<Value>> {
    let id = field(task, "id");
    let source = share_url(field(task, "shareText"))?;
    let expected = Arc::new(Mutex::new(video_id(&source)));
    let expected_nav = expected.clone();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Option<Value>>(4);
    let close_tx = tx.clone();
    let script = include_str!("douyin_capture.js").replace(
        "__EXPECTED_ID__",
        &serde_json::to_string(&video_id(&source))?,
    );
    let profile = app
        .path()
        .app_data_dir()
        .map_err(|_| error("无法读取浏览器资料目录"))?
        .join("replication-douyin-browser");
    let builder = WebviewWindowBuilder::new(
        app,
        WINDOW,
        WebviewUrl::External(Url::parse("about:blank").unwrap()),
    )
    .title("Bowerbird · 抖音视频获取")
    .inner_size(1100.0, 800.0)
    .visible(interactive)
    .focused(interactive)
    .data_directory(profile)
    .initialization_script(include_str!("douyin_quiet.js"))
    .initialization_script(&script)
    .on_navigation(move |url| {
        if url.as_str() == "about:blank" {
            return true;
        }
        if url.scheme() == "bb-replication-capture" {
            if url.as_str().len() < 80000 {
                if let Some((_, text)) = url.query_pairs().find(|(key, _)| key == "payload") {
                    if let Ok(value) = serde_json::from_str::<Value>(&text) {
                        if expected_nav.lock().unwrap().as_deref() == Some(field(&value, "videoId"))
                        {
                            let _ = tx.try_send(Some(value));
                        }
                    }
                }
            }
            return false;
        }
        if !page_allowed(url) {
            return false;
        }
        let mut wanted = expected_nav.lock().unwrap();
        if wanted.is_none() {
            *wanted = video_id(url);
        }
        true
    })
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .on_download(|_, event| !matches!(event, DownloadEvent::Requested { .. }));
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(*b"bb-douyin-import");
    let window = builder
        .build()
        .map_err(|_| error("无法打开抖音获取窗口，请关闭旧窗口后重试"))?;
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = close_tx.try_send(None);
        }
    });
    let mut responses = browser::observe(&window).await?;
    window
        .navigate(source)
        .map_err(|_| error("无法打开抖音页面"))?;
    patch(
        root,
        id,
        json!({"state":"waiting","message":if interactive {"正在读取抖音页面，如出现验证请在窗口内完成"} else {"正在后台获取目标视频"}}),
    )?;
    let captured = tokio::time::timeout(
        Duration::from_secs(if interactive { 600 } else { 45 }),
        async {
            loop {
                tokio::select! {
                    value = rx.recv() => return value,
                    _ = tokio::time::sleep(Duration::from_millis(750)) => {
                        if let Ok(Some(value)) = browser::captured(&window, &mut responses).await {
                            if expected.lock().unwrap().as_deref() == Some(field(&value, "videoId")) {
                                return Some(Some(value));
                            }
                        }
                    }
                }
            }
        },
    )
    .await;
    let value = match captured {
        Ok(Some(Some(value))) => value,
        Ok(_) => return Err(error("获取窗口已关闭，请重试")),
        Err(_) => return Ok(None),
    };
    let expected = expected
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| error("无法确认目标作品编号"))?;
    let value = selected(value, &expected)?;
    let canonical = format!("https://www.douyin.com/video/{expected}");
    patch(
        root,
        id,
        json!({"state":"downloading","message":"正在下载并校验视频","originalUrl":canonical,"videoId":expected}),
    )?;
    let temporary = folder(root, id)?.join("download.mp4");
    let mut last = error("未取得可用视频");
    for candidate in value["urls"].as_array().unwrap() {
        let attempt = tokio::time::timeout(
            Duration::from_secs(120),
            download(
                &window,
                candidate.as_str().unwrap(),
                &temporary,
                &canonical,
                field(&value, "userAgent"),
            ),
        )
        .await;
        match attempt {
            Ok(Ok(())) => {
                let r = root.to_path_buf();
                let p = field(task, "projectId").to_owned();
                let file = temporary.clone();
                let imported =
                    tokio::task::spawn_blocking(move || import_reference(&r, &p, file, None))
                        .await
                        .map_err(|_| error("校验下载视频失败"))?;
                match imported {
                    Ok(reference) => {
                        let mut reference = patch(
                            root,
                            field(&reference, "id"),
                            json!({"name":format!("{}.mp4",field(&value,"name").chars().take(160).collect::<String>()),"origin":"douyin","sourceUrl":task["sourceUrl"],"originalUrl":canonical,"shareText":task["shareText"],"videoId":expected}),
                        )?;
                        reference = public(reference);
                        let _ = fs::remove_file(&temporary);
                        return Ok(Some(reference));
                    }
                    Err(e) => last = e,
                }
            }
            Ok(Err(e)) => last = e,
            Err(_) => last = error("视频下载超时，请重试"),
        }
        let _ = fs::remove_file(&temporary);
    }
    Err(last)
}

fn launch(app: &tauri::AppHandle, root: &Path, task: Value, interactive: bool) -> AppResult<Value> {
    let mut running = RUNNING.lock().unwrap();
    if running
        .as_ref()
        .is_some_and(|(_, handle)| !handle.is_finished())
    {
        return Err(error("已有抖音获取任务，请先完成或取消"));
    }
    if task["state"] == "ready" {
        return Ok(task);
    }
    let id = field(&task, "id").to_owned();
    let state = patch(
        root,
        &id,
        json!({"state":"starting","message":"正在打开抖音页面","startedAt":now()}),
    )?;
    let app = app.clone();
    let root = root.to_path_buf();
    let run_id = id.clone();
    let work = tauri::async_runtime::spawn(async move {
        let result = acquire(&app, &root, &task, interactive).await;
        if let Some(window) = app.get_webview_window(WINDOW) {
            let _ = window.close();
        }
        let fields = match result {
            Ok(Some(reference)) => {
                json!({"state":"ready","message":"参考视频已获取","reference":reference,"finishedAt":now()})
            }
            Ok(None) => {
                json!({"state":"needs_login","message":"后台未读取到视频，可打开抖音窗口继续获取；如页面要求，再完成登录或验证"})
            }
            Err(e) => json!({"state":"failed","message":e.to_string()}),
        };
        let _ = patch(&root, &run_id, fields);
        if let Ok(dir) = folder(&root, &run_id) {
            let _ = fs::remove_file(dir.join("download.mp4"));
        }
    });
    *running = Some((id, work.inner().abort_handle()));
    Ok(state)
}
pub(super) async fn handle(
    app: &tauri::AppHandle,
    root: &Path,
    project: &str,
    action: &str,
    data: Value,
) -> AppResult<Value> {
    if action == "douyin-list" {
        let mut items = Vec::new();
        for entry in fs::read_dir(root)? {
            let entry = entry?;
            if let Some(id) = entry.file_name().to_str() {
                if let Ok(mut value) = own(root, id, project) {
                    if value["kind"] == "douyin" && (field(&data,"caseId").is_empty() || value["caseId"] == data["caseId"]) {
                        if ["starting", "waiting", "downloading"].contains(&field(&value, "state"))
                            && !RUNNING
                                .lock()
                                .unwrap()
                                .as_ref()
                                .is_some_and(|(running, handle)| {
                                    running == id && !handle.is_finished()
                                })
                        {
                            value["state"] = json!("interrupted");
                            value["message"] = json!("获取已中断，可重新获取");
                        }
                        items.push(value);
                    }
                }
            }
        }
        items.sort_by(|a, b| field(b, "createdAt").cmp(field(a, "createdAt")));
        return Ok(json!(items));
    }
    if action == "douyin-create" {
        if let Some(id) = data["caseId"].as_str() {
            let parent = super::cases::require(root,id,project)?;
            if !field(&parent,"referenceId").is_empty() { return Err(error("此任务已有参考视频，请新建任务")); }
        }
        let source = share_url(field(&data, "text"))?;
        let id = uuid::Uuid::new_v4().simple().to_string();
        let task = json!({"id":id,"kind":"douyin","projectId":project,"caseId":data["caseId"],"sourceUrl":source.as_str(),"shareText":data["text"],"state":"starting","createdAt":now()});
        save(root, &task)?;
        return launch(app, root, task, false);
    }
    let task = own(root, field(&data, "id"), project)?;
    if task["kind"] != "douyin" {
        return Err(error("不是抖音获取记录"));
    }
    if action == "douyin-cancel" {
        let id = field(&task, "id");
        let running = RUNNING.lock().unwrap();
        if running.as_ref().is_some_and(|(active, _)| active == id) {
            if let Some((_, handle)) = running.as_ref() {
                handle.abort();
            }
            if let Some(window) = app.get_webview_window(WINDOW) {
                let _ = window.close();
            }
        }
        let latest = own(root, id, project)?;
        if latest["state"] == "ready" {
            return Ok(latest);
        }
        return patch(
            root,
            id,
            json!({"state":"cancelled","message":"已取消视频获取"}),
        );
    }
    if action == "douyin-login" || action == "douyin-retry" {
        return launch(app, root, task, action == "douyin-login");
    }
    Err(error("未知抖音获取操作"))
}

#[cfg(test)]
mod tests {
    use super::media::public_ip;
    use super::*;
    #[test]
    fn shares_are_single_https_target_videos() {
        assert_eq!(
            share_url("分享文案 https://v.douyin.com/abc_12/ 复制打开")
                .unwrap()
                .as_str(),
            "https://v.douyin.com/abc_12/"
        );
        assert_eq!(
            share_url("https://www.douyin.com/?modal_id=1234567890123456")
                .unwrap()
                .as_str(),
            "https://www.douyin.com/video/1234567890123456"
        );
        for text in [
            "http://v.douyin.com/abc/",
            "https://v.douyin.com.evil.test/abc/",
            "https://u:p@v.douyin.com/abc/",
            "https://v.douyin.com:444/abc/",
            "https://v.douyin.com/abc/ https://v.douyin.com/def/",
            "https://www.douyin.com/user/abc",
        ] {
            assert!(share_url(text).is_err(), "{text}");
        }
    }
    #[test]
    fn download_destinations_and_target_identity_are_bounded() {
        for url in [
            "http://v1.douyinvod.com/a",
            "https://douyinvod.com.evil.test/a",
            "https://127.0.0.1/a",
            "https://v1.douyinvod.com:444/a",
        ] {
            assert!(media_url(url).is_err());
        }
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.1.1",
            "100.64.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "2001:db8::1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()));
        }
        let good = json!({"videoId":"1234567890123456","duration":5,"urls":["https://v1.douyinvod.com/video"]});
        assert!(selected(good.clone(), "1234567890123456").is_ok());
        let mixed = json!({"videoId":"1234567890123456","duration":5,"urls":["https://unsupported.example/video","https://v1.douyinvod.com/video"]});
        assert!(selected(mixed, "1234567890123456").is_ok());
        assert!(selected(good.clone(), "9999999999999999").is_err());
        for patch in [
            json!({"blocked":"image"}),
            json!({"blocked":"protected"}),
            json!({"duration":121}),
        ] {
            let mut value = good.clone();
            for (k, v) in patch.as_object().unwrap() {
                value[k] = v.clone();
            }
            assert!(selected(value, "1234567890123456").is_err());
        }
    }
}
