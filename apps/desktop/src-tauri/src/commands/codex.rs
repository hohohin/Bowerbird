//! Codex 调用命令（单次 + 流式 + 反推 + 会话回看）。
//!
//! 全部走 [`CodexCliProvider`]（`codex exec --image`，ChatGPT 订阅认证，
//! 真正多模态看图；Mock / DeepSeek / OpenAI HTTP 路线已移除，详见 PROJECT.md）。
//! 流式：通过 event `codex://chunk` 推 Chunk（Delta / Done / Error）。

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use ulid::Ulid;

use crate::codex::codex_cli::{codex_command, codex_home, resolve_codex_binary, CodexCliProvider};
use crate::codex::types::{Chunk, CodexRequest, CodexResult};
use crate::codex::CodexProvider;
use crate::core::caption;
use crate::core::paths::LibraryPaths;
use crate::db::Database;
use crate::error::AppError;

const DEFAULT_DESCRIBE_INSTRUCTION: &str = "请描述这张图片";

/// codex 可用性检测结果。`ok=false` 时 `reason` 给出置灰提示文案。
#[derive(Debug, Clone, Serialize)]
pub struct CodexHealth {
    pub ok: bool,
    pub reason: String,
}

/// 检测 codex 是否可用于反推：① CLI 可执行；② CODEX_HOME（或用户目录）内 auth.json 非空。
/// 任一不满足返回 `ok=false` + 中文 reason，前端据此置灰反推按钮（约定 7：离线/无账号降级置灰）。
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
            reason: "未检测到 codex CLI（需 npm install -g @openai/codex 并在 PATH）".into(),
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

/// 为单个资产生成提示词并写回 asset_prompts（批量由前端循环）。
#[tauri::command]
pub async fn codex_generate_prompt_for_asset(
    db: State<'_, Arc<Database>>,
    asset_id: String,
    role: String,
) -> Result<String, AppError> {
    let store_path = get_asset_store_path(&db, &asset_id).await?;

    let req = CodexRequest {
        instruction: "为这张图片生成一段适合 AI 绘画的提示词（描述主体、风格、构图、光影）".into(),
        reference_images: vec![PathBuf::from(store_path)],
        context_prompts: vec![],
    };
    let p = CodexCliProvider::default();
    let provider_name = p.name().to_string();
    let result = p.run(req).await?;

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
/// 取消时往 sender 发信号，select 命中后 run future 被 drop，codex 子进程靠
/// `kill_on_drop` 自动终止（见 codex_cli.rs）。
static DESCRIBE_CANCEL: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>> =
    std::sync::Mutex::new(None);

/// 「反推」：让 codex 描述指定资产，结果落 analyses(kind=caption)。
/// payload 同时存 session_id，前端「在 codex 中打开」按钮据此唤起 `codex resume`。
/// 可取消：前端调 `cancel_codex_describe` 即中断本次 codex 执行（子进程被 kill）。
#[tauri::command]
pub async fn codex_describe_asset(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    asset_id: String,
    instruction: Option<String>,
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
    };
    let p = CodexCliProvider::default();
    let provider_name = p.name().to_string();

    // 可取消：select codex 执行 与 取消信号。取消时 run future 被 drop，
    // codex 子进程靠 kill_on_drop 自动 kill。
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    DESCRIBE_CANCEL
        .lock()
        .unwrap()
        .replace(cancel_tx);
    let run_fut = p.run(req);
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

/// 当前图像生成任务的取消信号（与反推 `DESCRIBE_CANCEL` 独立，互不影响）。
static GENERATE_CANCEL: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>> =
    std::sync::Mutex::new(None);

/// 创作板「生成」：把最终 prompt + 参考图发 codex（`codex exec --image`，与反推同机制），
/// 让 codex 调内置 imagegen 技能出图。
///
/// - 流式：codex 的逐条 `agent_message` 经 event `codex://chunk`（Delta）回前端；
/// - 取图：跑完扫 `~/.codex/generated_images/` 本次新增图，copy 进 `library/generations/`，
///   随 `Done.images`（库内路径）回前端 convertFileSrc 渲染；
/// - 不写 `analyses`（生成 ≠ 分析）；`generations` 表落库是后续（见 PROJECT.md 约定 2）。
/// 可取消：前端调 `cancel_codex_create`，select 命中后 future 被 drop，codex 子进程靠
/// `kill_on_drop` 自动终止。
#[tauri::command]
pub async fn codex_create_image(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    prompt: String,
    reference_images: Vec<String>,
    session_id: Option<String>,
) -> Result<(), AppError> {
    // 首轮（无 session_id）：包一句明确要 codex 出图，触发 imagegen；
    // 续轮（有 session_id = resume）：codex 已在画图上下文里，用户修改意见原样发。
    // prompt / reference_images 留一份给 generation_meta（req 会 move 走原值）。
    let prompt_for_meta = prompt.clone();
    let refs_for_meta = reference_images.clone();
    let instruction = match &session_id {
        Some(_) => prompt,
        None => format!(
            "请使用图像生成工具，根据以下提示词和参考图生成图片（张数完全以提示词要求为准；提示词未指定张数时生成一张）。\n\n{prompt}"
        ),
    };
    let req = CodexRequest {
        instruction,
        reference_images: reference_images.into_iter().map(PathBuf::from).collect(),
        context_prompts: vec![],
    };

    let (tx, mut rx) = mpsc::channel::<Chunk>(64);
    let app_clone = app.clone();
    tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            let _ = app_clone.emit("codex://chunk", &chunk);
        }
    });

    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    GENERATE_CANCEL.lock().unwrap().replace(cancel_tx);

    let p = CodexCliProvider::default();
    let provider_name = p.name().to_string();
    // generate_image 借用 tx 推 Delta；用 block 限定借期，结束后 command 才能 reuse tx 发 Done。
    let outcome = {
        let gen_fut = p.generate_image(req, &tx, session_id);
        tokio::pin!(gen_fut);
        let r = tokio::select! {
            res = &mut gen_fut => res,
            _ = &mut cancel_rx => return Err(AppError::Codex("已取消".into())),
        };
        r?
    };
    GENERATE_CANCEL.lock().unwrap().take();

    // codex 生成的源图（~/.codex/...）ingest 进库 → asset（asset scope 内可渲染 + 进瀑布流）。
    // ingest_generated 不做 pHash 去重，迭代各版相似图都各自保留。
    let dbw = db.inner().clone();
    let pw = paths.inner().clone();
    let srcs = outcome.source_images.clone();
    let session_for_ingest = outcome.session_id.clone();
    let gen_assets: Vec<crate::core::library::Asset> =
        tokio::task::spawn_blocking(
            move || -> Result<Vec<crate::core::library::Asset>, AppError> {
                let mut out = Vec::new();
                for src in &srcs {
                    out.push(crate::core::ingest::ingest_generated(
                        &pw,
                        &dbw,
                        src,
                        session_for_ingest.as_deref(),
                    )?);
                }
                Ok(out)
            },
        )
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;

    let asset_paths: Vec<PathBuf> = gen_assets
        .iter()
        .filter_map(|a| a.store_path.clone().map(PathBuf::from))
        .collect();
    let session_id = outcome.session_id.clone();
    let _ = tx
        .send(Chunk::Done(CodexResult {
            text: outcome.text,
            provider: provider_name.clone(),
            elapsed_ms: outcome.elapsed_ms,
            session_id: outcome.session_id,
            images: asset_paths,
        }))
        .await;
    drop(tx);

    // 生成来源落库（analyses kind=generation_meta）：prompt / session_id / 参考图路径，
    // 详情页据此展示「这张图怎么来的」+ 可点进 codex resume 回看会话。
    let meta_payload = serde_json::json!({
        "prompt": prompt_for_meta,
        "session_id": session_id,
        "references": refs_for_meta,
    })
    .to_string();
    let ids: Vec<String> = gen_assets.iter().map(|a| a.id.clone()).collect();
    let dbm = db.inner().clone();
    let provider_for_meta = provider_name.clone();
    // 生成图 caption（反推提示结果）：从「生成它的 prompt」里识别 【维度】：正文 片段（创作板序列化
    // 注入），按维度分段落库，免再调 codex 反推去猜。session_id 在则按会话取整条 prompt 链（本轮
    // generation_meta 刚写入可见）→ 同名维度后出现者覆盖（修订版优先）。无维度时回退整段。
    // 原文（prompt / session_id / 参考图）另存 generation_meta，由「✨ 生成来源」卡片展示。
    let session_for_chain = session_id.clone();
    let prompt_for_chain = prompt_for_meta.clone();
    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        for id in &ids {
            let row = crate::core::library::Analysis {
                id: Ulid::new().to_string(),
                asset_id: id.clone(),
                kind: "generation_meta".to_string(),
                payload: meta_payload.clone(),
                provider: Some(provider_for_meta.clone()),
                created_at: None,
            };
            dbm.insert_analysis(&row)?;
        }

        // caption 正文：session 在则取会话 prompt 链（首版 + 各轮修改），否则退化为仅本轮 prompt。
        let chain = match &session_for_chain {
            Some(sid) => dbm
                .generation_prompt_chain(sid)
                .unwrap_or_else(|_| vec![prompt_for_chain.clone()]),
            None => vec![prompt_for_chain.clone()],
        };
        let caption_text = build_generation_caption(&chain);
        let analysis_parsed = caption::parse(&caption_text);
        let caption_payload = caption::build_payload(
            &caption_text,
            "由生成提示词填充（非反推）",
            session_for_chain.as_deref(),
            &provider_for_meta,
            &analysis_parsed,
        );
        for id in &ids {
            let row = crate::core::library::Analysis {
                id: Ulid::new().to_string(),
                asset_id: id.clone(),
                kind: "caption".to_string(),
                payload: caption_payload.clone(),
                provider: Some(provider_for_meta.clone()),
                created_at: None,
            };
            dbm.insert_analysis(&row)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;

    // caption 落库后通知创作板 @ 池刷新（与反推同机制：analyses://changed → App 重载 promptedAssets；
    // 创作板在生成期间常驻右侧槽，新生成图应即时进 @ 池）。
    for a in &gen_assets {
        let _ = app.emit(
            "analyses://changed",
            serde_json::json!({ "asset_id": a.id, "kind": "caption" }),
        );
    }

    // 后台自动命名（每张生成图各跑一次 codex 看图取名，替代 codex 默认的 ig_<hash>；
    // caption 已由上方按生成 prompt 直填，命名与之独立）。
    for a in gen_assets {
        crate::core::autoname::spawn_auto_name_only(app.clone(), db.inner().clone(), a);
    }

    // 生成图已入库，通知瀑布流刷新（角标/命名到位后 assets-changed 再刷一次）。
    let _ = app.emit("library://assets-changed", ());
    Ok(())
}

/// 取消正在进行的图像生成（`codex_create_image`）。无任务在跑则空操作。
#[tauri::command]
pub async fn cancel_codex_create() -> Result<(), AppError> {
    if let Some(tx) = GENERATE_CANCEL.lock().unwrap().take() {
        let _ = tx.send(());
    }
    Ok(())
}

/// 把生成会话的 prompt 链转成 caption 正文：从中识别 `【维度】：正文` 片段（创作板序列化时由
/// `@图名 的【维度】：section 正文` / 独立 `【维度】：正文` 注入），按 `**维度**\n正文` 段落输出，
/// 正中 caption::parse 的 section 识别 → 详情页按段展示、创作板维度 chips 随之生成。
///
/// 生成图本就由这些维度片段变换得来，无需 AI 反推，只做固定特征解析。同名维度后出现者覆盖
/// （修订版维度优先）；一条都没识别到时回退整段 prompt（caption::parse 作 raw_fallback 整段展示）。
/// prompt 完整原文另存于 generation_meta（详情页「✨ 生成来源」卡片），此处只管维度视图。
fn build_generation_caption(chain: &[String]) -> String {
    let mut dims: Vec<(String, String)> = Vec::new();
    for prompt in chain {
        for (title, body) in extract_dim_sections(prompt) {
            if let Some(slot) = dims.iter_mut().find(|(t, _)| t == &title) {
                slot.1 = body; // 后出现覆盖（修订版维度优先）
            } else {
                dims.push((title, body));
            }
        }
    }
    if dims.is_empty() {
        return chain.join("\n\n"); // 无维度片段 → 整段回退
    }
    let mut out = String::new();
    for (title, body) in &dims {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str("**");
        out.push_str(title);
        out.push_str("**\n");
        out.push_str(body);
    }
    out
}

/// 从一段 prompt 文本里抽 `【标题】：正文` 片段。正文延伸到下一个 `【` 或 `@` 或串尾（下一个维度
/// 或 @图名 引用即正文终点），再按最后一个句末标点（。！？）截断以去掉尾随连接词（如「，以及」）。
/// 标题须通过 `is_valid_dim_title`（与 caption::parse 的 section 标题规则一致），否则当普通 `【】` 跳过。
fn extract_dim_sections(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find('【') {
        let after_bracket = &rest[open + '【'.len_utf8()..];
        let Some(close) = after_bracket.find('】') else { break; };
        let title = after_bracket[..close].trim();
        let after_close = &after_bracket[close + '】'.len_utf8()..];
        let body_rest = after_close
            .strip_prefix('：')
            .or_else(|| after_close.strip_prefix(':'));
        match (is_valid_dim_title(title), body_rest) {
            (true, Some(body_rest)) => {
                let body_end = body_rest
                    .find(|c| c == '【' || c == '@')
                    .unwrap_or(body_rest.len());
                let body = cut_trailing_connector(body_rest[..body_end].trim());
                out.push((title.to_string(), body.to_string()));
                rest = &body_rest[body_end..];
            }
            _ => {
                // 非维度 【】（标题非法或 】 后无冒号）→ 跳过这个括号，从其后继续找。
                rest = after_close;
            }
        }
    }
    out
}

/// 句末标点（。！？）之后的尾随文字多为连接词（如「，以及」「，然后」），截掉。
/// 无句末标点则原样返回（正文可能本就不含句号）。
fn cut_trailing_connector(s: &str) -> &str {
    match s.rfind(|c| matches!(c, '。' | '！' | '？')) {
        Some(idx) => {
            let ch_len = s[idx..].chars().next().map_or(0, |c| c.len_utf8());
            &s[..idx + ch_len]
        }
        None => s,
    }
}

/// 维度标题有效性：非空、≤16 字、不含 ASCII 数字与反引号（与 caption::parse 的
/// `looks_like_section_label` 一致，保证 `**标题**` 能被解析成 section）。
fn is_valid_dim_title(title: &str) -> bool {
    let t = title.trim();
    !t.is_empty()
        && t.chars().count() <= 16
        && !t.chars().any(|c| c.is_ascii_digit() || c == '`')
}

#[cfg(test)]
mod tests {
    use super::*;

    // 用户给的范例（略缩短）：色调 / 光影 是现成维度，其余为 @图名 引用与自由指令。
    const EXAMPLE: &str = "请参考@街头倚坐 的【色调】：整体以暖米色、奶油黄为主。色彩饱和度不高，具有夏日街头的色彩情绪。【光影】：自然日光为主，光线柔和偏散射，没有强烈硬阴影。人物面部曝光均匀。整体对比度中等，带有胶片摄影常见的柔和层次和低锐度边缘。，以及@紫垫白猫.jpg的场景和主体动作，并为猫咪戴上@彩虹宠物项圈广告.jpg中紫色的项圈。";

    #[test]
    fn extract_dims_from_generation_prompt() {
        let dims = extract_dim_sections(EXAMPLE);
        let titles: Vec<&str> = dims.iter().map(|(t, _)| t.as_str()).collect();
        assert_eq!(titles, vec!["色调", "光影"]);

        let palette = dims.iter().find(|(t, _)| t == "色调").unwrap();
        assert!(palette.1.contains("暖米色"));
        assert!(palette.1.ends_with('。'));
        assert!(!palette.1.contains("@"));

        let light = dims.iter().find(|(t, _)| t == "光影").unwrap();
        assert!(light.1.ends_with("低锐度边缘。"), "got: {}", light.1);
        assert!(!light.1.contains("，以及"), "尾随连接词应被截掉");
        assert!(!light.1.contains("@紫垫白猫"), "正文不应吞掉后续 @图名");
    }

    #[test]
    fn build_caption_with_dims_as_sections() {
        let caption = build_generation_caption(&[EXAMPLE.to_string()]);
        assert!(caption.contains("**色调**"));
        assert!(caption.contains("**光影**"));
        // 不应回退成整段（有维度时走分段）。
        assert!(!caption.contains("以及@紫垫白猫"));
    }

    #[test]
    fn build_caption_falls_back_to_raw_when_no_dims() {
        let caption = build_generation_caption(&["把背景改成白天".to_string()]);
        assert_eq!(caption, "把背景改成白天");
    }

    #[test]
    fn later_dim_overrides_earlier() {
        let chain = vec!["【色调】：暖色调".to_string(), "【色调】：冷色调".to_string()];
        let caption = build_generation_caption(&chain);
        assert!(caption.contains("冷色调"));
        assert!(!caption.contains("暖色调"));
        assert_eq!(caption.matches("**色调**").count(), 1);
    }

    #[test]
    fn skips_non_dimension_brackets() {
        // 【...】 后无冒号 → 不当维度，继续找下一个。
        let dims = extract_dim_sections("一段【普通括号】文字【光影】：柔和光线。");
        let titles: Vec<&str> = dims.iter().map(|(t, _)| t.as_str()).collect();
        assert_eq!(titles, vec!["光影"]);
    }
}

/// 「在 codex 中打开会话」：唤起系统终端跑 `codex resume <session_id>`，
/// 让用户在 codex TUI 里翻看本次反推的完整对话（含图）。macOS 用 Terminal.app。
#[tauri::command]
pub async fn open_codex_session(session_id: String) -> Result<(), AppError> {
    let sid = session_id.trim();
    if sid.is_empty() {
        return Err(AppError::Codex("session_id 为空".into()));
    }
    #[cfg(target_os = "macos")]
    {
        // session_id 是 codex 输出的 UUID（我们落库的值），非用户自由输入；
        // osascript 的 do script 把它作为单参传给 `codex resume`，无注入风险。
        let script = format!(
            "tell application \"Terminal\"\nactivate\ndo script \"codex resume {sid}\"\nend tell"
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
            // session_id 是 codex 输出的 UUID，仍按白名单校验防注入；`start "" cmd.exe /K`
            // 经 cmd.exe 另开一个常驻命令提示符跑 `codex resume <sid>`。
            if !sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                return Err(AppError::Codex("session_id 格式无效".into()));
            }
            tokio::process::Command::new("cmd.exe")
                .arg("/D")
                .arg("/C")
                .arg("start")
                .arg("")
                .arg("cmd.exe")
                .arg("/K")
                .arg(format!("codex resume {sid}"))
                .spawn()
                .map_err(|e| AppError::Codex(format!("启动命令提示符失败: {e}")))?;
            Ok(())
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = sid;
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
