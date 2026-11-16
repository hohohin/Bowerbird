use super::types::{Capabilities, Chunk, CodexRequest, CodexResult, GenOutcome};
use super::GenProvider;
use crate::error::{AppError, AppResult};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse},
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tokio::sync::mpsc;

pub fn model(key: Option<&str>) -> Option<(&'static str, &'static str)> {
    Some(match key? {
        "dreamina-web55" => ("dreamina-web55", "Seedream 5.5"),
        "dreamina-web50pro" => ("dreamina-web50pro", "Seedream 5.0 Pro"),
        "dreamina-web50flash" => ("dreamina-web50flash", "Seedream 5.0 Flash"),
        "dreamina-web50lite" => ("dreamina-web50lite", "Seedream 5.0 Lite"),
        "dreamina-web47" => ("dreamina-web47", "Seedream 4.7"),
        "dreamina-web40" => ("dreamina-web40", "Seedream 4.0"),
        _ => return None,
    })
}
const ORIGIN: &str = "https://jimeng.jianying.com";
const PAGE: &str = "https://jimeng.jianying.com/ai-tool/generate?type=image";
// The web history has no caller-supplied job ID. Serialize local web submissions
// so two identical prompts cannot claim each other's arriving result.
static WEB_JOB: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
pub struct Provider {
    pub app: AppHandle,
    pub key: &'static str,
    pub model: &'static str,
}
struct Window(WebviewWindow);
impl Drop for Window {
    fn drop(&mut self) {
        let _ = self.0.destroy();
    }
}
fn err(message: &str) -> AppError {
    AppError::Other(message.to_owned())
}

async fn read(window: &WebviewWindow, script: &str) -> AppResult<String> {
    let (tx, mut rx) = mpsc::channel(1);
    window
        .eval_with_callback(script, move |value| {
            let _ = tx.try_send(value);
        })
        .map_err(|_| err("即梦网页窗口已关闭"))?;
    let value = tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .ok()
        .flatten()
        .ok_or_else(|| err("即梦网页未响应，请查看即梦创作记录后再试"))?;
    Ok(serde_json::from_str::<String>(&value).unwrap_or_default())
}

fn references(req: &CodexRequest) -> AppResult<Vec<Value>> {
    let mut files = Vec::new();
    let mut total = 0;
    if req.reference_images.len() > 10 {
        return Err(err("即梦网页最多支持 10 张参考图"));
    }
    for (index, path) in req.reference_images.iter().enumerate() {
        total += std::fs::metadata(path)?.len();
        if total > 50 * 1024 * 1024 {
            return Err(err("即梦网页参考图总大小超过 50 MiB"));
        }
        let bytes = std::fs::read(path)?;
        let format = image::guess_format(&bytes)?;
        if !matches!(
            format,
            image::ImageFormat::Jpeg | image::ImageFormat::Png | image::ImageFormat::WebP
        ) {
            return Err(err("请使用 PNG、JPEG 或 WebP 参考图"));
        }
        files.push(json!({"name":format!("ref-{}.{}", index+1,format.extensions_str()[0]),"mime":format.to_mime_type(),"data":STANDARD.encode(bytes)}));
    }
    Ok(files)
}

#[async_trait]
impl GenProvider for Provider {
    fn name(&self) -> &str {
        self.key
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            chat: false,
            caption: false,
            generate: true,
        }
    }
    async fn run(&self, _: CodexRequest) -> AppResult<CodexResult> {
        Err(err("即梦网页版仅支持图片生成"))
    }
    async fn generate_image(
        &self,
        req: CodexRequest,
        progress: &mpsc::Sender<Chunk>,
        _: Option<String>,
    ) -> AppResult<GenOutcome> {
        let _slot = WEB_JOB.lock().await;
        let started = Instant::now();
        let files = references(&req)?;
        let payload =
            json!({"model":self.model,"prompt":req.instruction,"ratio":req.ratio,"files":files});
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("original.png");
        let destination = path.clone();
        let armed = Arc::new(AtomicBool::new(false));
        let download_armed = armed.clone();
        let (tx, mut rx) = mpsc::channel(1);
        let label = format!("dreamina-web-{}", ulid::Ulid::new());
        let profile = self
            .app
            .path()
            .app_data_dir()
            .map_err(|_| err("无法访问内置浏览器资料"))?
            .join("source-browser");
        let window = WebviewWindowBuilder::new(
            &self.app,
            &label,
            WebviewUrl::External(PAGE.parse().unwrap()),
        )
        .title("Bowerbird · 即梦登录")
        .inner_size(1100., 800.)
        .visible(false)
        .focused(false)
        .data_directory(profile)
        .on_navigation(|url| url.origin().ascii_serialization() == ORIGIN)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(move |_, event| match event {
            DownloadEvent::Requested {
                destination: target,
                url,
                ..
            } => {
                if !matches!(url.scheme(), "https" | "blob")
                    || !download_armed.swap(false, Ordering::SeqCst)
                {
                    return false;
                }
                *target = destination.clone();
                true
            }
            DownloadEvent::Finished { success, .. } => {
                let _ = tx.try_send(success);
                true
            }
            _ => false,
        })
        .build()
        .map_err(|_| err("无法创建即梦内置浏览器窗口"))?;
        let window = Window(window);
        let mut login_shown = false;
        loop {
            let status = read(&window.0, r#"location.origin !== 'https://jimeng.jianying.com' ? '' :
                [...document.querySelectorAll('button,[role=button]')].some(e=>e.getClientRects().length && /^(登录|登录，开启创作)$/.test(e.innerText.trim())) ? 'login' :
                document.querySelector('[contenteditable=true][aria-label="提示词"]') ? 'ready' : ''"#).await?;
            if status == "login" && !login_shown {
                window.0.show().map_err(|_| err("无法显示即梦登录窗口"))?;
                let _ = window.0.set_focus();
                login_shown = true;
            }
            if status == "ready" {
                break;
            }
            if started.elapsed() > Duration::from_secs(if login_shown { 300 } else { 45 }) {
                return Err(err("即梦图片页尚未就绪，请检查网页登录状态"));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let _ = window.0.hide();
        let source = include_str!("jimeng_web.js");
        let find_result = include_str!("jimeng_web_result.js");
        window.0.eval(format!(r#"if(location.origin==='{ORIGIN}' && location.pathname==='/ai-tool/generate' && !window.__bbJimeng) {{
            {find_result}
            const state=window.__bbJimeng={{phase:'preparing'}};
            ({source})({payload},state).catch(e=>state.phase=state.phase==='submitted'?'error:result':'error:'+e.message);
        }}"#)).map_err(|_|err("即梦网页未能接收生成参数"))?;
        let submitted = Instant::now();
        let mut reported_submission = false;
        loop {
            let phase = read(&window.0, "window.__bbJimeng?.phase || ''").await?;
            match phase.as_str() {
                "submitted" if !reported_submission => {
                    reported_submission = true;
                    super::progress::send(
                        Some(progress),
                        super::progress::GenerationProgress::new(
                            super::progress::GenerationStage::Processing,
                        ),
                    )
                    .await;
                }
                "preparing" | "submitted" => {}
                "download" => break,
                "error:upload" => return Err(err("即梦网页未确认全部参考图，已停止提交")),
                "error:existing-refs" => return Err(err("即梦编辑区已有其他参考图，本次未提交")),
                "error:ref-count" => return Err(err("即梦收到的参考图张数与所选张数不一致，本次未提交")),
                "error:prompt" => return Err(err("即梦编辑区中的提示词与本次输入不一致，本次未提交")),
                "error:model" => return Err(err("即梦页面未选中指定模型，本次未提交")),
                "error:size" => return Err(err("即梦页面未确认所选比例和 2K 分辨率，本次未提交")),
                "error:count" => return Err(err("即梦页面未确认单张生成，本次未提交")),
                "error:editor" => return Err(err("即梦图片编辑区尚未就绪，本次未提交")),
                "error:submit" => return Err(err("即梦生成按钮尚不可用，本次未提交")),
                "error:result" | "" => {
                    return Err(err("未能确认本次原图，请在即梦创作记录查看；请勿重复提交"))
                }
                _ => return Err(err("即梦网页控件未能确认生成参数，本次未发起生成")),
            }
            if submitted.elapsed() > Duration::from_secs(720) {
                return Err(err("即梦网页等待超时，请在即梦创作记录查看本次结果"));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        armed.store(true, Ordering::SeqCst);
        window
            .0
            .eval("window.__bbJimeng?.download()")
            .map_err(|_| err("即梦原图下载未启动"))?;
        if tokio::time::timeout(Duration::from_secs(90), rx.recv())
            .await
            .ok()
            .flatten()
            != Some(true)
        {
            return Err(err("即梦任务已提交，原图下载未完成，请查看即梦创作记录"));
        }
        if std::fs::metadata(&path)?.len() > 50 * 1024 * 1024 {
            return Err(err("即梦返回图片超过 50 MiB"));
        }
        let reader = image::ImageReader::open(&path)?.with_guessed_format()?;
        let format = reader.format().ok_or_else(|| err("即梦下载结果不是图片"))?;
        let _ = reader.decode()?;
        let file = path.with_extension(format.extensions_str()[0]);
        if path != file {
            std::fs::rename(&path, &file)?;
        }
        Ok(GenOutcome {
            text: String::new(),
            session_id: Some(label),
            submit_id: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
            source_images: vec![file],
            temp_dir: Some(directory.keep()),
        })
    }
}
