//! 反推 / 生成 / 安装登录 / 会话回看命令。
//!
//! 理解类（反推 / 命名 / 归类）经 understand provider 抽象按权益路由（codex CLI 或
//! Bowerbird Cloud）；生成经 gen provider 抽象可选 codex / 即梦 / Cloud。命令名仍叫
//! `codex_*` 是历史保留（见 AI-PROVIDERS.md 开放问题 1），语义已泛化。
//! 流式：通过 event `codex://chunk` 推 Chunk（Delta / Done / Error / Submit 等）。

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use ulid::Ulid;

use crate::cloud::EntitlementService;
use crate::codex::codex_cli::{codex_command, codex_home, resolve_codex_binary};
use crate::codex::resolve_gen_provider;
use crate::codex::types::{Chunk, CodexRequest, CodexResult};
use crate::codex::understand::{
    resolve_entitled_understand_provider, resolve_understand_provider_with_choice, UnderstandOperation,
};
use crate::core::caption;
use crate::core::library::{GenerationHistoryTurn, PromptedAsset};
use crate::core::paths::LibraryPaths;
use crate::core::settings::SettingsState;
use crate::db::Database;
use crate::error::AppError;

const DEFAULT_DESCRIBE_INSTRUCTION: &str = "请描述这张图片";

async fn require_byo(
    entitlement: &EntitlementService,
    auth: &crate::cloud::AuthClient,
) -> Result<(), AppError> {
    let snapshot = entitlement.current_or_sync(auth).await;
    if snapshot.policy.can_use_byo {
        Ok(())
    } else {
        Err(AppError::Other("升级 Pro 解锁本机 Codex / 即梦 CLI".into()))
    }
}

/// codex 可用性检测结果。`ok=false` 时 `reason` 给出置灰提示文案。
#[derive(Debug, Clone, Serialize)]
pub struct CodexHealth {
    pub ok: bool,
    pub reason: String,
}

/// 检测 codex CLI 是否就绪（Pro/Studio 本机理解/生成引擎之一）：① CLI 可执行；② CODEX_HOME（或用户目录）内 auth.json 非空。
/// 任一不满足返回 `ok=false` + 中文 reason。注意：免费档反推/生成走 Bowerbird Cloud，**不依赖此检测结果**——
/// 前端「环境就绪」应按权益路由判断（见 `lib/entitlement.ts` understandReady），而非直判 codexHealth。
/// 跨平台：binary 经 `resolve_codex_binary`（Windows 找 codex.cmd、补 %APPDATA%\npm）、
/// home 经 `codex_home`（CODEX_HOME → USERPROFILE/HOME），不再死读 `$HOME`。
#[tauri::command]
pub async fn codex_health() -> Result<CodexHealth, AppError> {
    let binary = resolve_codex_binary();
    let binary_ok = if let Some(binary) = binary.as_deref() {
        codex_command(binary)
            .arg("--version")
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false)
    } else {
        false
    };
    if !binary_ok {
        return Ok(CodexHealth {
            ok: false,
            reason: "未检测到 codex CLI（点「一键安装」自动下载独立版，无需 Node.js）".into(),
        });
    }
    let logged_in = codex_home()
        .map(|h| {
            let p = h.join("auth.json");
            std::fs::metadata(&p).map(|m| m.len() > 0).unwrap_or(false)
        })
        .unwrap_or(false);
    if !logged_in {
        return Ok(CodexHealth {
            ok: false,
            reason: "codex 未登录（需运行 codex login）".into(),
        });
    }
    Ok(CodexHealth {
        ok: true,
        reason: String::new(),
    })
}

/// 当前安装/登录引导的取消信号（与反推 `DESCRIBE_CANCEL` / 生成 `GENERATE_CANCEL` 独立；
/// onboarding 顺序执行，不会并发）。
static SETUP_CANCEL: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>> =
    std::sync::Mutex::new(None);

/// 一键安装 codex CLI（`codex exec` 主线零改动，仅替代用户手敲 `npm install -g`）：
/// 主体在 [`crate::codex::install`]——优先从 npm registry 直装官方独立二进制
/// （npmmirror → npmjs，sha512 校验，**无需 Node.js**；进度经 `codex://setup-progress`
/// 推前端，含 percent 进度）；直装失败且本机有 npm 时回退 `npm install -g`。
/// 可取消（`SETUP_CANCEL`）。成功 emit `codex://health-changed` 让各处自刷新。
#[tauri::command]
pub async fn codex_install(app: AppHandle) -> Result<CodexHealth, AppError> {
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    SETUP_CANCEL.lock().unwrap().replace(cancel_tx);
    let result = crate::codex::install::install_codex(&app, &mut cancel_rx).await;
    SETUP_CANCEL.lock().unwrap().take();
    match result {
        Ok(()) => {
            let _ = app.emit("codex://health-changed", ());
            Ok(CodexHealth { ok: true, reason: String::new() })
        }
        // 取消以错误抛出（前端 catch「已取消」回 idle 可重试，不显示为红色失败）。
        Err(AppError::Codex(reason)) if reason == "已取消" => Err(AppError::Codex(reason)),
        Err(AppError::Codex(reason)) => Ok(CodexHealth { ok: false, reason }),
        Err(e) => Ok(CodexHealth { ok: false, reason: e.to_string() }),
    }
}

/// 一键 OAuth 登录：spawn `codex login`（codex 自己开系统浏览器走 ChatGPT 授权），
/// 等其退出后复查 `~/.codex/auth.json`。可取消（300s 超时 + `kill_on_drop`）。
/// 成功 emit `codex://health-changed` 让各处自刷新。
#[tauri::command]
pub async fn codex_login(app: AppHandle) -> Result<CodexHealth, AppError> {
    let binary = resolve_codex_binary()
        .ok_or_else(|| AppError::Codex("未检测到 codex CLI，请先点「安装 codex CLI」".into()))?;
    let mut cmd = codex_command(&binary);
    cmd.arg("login");
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Codex(format!("启动 codex login 失败: {e}")))?;

    // codex login 会自己打开浏览器；提示用户去浏览器完成授权。
    let _ = app.emit(
        "codex://setup-progress",
        serde_json::json!({ "stage": "login", "line": "请在打开的浏览器中登录 ChatGPT…" }),
    );

    // 排空 stdout/stderr（device code / 提示可能打到 stdout），供失败诊断。
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let drain = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        if let Some(mut s) = stdout {
            let _ = s.read_to_end(&mut buf).await;
        }
        if let Some(mut s) = stderr {
            let _ = s.read_to_end(&mut buf).await;
        }
        String::from_utf8_lossy(&buf).to_string()
    });

    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    SETUP_CANCEL.lock().unwrap().replace(cancel_tx);

    let status = tokio::select! {
        r = tokio::time::timeout(Duration::from_secs(300), child.wait()) => match r {
            Ok(s) => s.map_err(|e| AppError::Codex(format!("等待 codex login 失败: {e}")))?,
            Err(_) => return Err(AppError::Codex("codex login 超时（300s），请重试".into())),
        },
        _ = &mut cancel_rx => return Err(AppError::Codex("已取消".into())),
    };
    SETUP_CANCEL.lock().unwrap().take();
    let drain_str = drain.await.unwrap_or_default();

    if !status.success() {
        let head: String = drain_str.trim().chars().take(500).collect();
        return Ok(CodexHealth {
            ok: false,
            reason: format!("codex login 退出 {} | {head}", status),
        });
    }
    // 复查 auth.json（复用 codex_health 的登录态判定）。
    let logged_in = codex_home()
        .map(|h| {
            let p = h.join("auth.json");
            std::fs::metadata(&p).map(|m| m.len() > 0).unwrap_or(false)
        })
        .unwrap_or(false);
    if !logged_in {
        return Ok(CodexHealth {
            ok: false,
            reason: "codex login 已结束但未检测到登录态；可重试，或手动在终端跑一次 codex login"
                .into(),
        });
    }
    let _ = app.emit("codex://health-changed", ());
    Ok(CodexHealth {
        ok: true,
        reason: String::new(),
    })
}

/// 取消正在进行的安装 / 登录（`codex_install` / `codex_login`）。无任务在跑则空操作。
#[tauri::command]
pub async fn cancel_codex_setup() -> Result<(), AppError> {
    if let Some(tx) = SETUP_CANCEL.lock().unwrap().take() {
        let _ = tx.send(());
    }
    Ok(())
}

/// 为单个资产生成提示词并写回 asset_prompts（批量由前端循环）。
#[tauri::command]
pub async fn codex_generate_prompt_for_asset(
    db: State<'_, Arc<Database>>,
    cloud_client: State<'_, crate::cloud::CloudClient>,
    auth_client: State<'_, crate::cloud::AuthClient>,
    entitlement: State<'_, EntitlementService>,
    asset_id: String,
    role: String,
) -> Result<String, AppError> {
    let store_path = get_asset_store_path(&db, &asset_id).await?;

    let req = CodexRequest {
        instruction: "为这张图片生成一段适合 AI 绘画的提示词（描述主体、风格、构图、光影）".into(),
        reference_images: vec![PathBuf::from(store_path)],
        context_prompts: vec![],
        ratio: None,
        job_id: None,
    };
    let p = resolve_entitled_understand_provider(
        &entitlement,
        cloud_client.inner().clone(),
        auth_client.inner().clone(),
        true,
    )
    .await?;
    let provider_name = p.name().to_string();
    let result = p.understand(UnderstandOperation::Autoname, req).await?;

    let prompt_id = Ulid::new().to_string();
    let db_for_write = db.inner().clone();
    let (pid, aid, role_for_write) = (prompt_id.clone(), asset_id.clone(), role.clone());
    let (text, pname) = (result.text, provider_name);
    tokio::task::spawn_blocking(move || {
        db_for_write.create_prompt(&pid, None, &text, Some("generated"), Some(&pname))?;
        db_for_write.link_prompt(&aid, &pid, &role_for_write)?;
        Ok::<_, AppError>(())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;

    Ok(prompt_id)
}

/// 当前反推任务的取消信号。同一时刻只支持一个反推任务（前端反推按钮 disabled 保证）；
/// 取消时往 sender 发信号，select 命中后 future 被 drop，本机 CLI 子进程靠
/// `kill_on_drop` 自动终止（见 codex_cli.rs）；Cloud 路由无子进程，drop future 即止。
static DESCRIBE_CANCEL: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>> =
    std::sync::Mutex::new(None);

/// 「反推」：让理解 provider 描述指定资产（按权益路由 codex CLI / Bowerbird Cloud），结果落 analyses(kind=caption)。
/// payload 同时存 session_id（codex 路由才有，Cloud 无），前端「在 codex 中打开」按钮据此唤起 `codex resume`。
/// 可取消：前端调 `cancel_codex_describe` 即中断本次执行（本机 CLI 子进程被 kill）。
#[tauri::command]
pub async fn codex_describe_asset(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    cloud_client: State<'_, crate::cloud::CloudClient>,
    auth_client: State<'_, crate::cloud::AuthClient>,
    entitlement: State<'_, EntitlementService>,
    asset_id: String,
    instruction: Option<String>,
    provider: Option<String>,
) -> Result<String, AppError> {
    let store_path = get_asset_store_path(&db, &asset_id).await?;
    let instruction = instruction
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_DESCRIBE_INSTRUCTION.to_string());

    let req = CodexRequest {
        instruction: instruction.clone(),
        reference_images: vec![PathBuf::from(store_path)],
        context_prompts: vec![],
        ratio: None,
        job_id: None,
    };
    let p = resolve_understand_provider_with_choice(
        &entitlement,
        cloud_client.inner().clone(),
        auth_client.inner().clone(),
        provider.as_deref(),
    )
    .await?;
    let provider_name = p.name().to_string();

    // 可取消：select codex 执行 与 取消信号。取消时 run future 被 drop，
    // codex 子进程靠 kill_on_drop 自动 kill。
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    DESCRIBE_CANCEL.lock().unwrap().replace(cancel_tx);
    let run_fut = p.understand(UnderstandOperation::Caption, req);
    tokio::pin!(run_fut);
    let result = tokio::select! {
        r = &mut run_fut => r,
        _ = &mut cancel_rx => {
            return Err(AppError::Codex("已取消".into()));
        }
    };
    DESCRIBE_CANCEL.lock().unwrap().take();
    let result = result?;
    let analysis_parsed = caption::parse(&result.text);
    let payload = caption::build_payload(
        &result.text,
        &instruction,
        result.session_id.as_deref(),
        &provider_name,
        &analysis_parsed,
    );

    let id = Ulid::new().to_string();
    let analysis = crate::core::library::Analysis {
        id: id.clone(),
        asset_id: asset_id.clone(),
        kind: "caption".to_string(),
        payload,
        provider: Some(provider_name),
        created_at: None,
    };
    let db_for_write = db.inner().clone();
    tokio::task::spawn_blocking(move || db_for_write.insert_analysis(&analysis))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    // 通知前端数据变更：触发反推后台化后，触发反推的组件可能早已卸载，
    // 由 App / AssetDetail 监听此事件按需刷新（创作板的 promptedAssets、详情页 analyses）。
    let _ = app.emit(
        "analyses://changed",
        serde_json::json!({ "asset_id": asset_id, "kind": "caption" }),
    );
    Ok(id)
}

/// 取消正在进行的反推（`codex_describe_asset`）。无任务在跑则空操作。
#[tauri::command]
pub async fn cancel_codex_describe() -> Result<(), AppError> {
    if let Some(tx) = DESCRIBE_CANCEL.lock().unwrap().take() {
        let _ = tx.send(());
    }
    Ok(())
}

/// 当前进行中的图像生成任务取消信号（per-job，key=job_id）。与反推 `DESCRIBE_CANCEL` 独立。
/// Phase A（视频 spec task 2）：单槽 `Option<Sender>` → `HashMap<job_id, Sender>`，
/// 支持多任务并行 + 各自独立取消。
static GENERATE_CANCEL: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// 无论 provider、下载还是入库在哪一步失败，都必须把持久化任务推进到终态；否则下一次
/// 生成会把这条幽灵 `running` 行计入账号并发上限。
fn settle_generation_task(db: &Database, job_id: &str, result: &Result<(), AppError>) {
    let settled = match result {
        Ok(()) => crate::core::task_queue::Task::mark_done(db, job_id),
        Err(AppError::Codex(message)) if message == "已取消" => {
            crate::core::task_queue::Task::mark_cancelled(db, job_id)
        }
        Err(error) => crate::core::task_queue::Task::mark_failed(db, job_id, &error.to_string()),
    };
    if let Err(error) = settled {
        tracing::warn!("gen: failed to settle task {job_id}: {error}");
    }
}

/// 创作板「生成」：把最终 prompt + 参考图交 provider 出图（`provider` 参数选实现，
/// None/`codex` → CodexCliProvider、`jimeng` → DreaminaCliProvider、
/// `bowerbird-cloud`/`-standard`/`-lite` → BowerbirdCloudProvider 三档变体）。
/// provider 产出的源图由 `finalize_generation_assets` 入库。
///
/// - 流式：经 event `codex://chunk` 回前端（codex=Delta 逐字、即梦/Cloud=状态/伪进度）；
/// - 不写 `analyses`（生成 ≠ 分析）；来源元信息落 `generation_meta`。
/// 即梦/Cloud 画面比例档位（与前端创作板 RATIOS 同一套，creation/ratios.ts）。
const GEN_RATIO_PRESETS: [(&str, u32, u32); 7] = [
    ("1:1", 1, 1),
    ("3:4", 3, 4),
    ("4:3", 4, 3),
    ("2:3", 2, 3),
    ("3:2", 3, 2),
    ("16:9", 16, 9),
    ("9:16", 9, 16),
];

/// generation_meta 的 provider 是否 codex 系（含历史 key "codex-cli" 与前端裸 "codex"/"default"）。
fn generation_provider_is_codex(provider: Option<&str>) -> bool {
    matches!(provider, Some("codex" | "codex-cli" | "default"))
}

/// 宽高比按**对数距离**吸附到最近档位（对数尺度衡量比例差异，1:0.9 与 0.9:1 对称）。
fn nearest_ratio_key(width: u32, height: u32) -> Option<String> {
    if width == 0 || height == 0 {
        return None;
    }
    let target = (width as f64 / height as f64).ln();
    GEN_RATIO_PRESETS
        .iter()
        .map(|(key, w, h)| {
            let dist = ((*w as f64 / *h as f64).ln() - target).abs();
            (*key, dist)
        })
        .min_by(|a, b| a.1.partial_cmp(&b.1).expect("finite dist"))
        .map(|(key, _)| key.to_string())
}

/// 读首张参考图尺寸 → 吸附档位；读不出（缺文件/SVG 解码 0×0）→ None 维持「自动」。
fn snap_ratio_from_reference(path: &std::path::Path) -> Option<String> {
    let meta = crate::media::probe::probe(path).ok()?;
    nearest_ratio_key(meta.width, meta.height)
}

/// 可取消：前端调 `cancel_codex_create`，select 命中后 future 被 drop，本机 CLI 子进程靠
/// `kill_on_drop` 自动终止（Cloud/远端任务可能仍在运行，submit_id 保留可事后取回）。
///
/// 即梦/Cloud 续轮参考图合并：上一轮产出图在前（修改主体），显式挑选的参考图去重追加，
/// 截前 10（服务端参考图上限）。
fn merge_continuation_references(last: Vec<String>, picked: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    last.into_iter()
        .chain(picked)
        .filter(|p| seen.insert(p.clone()))
        .take(10)
        .collect()
}

#[tauri::command]
pub async fn codex_create_image(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    cloud_client: State<'_, crate::cloud::CloudClient>,
    auth_client: State<'_, crate::cloud::AuthClient>,
    entitlement: State<'_, EntitlementService>,
    settings: State<'_, SettingsState>,
    prompt: String,
    prompt_raw: Option<String>,
    reference_images: Vec<String>,
    // 参考图列表已完整（轮级重试/编辑的精确重放）：跳过续轮自动合并上一轮产出图。
    // None/false = 正常续轮（自动合并会话最新产出作基图）。
    exact_references: Option<bool>,
    session_id: Option<String>,
    ratio: Option<String>,
    provider: Option<String>,
    project_id: Option<String>,
    job_id: String,
    conversation_id: Option<String>,
    anchor_session_id: Option<String>,
) -> Result<String, AppError> {
    // 首轮 instruction：codex 需一句自然语言触发其 imagegen 技能（含 ratio 文本注入）；
    // 即梦 / Cloud 直接用用户原文——它们各有 ratio 参数通道（--ratio / req.ratio），
    // 加这层前缀话反而会被当成画面描述污染出图。
    // 续轮（有 session_id）：codex resume / 即梦 image2image / Cloud 重发，统一用用户修改意见原文。
    // prompt / reference_images 留一份给 generation_meta（req 会 move 走原值）。
    let prompt_for_meta = prompt.clone();
    // ── 续轮参考图与 resume 判定（provider 感知）──
    // 即梦/Cloud 续轮（有 session_id）始终带上会话「最后一个有图轮」的产出图（修改主体），
    // 与显式携带的参考图合并去重（产出在前）、截前 10（服务端参考图上限）。背景：前端曾是
    // 「挑了新参考图就完全替代上一轮产出」——修改意见里 @ 素材图（创作板式组稿的习惯）就会
    // 挤掉上一轮生成图，即梦只收到素材图、丢掉被修改主体（用户实测复现）；且前端 job.turns
    // 是易失内存（重启恢复/回看重建可能缺历史轮），DB 才是会话产出权威。
    //
    // codex 续轮：会话**原生** codex（首轮 provider 是 codex，session id 即 thread id）→
    // resume 沿用 thread；但 codex 的 thread 看不到中途切去即梦/Cloud 的轮——上一产出轮非
    // codex 时，把最新产出图显式附上（--image），画面状态不断。会话非 codex 原生（即梦/
    // Cloud 会话切 codex）→ session id 是别家的 submit_id，codex resume 必失败 → **开新
    // thread**（首轮形态：instruction 触发 imagegen 的包装 + 附最新产出图交接）；簿记
    // session 不变（meta/done 仍记原会话 id，时间线/分组不裂）。
    //
    // exact_references=true（轮级重试/编辑）时跳过合并/附加：调用方已给该轮**当时实际下发**
    // 的完整参考图列表，精确重放（重试第 N 轮用当时的基图，而不是该轮自己产出的最新图）。
    let mut reference_images = reference_images;
    // provider 侧的 resume 句柄（codex = thread id；即梦/Cloud 沿用 session id 记账）。
    let mut provider_resume = session_id.clone();
    let exact = exact_references.unwrap_or(false);
    if let Some(sid) = session_id.as_deref() {
        let is_codex_provider =
            matches!(provider.as_deref(), None | Some("codex" | "default" | "codex-cli"));
        let jimeng_or_cloud = matches!(provider.as_deref(), Some("jimeng" | "dreamina"))
            || crate::codex::is_cloud_generation_provider(provider.as_deref());
        if jimeng_or_cloud || is_codex_provider {
            let db_fb = db.inner().clone();
            let sid_fb = sid.to_string();
            let (native_provider, last_provider, last_images, codex_thread) =
                tokio::task::spawn_blocking(move || {
                    let native = db_fb.session_generation_provider(&sid_fb, false);
                    let last = db_fb.session_generation_provider(&sid_fb, true);
                    let imgs = db_fb.last_generated_images_for_session(&sid_fb);
                    let thread = db_fb.session_codex_thread(&sid_fb);
                    (native, last, imgs, thread)
                })
                .await
                .map_err(|e| AppError::Other(e.to_string()))?;
            if jimeng_or_cloud {
                if !exact && !last_images.is_empty() {
                    tracing::info!(
                        "gen: 续轮合并上一轮产出图 job={} session={} last={} picked={}",
                        job_id,
                        sid,
                        last_images.len(),
                        reference_images.len()
                    );
                    reference_images =
                        merge_continuation_references(last_images, reference_images);
                }
            } else {
                // codex resume 句柄：codex 原生会话 = session id（thread id）；非 codex 原生
                // （即梦/Cloud 会话切入）= meta 里最近记录的 codex thread——连续 codex 轮共享
                // 一个 thread；都没有 → None 开新 thread（完成时 finalize 落 codex_thread 句柄，
                // 下轮 resume）。句柄解析不受 exact 影响（重试也要接上下文）。
                provider_resume = if generation_provider_is_codex(native_provider.as_deref()) {
                    Some(sid.to_string())
                } else {
                    codex_thread
                };
                // codex thread 看不到别家引擎的轮：上一产出轮非 codex 时显式附最新产出图
                // （resume 交接画面状态 / 新 thread 首轮带入当前画面）。精确重放跳过。
                if !exact
                    && !generation_provider_is_codex(last_provider.as_deref())
                    && !last_images.is_empty()
                {
                    tracing::info!(
                        "gen: codex 续轮交接最新产出图 job={} session={} last_provider={:?}",
                        job_id,
                        sid,
                        last_provider
                    );
                    reference_images =
                        merge_continuation_references(last_images, reference_images);
                }
            }
        }
    }
    let refs_for_meta = reference_images.clone();
    // 「自动」比例解析（后端权威）：显式选档照传；自动（空）且有参考图时，跟随**第一张参考图**
    // （续轮 = 参考图合并后的首位 = 上一轮产出图）的宽高比吸附到最近档位、显式下发——即梦
    // omit --ratio 固定回退 16:9（竖图被横切）；解析不了（无参考图/读不出尺寸）维持自动。
    // 档位与前端创作板 RATIOS 同一套 7 档（creation/ratios.ts）。
    let ratio = match ratio.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        Some(r) => Some(r.to_string()),
        None => reference_images
            .first()
            .and_then(|p| snap_ratio_from_reference(std::path::Path::new(p))),
    };
    // job_id 由前端生成（crypto.randomUUID）传入：前端创建 GenJob 时即知 id，chunk 事件按 job_id
    // 路由无 race；续轮（resume 同一 session）复用同一 job_id，task_queue 行 upsert 刷新回 running。
    let is_codex = matches!(provider.as_deref(), None | Some("codex" | "default"));
    let ratio_clause = match ratio.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        Some(r) => format!("；画面比例为 {r}"),
        None => String::new(),
    };
    // instruction：codex **新 thread**（首轮 / 非 codex 原生会话切入）需要触发 imagegen 的
    // 包装语；resume 续轮与即梦/Cloud 一律用户原文。
    let instruction = if is_codex && provider_resume.is_none() {
        format!(
            "请使用图像生成工具，根据以下提示词和参考图生成图片（张数完全以提示词要求为准；提示词未指定张数时生成一张{ratio_clause}）。\n\n{prompt}"
        )
    } else {
        prompt
    };
    let req = CodexRequest {
        instruction,
        reference_images: reference_images.into_iter().map(PathBuf::from).collect(),
        context_prompts: vec![],
        ratio: ratio.clone(),
        job_id: Some(job_id.clone()),
    };

    let entitlement_snapshot = entitlement.current_or_sync(&auth_client).await;
    if !entitlement_snapshot
        .policy
        .allows_generation_provider(provider.as_deref())
    {
        return Err(AppError::Other(
            "当前账号不可使用本机生成引擎；升级 Pro 解锁 Codex / 即梦 CLI".into(),
        ));
    }
    let db_for_gate = db.inner().clone();
    let gate_job_id = job_id.clone();
    let running_count = tokio::task::spawn_blocking(move || -> Result<usize, AppError> {
        Ok(crate::core::task_queue::Task::list_running(&db_for_gate)?
            .into_iter()
            .filter_map(|task| task.gen_job())
            .filter(|job| job.id != gate_job_id)
            .count())
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))??;
    if !entitlement_snapshot.policy.can_start_job(running_count) {
        return Err(AppError::Other("已达当前账号档位的并行生成上限".into()));
    }

    let (tx, mut rx) = mpsc::channel::<Chunk>(64);
    let app_clone = app.clone();
    let job_id_for_emit = job_id.clone();
    tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            // Chunk::Submit：即梦 submit 拿到 submit_id 的瞬间 → 立即 upsert 落库（submit_id + 细粒度
            // status=querying）。app 在下载完成前被杀也能凭持久化的 submit_id 恢复续查（Task 5）。
            if let Chunk::Submit { ref submit_id } = chunk {
                if let Some(db) = app_clone.try_state::<Arc<Database>>() {
                    let db = db.inner();
                    match crate::core::task_queue::Task::by_id(db, &job_id_for_emit)
                        .ok()
                        .flatten()
                        .and_then(|t| t.gen_job())
                    {
                        Some(mut job) => {
                            job.submit_id = Some(submit_id.clone());
                            job.status = "querying".to_string();
                            let _ = crate::core::task_queue::Task::upsert_gen_job(db, &job);
                            tracing::info!(
                                "gen: submit_id 落库 job={} sid={}",
                                job_id_for_emit,
                                submit_id
                            );
                        }
                        None => tracing::warn!(
                            "gen: Submit 收到但 job {} 不在 task_queue",
                            job_id_for_emit
                        ),
                    }
                } else {
                    tracing::warn!("gen: Submit 收到但 Database state 不可用");
                }
            }
            // job_id 注入 chunk JSON 顶层（前端 c.kind/c.text 仍可用 + 新增 c.job_id 路由）。
            let mut v = serde_json::to_value(&chunk).unwrap_or(serde_json::Value::Null);
            if let serde_json::Value::Object(ref mut map) = v {
                map.insert(
                    "job_id".into(),
                    serde_json::Value::String(job_id_for_emit.clone()),
                );
            }
            let _ = app_clone.emit("codex://chunk", v);
        }
    });

    // 先解析 provider（可能出错 → ?）：必须在注册 GENERATE_CANCEL 之前，否则出错提前返回
    // 会留下 stale cancel sender（下次 cancel_codex_create take 到它）。None → codex（默认）。
    // 即梦模型版本每次生成都从 settings 重读 → 设置页热修改下一次生成即生效。
    let cloud_context = crate::codex::is_cloud_generation_provider(provider.as_deref())
        .then(|| (cloud_client.inner().clone(), auth_client.inner().clone()));
    let dreamina_model = settings.get().dreamina_model_version;
    let p = resolve_gen_provider(provider.as_deref(), cloud_context, Some(&dreamina_model))?;
    let provider_name = p.name().to_string();

    // Phase A task 2：入队 task_queue（status=running），供任务中心 / 启动恢复 / 取消引用。
    let now_ts = chrono::Utc::now().timestamp();
    {
        let job = crate::core::task_queue::GenJob {
            id: job_id.clone(),
            media: "image".to_string(),
            provider: provider_name.clone(),
            status: "running".to_string(),
            prompt: prompt_for_meta.clone(),
            references: refs_for_meta.clone(),
            session_id: session_id.clone(),
            conversation_id: conversation_id.clone(),
            project_id: project_id.clone(),
            ratio: ratio.clone(),
            submit_id: None,
            video_options: None,
            turns: serde_json::json!([]),
            error: None,
            queue_idx: None,
            created_at: now_ts,
            started_at: Some(now_ts),
            finished_at: None,
        };
        crate::core::task_queue::Task::upsert_gen_job(db.inner(), &job)?;
        // 版本分支锚定：conversation 的根 session 可能还没有映射（旧版生成的 job / 「回看
        // 生成对话」重建的会话）——入队时按前端传来的源会话 session 补记一笔，让根产出
        // 也能并入 conversation 组（幂等，覆盖写入）。
        if let (Some(conv), Some(anchor)) =
            (conversation_id.as_deref(), anchor_session_id.as_deref())
        {
            if let Err(e) = db.inner().record_generation_conversation(anchor, conv) {
                tracing::warn!("会话分组锚定失败 session={anchor} conv={conv}: {e}");
            }
        }
    }

    // 生成开始即通知前端 job_id：同步模型下命令 await 到完成才返回 job_id，生成中前端拿不到
    // → currentGenJobId 为 null → 取消失效。started 事件让前端早 set currentGenJobId，取消可生效。
    // references = 本轮最终下发的参考图（续轮含后端合并的上一轮产出图）——前端落到该轮
    // GenTurn.refs，气泡上方画「附件」缩略图（续轮看不到合并结果曾是用户投诉点）。
    // ratio = 本轮最终比例（自动档已按第一参考图吸附）——前端更新 job.lastRatio，
    // 续轮坞比例初值与实际下发保持一致。
    let _ = app.emit(
        "codex://chunk",
        serde_json::json!({
            "kind": "started",
            "job_id": &job_id,
            "references": refs_for_meta.clone(),
            "ratio": ratio.clone(),
        }),
    );

    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    GENERATE_CANCEL
        .lock()
        .unwrap()
        .insert(job_id.clone(), cancel_tx);

    // 即梦并发=1（spike 实测）：permit=1 Semaphore 串行化即梦 job，避免多 job 同时跑 dreamina
    // 子进程撞 ExceedConcurrencyLimit；codex 不受限可并行。持有到 fn 结束（return 时 drop 释放名额）。
    // 排队中取消：等拿到名额后 provider select 命中 cancel（MVP 简化，不中断 acquire）。
    let _jimeng_permit = if matches!(provider_name.as_str(), "jimeng" | "dreamina") {
        Some(
            crate::core::generation_worker::JIMENG_FLY
                .acquire()
                .await
                .unwrap(),
        )
    } else {
        None
    };

    let generation_result: Result<(), AppError> = async {
        // generate_image 借用 tx 推 Delta；用 block 限定借期，结束后 command 才能 reuse tx 发 Done。
        // resume 句柄用 provider_resume（非 codex 原生会话切 codex = None 开新 thread）。
        let outcome = {
            let gen_fut = p.generate_image(req, &tx, provider_resume);
            tokio::pin!(gen_fut);
            tokio::select! {
                res = &mut gen_fut => res,
                _ = &mut cancel_rx => Err(AppError::Codex("已取消".into())),
            }?
        };

        // 簿记 session：优先请求时的会话 id（新 thread 轮也归原会话——meta/前端 sessionId/
        // 重启时间线都不裂），首轮（请求无 session）才用 provider 产出的新 id。
        let bookkeeping_session = session_id.clone().or(outcome.session_id.clone());

        // 源图收尾入库（ingest + project link + generation_meta + caption + 自动命名）—— 抽到
        // generation_worker::finalize_generation_assets，与启动恢复 worker 共用、元数据一致。
        let gen_assets = crate::core::generation_worker::finalize_generation_assets(
            app.clone(),
            db.inner().clone(),
            paths.inner().clone(),
            outcome.source_images.clone(),
            outcome.temp_dir.clone(),
            prompt_for_meta.clone(),
            prompt_raw,
            refs_for_meta.clone(),
            bookkeeping_session.clone(),
            conversation_id.clone(),
            outcome.submit_id.clone(),
            provider_name.clone(),
            project_id.clone(),
            // codex 轮记录真实 thread id（非 codex 原生会话里连续 codex 轮共享 thread 的句柄）。
            if provider_name == "codex-cli" {
                outcome.session_id.clone()
            } else {
                None
            },
        )
        .await?;

        let asset_paths: Vec<PathBuf> = gen_assets
            .iter()
            .filter_map(|a| a.store_path.clone().map(PathBuf::from))
            .collect();
        let _ = tx
            .send(Chunk::Done(CodexResult {
                text: outcome.text,
                provider: provider_name.clone(),
                elapsed_ms: outcome.elapsed_ms,
                session_id: bookkeeping_session,
                images: asset_paths,
            }))
            .await;
        Ok(())
    }
    .await;
    GENERATE_CANCEL.lock().unwrap().remove(&job_id);
    settle_generation_task(db.inner(), &job_id, &generation_result);
    generation_result?;

    // 生成图已入库，通知瀑布流刷新（finalize 已 emit analyses://changed + 自动命名）。
    let _ = app.emit("library://assets-changed", ());
    Ok(job_id)
}

/// 取消指定的图像生成任务（per-job）。无此 job 在跑则空操作。
/// 本地停止 CLI 子进程；远端即梦任务可能仍在运行（已扣积分），submit_id 保留可事后取回。
#[tauri::command]
pub async fn cancel_codex_create(
    db: State<'_, Arc<Database>>,
    job_id: String,
) -> Result<(), AppError> {
    if let Some(tx) = GENERATE_CANCEL.lock().unwrap().remove(&job_id) {
        let _ = tx.send(());
    }
    let _ = crate::core::task_queue::Task::mark_cancelled(db.inner(), &job_id);
    Ok(())
}

/// 未完成生成 job 的摘要（前端启动重建 genJobs 用，Task 5 启动恢复）。
#[derive(Debug, Clone, Serialize)]
pub struct GenJobSummary {
    pub id: String,
    pub media: String,
    pub provider: String,
    pub status: String,
    pub prompt: String,
    pub submit_id: Option<String>,
    pub session_id: Option<String>,
    pub conversation_id: Option<String>,
    pub project_id: Option<String>,
    pub ratio: Option<String>,
    pub references: Vec<String>,
    pub created_at: i64,
    pub running: bool,
}

/// 列出未完成的生成 job（queued/running），供前端启动时重建 genJobs（恢复中 job 可见）。
/// done/failed 不返回（已是资产或显失败）。codex job 也返回（前端展示「app 重启中断」失败态）。
#[tauri::command]
pub async fn list_gen_jobs(db: State<'_, Arc<Database>>) -> Result<Vec<GenJobSummary>, AppError> {
    let dbw = db.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<Vec<GenJobSummary>, AppError> {
        let tasks = crate::core::task_queue::Task::list_running(&dbw)?;
        Ok(tasks
            .into_iter()
            .filter_map(|t| t.gen_job())
            .map(|j| GenJobSummary {
                running: matches!(
                    j.status.as_str(),
                    "running" | "querying" | "downloading" | "ingesting" | "submitting" | "queued"
                ),
                id: j.id,
                media: j.media,
                provider: j.provider,
                status: j.status,
                prompt: j.prompt,
                submit_id: j.submit_id,
                session_id: j.session_id,
                conversation_id: j.conversation_id,
                project_id: j.project_id,
                ratio: j.ratio,
                references: j.references,
                created_at: j.created_at,
            })
            .collect())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

/// 会话面板历史恢复项：终态生成 job 摘要 + 从 generation_meta 重建的各轮时间线。
/// `status` 取 `task_queue.status` 列（mark_done/mark_failed 只更新列不回写 payload，
/// payload 里的细粒度 status 可能停在 running）；`ref_assets` 为首版参考图完整 asset
/// （面板缩略图 / 复用还原用）。
#[derive(Debug, Clone, Serialize)]
pub struct RecentGenSession {
    pub id: String,
    pub provider: String,
    pub status: String, // done | failed
    pub prompt: String,
    pub error: Option<String>,
    pub session_id: Option<String>,
    pub conversation_id: Option<String>,
    pub project_id: Option<String>,
    pub ratio: Option<String>,
    pub references: Vec<String>,
    pub created_at: i64,
    pub turns: Vec<GenerationHistoryTurn>,
    pub ref_assets: Vec<PromptedAsset>,
}

/// 列出最近的已完成（done/failed）生成会话，供前端启动时重建 genJobs——会话面板跨
/// 重启保留（done 会话可回看续轮，failed 会话可重试）。cancelled 不恢复（用户显式
/// 取消过）；queued/running 走 [`list_gen_jobs`] 的启动恢复链路，不在此重复。
#[tauri::command]
pub async fn recent_gen_sessions(
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    limit: Option<i64>,
) -> Result<Vec<RecentGenSession>, AppError> {
    let annotations_dir = paths.inner().root.join("annotations");
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<Vec<RecentGenSession>, AppError> {
        let limit = limit.unwrap_or(30).clamp(1, 100);
        // list_recent 是全 kind 查询（当前 task_queue 只有 generation kind），多取一批
        // 再按终态过滤、截 limit。
        let tasks = crate::core::task_queue::Task::list_recent(&db, 200)?;
        let mut out = Vec::new();
        for t in tasks {
            if out.len() >= limit as usize {
                break;
            }
            if !matches!(t.status.as_str(), "done" | "failed") {
                continue;
            }
            let Some(j) = t.gen_job() else {
                continue;
            };
            // 时间线从 generation_meta 按 session 重建（无 session 的失败 job → 空时间线，
            // 前端仍有 prompt 可重试）；重建失败不阻断其余会话恢复。
            let (turns, ref_assets) = match &j.session_id {
                Some(sid) => match db.generation_history_by_session(sid, Some(&annotations_dir)) {
                    Ok(h) => (h.turns, h.references),
                    Err(e) => {
                        tracing::warn!("recent_gen_sessions: history for {sid} failed: {e}");
                        (Vec::new(), Vec::new())
                    }
                },
                None => (Vec::new(), Vec::new()),
            };
            out.push(RecentGenSession {
                id: j.id,
                provider: j.provider,
                status: t.status,
                prompt: j.prompt,
                error: t.error,
                session_id: j.session_id,
                conversation_id: j.conversation_id,
                project_id: j.project_id,
                ratio: j.ratio,
                references: j.references,
                created_at: j.created_at,
                turns,
                ref_assets,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

/// 从会话面板移除已完成会话的持久记录：删除 task_queue 终态行，重启恢复不再出现。
/// 仅终态可删（在跑行是启动恢复数据源）；行不存在（「回看生成对话」的前端临时 job）
/// 为空操作。生成图与 generation_meta 不受影响。
#[tauri::command]
pub async fn dismiss_gen_job(
    db: State<'_, Arc<Database>>,
    job_id: String,
) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || crate::core::task_queue::Task::delete_terminal(&db, &job_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}
/// `[spike]` OpenAI API 生图（非 codex CLI）：调 OpenAI Images API（`gpt-image-1`），
/// `b64_json` 落盘后 `ingest_generated` 进库为正式资产、进瀑布流。
///
/// **spike 性质**：不接 `CodexProvider` trait、不加 UI、不存 `generation_meta`；
/// devtools invoke 触发验证。需设 `OPENAI_API_KEY`（可选 `OPENAI_BASE_URL` / `HTTPS_PROXY`）。
/// `reference_images` 空 → `/images/generations`（纯文）；非空 → `/images/edits`（带参考图，≤16）。
/// 跑通后正式整合（settings + provider 抽象 + UI）是独立后续工作，详见 plans/spike。
#[tauri::command]
pub async fn openai_spike_generate_image(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    auth_client: State<'_, crate::cloud::AuthClient>,
    entitlement: State<'_, EntitlementService>,
    prompt: String,
    reference_images: Vec<String>,
    n: Option<u32>,
    size: Option<String>,
    quality: Option<String>,
) -> Result<Vec<String>, AppError> {
    require_byo(&entitlement, &auth_client).await?;
    let req = crate::codex::openai_api::OpenAiImageReq {
        prompt,
        reference_images: reference_images.into_iter().map(PathBuf::from).collect(),
        n: n.unwrap_or(1),
        size: size.unwrap_or_else(|| "1024x1024".to_string()),
        quality: quality.unwrap_or_else(|| "auto".to_string()),
        model: String::new(), // 空 → 默认 gpt-image-1
    };
    let srcs = crate::codex::openai_api::generate_images(req).await?;

    let dbw = db.inner().clone();
    let pw = paths.inner().clone();
    let ids: Vec<String> = tokio::task::spawn_blocking(move || -> Result<Vec<String>, AppError> {
        let mut out = Vec::new();
        for src in &srcs {
            let asset = crate::core::ingest::ingest_generated(&pw, &dbw, src, None, "openai")?;
            out.push(asset.id);
        }
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;

    let _ = app.emit("library://assets-changed", ());
    Ok(ids)
}

/// 「在 codex 中打开会话」：唤起系统终端跑 `codex resume <session_id>`，
/// 让用户在 codex TUI 里翻看本次反推的完整对话（含图）。macOS 用 Terminal.app。
/// 二进制用 `resolve_codex_binary` 的完整路径调起——应用内直装的托管副本不在
/// 系统 PATH 上，裸 `codex` 会找不到。
#[tauri::command]
pub async fn open_codex_session(
    auth_client: State<'_, crate::cloud::AuthClient>,
    entitlement: State<'_, EntitlementService>,
    session_id: String,
) -> Result<(), AppError> {
    require_byo(&entitlement, &auth_client).await?;
    let sid = session_id.trim();
    if sid.is_empty() {
        return Err(AppError::Codex("session_id 为空".into()));
    }
    // session_id 是 codex 输出的 UUID（我们落库的值），非用户自由输入；白名单校验
    // 防注入（下方要与终端 / osascript 命令字符串拼接）。
    if !sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(AppError::Codex("session_id 格式无效".into()));
    }
    let binary = resolve_codex_binary()
        .ok_or_else(|| AppError::Codex("未检测到 codex CLI，请先在设置中一键安装".into()))?;

    #[cfg(target_os = "macos")]
    {
        // 二进制路径可能含空格，作为 shell 命令须整体加引号（AppleScript 字符串内 \"）。
        let script = format!(
            "tell application \"Terminal\"\nactivate\ndo script \"\\\"{binary}\\\" resume {sid}\"\nend tell"
        );
        tokio::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .spawn()
            .map_err(|e| AppError::Codex(format!("启动 Terminal 失败: {e}")))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        #[cfg(target_os = "windows")]
        {
            // `start "" cmd.exe /K` 经 cmd.exe 另开一个常驻命令提示符；含空格的二进制
            // 路径经 raw_arg 以引号包裹（同 npm_command 约定——标准 .arg 的转义会被
            // cmd 拆成多 token）。
            let mut command = tokio::process::Command::new("cmd.exe");
            command
                .arg("/D")
                .arg("/C")
                .arg("start")
                .arg("")
                .arg("cmd.exe")
                .arg("/K");
            command.raw_arg(format!("\"{binary}\" resume {sid}"));
            command
                .spawn()
                .map_err(|e| AppError::Codex(format!("启动命令提示符失败: {e}")))?;
            Ok(())
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (&sid, &binary);
            Err(AppError::Codex("当前系统暂不支持打开 codex 会话".into()))
        }
    }
}

/// 取资产的 store_path（spawn_blocking 读 DB），不存在或无 store_path 报错。
async fn get_asset_store_path(
    db: &State<'_, Arc<Database>>,
    asset_id: &str,
) -> Result<String, AppError> {
    let db_for_get = db.inner().clone();
    let aid_for_get = asset_id.to_string();
    let asset = tokio::task::spawn_blocking(move || db_for_get.get_asset(&aid_for_get))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??
        .ok_or_else(|| AppError::NotFound(asset_id.to_string()))?;
    asset
        .store_path
        .ok_or_else(|| AppError::Media(format!("asset {asset_id} has no store_path")))
}

#[cfg(test)]
mod generation_task_tests {
    use chrono::Utc;

    use super::{
        generation_provider_is_codex, merge_continuation_references, nearest_ratio_key,
        settle_generation_task,
    };
    use crate::core::task_queue::{GenJob, Task};
    use crate::db::Database;
    use crate::error::AppError;

    fn running_job(id: &str) -> GenJob {
        let now = Utc::now().timestamp();
        GenJob {
            id: id.into(),
            media: "image".into(),
            provider: "bowerbird-cloud".into(),
            status: "running".into(),
            prompt: "test".into(),
            references: vec![],
            session_id: None,
            conversation_id: None,
            project_id: None,
            ratio: None,
            submit_id: None,
            video_options: None,
            turns: serde_json::json!([]),
            error: None,
            queue_idx: None,
            created_at: now,
            started_at: Some(now),
            finished_at: None,
        }
    }

    #[test]
    fn failed_generation_releases_persistent_parallel_slot() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        let job = running_job("cloud-timeout");
        Task::enqueue_gen_job(&db, &job).unwrap();

        let result = Err(AppError::Cloud("等待云端响应超时".into()));
        settle_generation_task(&db, &job.id, &result);

        let task = Task::by_id(&db, &job.id).unwrap().unwrap();
        assert_eq!(task.status, "failed");
        assert!(task.error.unwrap().contains("等待云端响应超时"));
        assert!(Task::list_running(&db).unwrap().is_empty());
    }

    #[test]
    fn merge_continuation_references_puts_last_output_first_dedup_cap() {
        // 续轮合并契约：上一轮产出在前（修改主体）、显式挑选去重追加、截前 10、挑的图含
        // 上一轮产出（用户点了生成图）不重复。
        let last = vec!["out1.png".into(), "out2.png".into()];
        let picked = vec!["material.png".into(), "out1.png".into()];
        assert_eq!(
            merge_continuation_references(last, picked),
            vec!["out1.png".to_string(), "out2.png".to_string(), "material.png".to_string()]
        );
        // 超 10 张截断（上一轮产出保位，挑的图被截掉尾部）。
        let many: Vec<String> = (0..12).map(|i| format!("p{i}.png")).collect();
        assert_eq!(
            merge_continuation_references(vec!["out.png".into()], many.clone()).len(),
            10
        );
        assert_eq!(
            merge_continuation_references(vec!["out.png".into()], many)[0],
            "out.png"
        );
        assert!(merge_continuation_references(vec![], vec![]).is_empty());
    }

    #[test]
    fn nearest_ratio_key_snaps_to_closest_preset() {
        // 「自动」比例吸附契约（与前端 autoRatioFromReferences 同一套 7 档）：精确档位直落、
        // 偏离档位按对数距离取最近、零尺寸返回 None（维持自动）。
        assert_eq!(nearest_ratio_key(1000, 1000).as_deref(), Some("1:1"));
        assert_eq!(nearest_ratio_key(864, 1152).as_deref(), Some("3:4"));
        assert_eq!(nearest_ratio_key(1152, 864).as_deref(), Some("4:3"));
        assert_eq!(nearest_ratio_key(1920, 1080).as_deref(), Some("16:9"));
        assert_eq!(nearest_ratio_key(1080, 1920).as_deref(), Some("9:16"));
        assert_eq!(nearest_ratio_key(1000, 1500).as_deref(), Some("2:3"));
        // 偏离档位的实际产出尺寸（如 2k 竖图 896×1600 ≈ 9:16）吸附到最近档。
        assert_eq!(nearest_ratio_key(896, 1600).as_deref(), Some("9:16"));
        // 0.69:1 介于 2:3(0.67) 与 3:4(0.75) 之间，对数距离更近 2:3。
        assert_eq!(nearest_ratio_key(690, 1000).as_deref(), Some("2:3"));
        assert!(nearest_ratio_key(0, 100).is_none());
        assert!(nearest_ratio_key(100, 0).is_none());
    }

    #[test]
    fn generation_provider_is_codex_matches_codex_family_keys() {
        // 原生引擎判定：codex 家族 key（provider.name()=codex-cli / 前端裸 codex、default）
        // 为真；即梦（含 dreamina 别名）与 Cloud 档位 key、None（无 meta）为假。
        assert!(generation_provider_is_codex(Some("codex")));
        assert!(generation_provider_is_codex(Some("codex-cli")));
        assert!(generation_provider_is_codex(Some("default")));
        assert!(!generation_provider_is_codex(Some("jimeng")));
        assert!(!generation_provider_is_codex(Some("dreamina")));
        assert!(!generation_provider_is_codex(Some("bowerbird-cloud")));
        assert!(!generation_provider_is_codex(Some("bowerbird-cloud-image_hd")));
        assert!(!generation_provider_is_codex(None));
    }

    #[test]
    fn successful_and_cancelled_generations_reach_terminal_states() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        let done = running_job("done");
        let cancelled = running_job("cancelled");
        Task::enqueue_gen_job(&db, &done).unwrap();
        Task::enqueue_gen_job(&db, &cancelled).unwrap();

        settle_generation_task(&db, &done.id, &Ok(()));
        settle_generation_task(&db, &cancelled.id, &Err(AppError::Codex("已取消".into())));

        assert_eq!(Task::by_id(&db, &done.id).unwrap().unwrap().status, "done");
        assert_eq!(
            Task::by_id(&db, &cancelled.id).unwrap().unwrap().status,
            "cancelled"
        );
        assert!(Task::list_running(&db).unwrap().is_empty());
    }
}
