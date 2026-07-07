# 详情页「反推」面板待优化清单

> 评审时间：2026-07-07
> 范围：图片详情页「拆解 · 描述 / 反推」区域，代码见 [AssetDetail.tsx](apps/desktop/src/components/AssetDetail.tsx#L271-L401) + 后端 [codex.rs](apps/desktop/src-tauri/src/commands/codex.rs#L96-L145)。
> 现状回顾：反推走 codex CLI（`codex exec --image`，ChatGPT 订阅认证，真正看图）；结果落 `analyses(kind=caption)`，payload 已是结构化 JSON（`text/instruction/session_id/sections/dimensions/parse_status`），并支持「在 codex 中打开」会话回看。

> **进度（2026-07-07）：P0 已完成。** ① 结果管理：caption 卡片加 **时间戳 + 指令摘要 + 删除**（新增 `delete_analysis` 命令，DB 方法早已存在），多条时**最新默认展开、其余折叠**为摘要行（▾/▸ 可切换）；② 取消与耗时：反推中显示 **已耗时（秒）+ 取消按钮**，后端 `codex_describe_asset` 改 `tokio::select!`，`kill_on_drop(true)` 兜底 kill 子进程，新增 `cancel_codex_describe` 命令；前端识别「已取消」静默处理。验证：`cargo test` 17 项全过、`tsc --noEmit` 通过（取消的真机流程待 `pnpm tauri dev` 实测）。
>
> **P1 亦完成（2026-07-07）**：③ 术语统一为「反推」（板块标题等）；④ 折叠态始终显示「当前指令」一行预览，编辑不再立即污染默认（改为显式「保存为默认」按钮，临时试一句不影响下次默认）；⑤ codex 不可用时反推按钮置灰并显示原因（新增 `codex_health` 命令：`codex --version` + `~/.codex/auth.json` 存在且非空，对应约定 7）；⑥ 回退文案去掉「caption」内部术语、改为中性引导。验证：`cargo test` 17 项全过、`tsc --noEmit` 通过、未新增 warning。P2 待办。

---

## P0 — 每次用都会踩的硬伤 ✅ 已完成（2026-07-07）

### 1. 多次反推结果无脑堆叠，无法区分、无法清理
- **现状**：后端 [codex_describe_asset](apps/desktop/src-tauri/src/commands/codex.rs#L121-L143) 每次反推都 `insert_analysis` 一条新 caption；前端 [AssetDetail.tsx:209](apps/desktop/src/components/AssetDetail.tsx#L209) 把 `kind==="caption"` 全部平铺渲染。反推 3 次后右侧栏被几张差不多的卡片塞满。
- **缺的信息**：卡片没有时间戳、没有「这次用的什么指令」。讽刺的是 payload 里已存了 `instruction`（[codex.rs:125](apps/desktop/src-tauri/src/commands/codex.rs#L125)），前端 [parseCaptionPayload](apps/desktop/src/components/AssetDetail.tsx#L77-L109) 根本没取、没渲染。
- **缺的操作**：[api.ts](apps/desktop/src/lib/api.ts) 没有 `deleteAnalysis`，旧结果删不掉。
- **建议**：① 前端解析并展示 `instruction` + `created_at`（`Analysis.created_at` 字段已存在）；② 新增 `delete_analysis` 命令，卡片加删除；③ 考虑默认只展开「最新一条」，其余折叠为摘要。
- **涉及**：前端 AssetDetail.tsx、types.ts、api.ts；后端 commands/library.rs（或 codex.rs）+ core/library.rs。

### 2. 反推很慢，但无进度、无取消、无流式
- **现状**：codex CLI 走 ChatGPT 订阅 + 国内 WS reset 自动回退 HTTPS，「慢但成功」（见 PROJECT.md 踩坑）。前端 [describe()](apps/desktop/src/components/AssetDetail.tsx#L181-L197) 走一次性 `await api.describeAsset`，按钮只变「反推中…」，用户干等几十秒、不知道还要多久、不能取消。
- **关键点**：项目**已有流式能力** [codex_run_stream](apps/desktop/src-tauri/src/commands/codex.rs#L45-L60)（Phase 3 给 ClaudeCode 用的 `codex://chunk` event），反推这条路完全没用上。
- **建议**：① 最小版——反推期间显示已耗时 + 「取消」按钮（前端 AbortController + 后端可取消的子进程，约定 5 要求 codex 调用走独立 Worker、可取消）；② 进阶——复用 `codex://chunk`，反推结果边出边显。
- **涉及**：前端 AssetDetail.tsx；后端 codex_describe_asset 改为可取消 / 流式（CodexCliProvider 已有 `run_stream`）。

---

## P1 — 顺手就该改 ✅ 已完成（2026-07-07）

### 3. 术语三套，认知负担
- **现状**：板块标题「拆解 · 描述」、按钮「反推」、状态「反推中…」、存储叫 caption / analyses，同一件事三个词。「反推」对非技术用户也偏黑话。
- **建议**：统一成一个动词（如「描述」或「分析」），全链路（标题 / 按钮 / 状态文案 / 注释）一致。
- **涉及**：AssetDetail.tsx 文案。

### 4. 「修改反推指令」两步操作，且当前指令不可见
- **现状**：textarea 默认折叠（[AssetDetail.tsx:296](apps/desktop/src/components/AssetDetail.tsx#L296)），用户不知道当前在用什么指令就得先点开；改完还要再点「反推」。更别扭的是编辑「立即保存并作为下一次默认指令」（[AssetDetail.tsx:305](apps/desktop/src/components/AssetDetail.tsx#L305)），用户想临时试一句也会污染默认值。
- **建议**：① 当前指令始终可见（哪怕只是一行摘要 / placeholder）；② 区分「临时试一句」与「设为默认」；③ 或把指令选择做成下拉（历史 + 默认 + 自定义），减少打字。
- **涉及**：AssetDetail.tsx 交互。

### 5. codex 未登录不置灰（违反约定 7）
- **现状**：空状态文案写着「需本地 codex login」（[AssetDetail.tsx:343](apps/desktop/src/components/AssetDetail.tsx#L343)），但只是句提示，按钮照样亮。用户点了才报错。
- **建议**：反推按钮在未检测到 codex 登录时置灰 + 提示原因（对应关键约定 7「离线/无账号降级置灰」）。需要先恢复一个轻量的 codex 可用性探测（之前 `codex_health` 已被删，可考虑复用 codex CLI 的 `--version` / login 状态）。
- **涉及**：前端 AssetDetail.tsx；后端补一个轻量健康检查命令。

### 6. 回退提示是给开发者的诊断文案
- **现状**：[AssetDetail.tsx:368-372](apps/desktop/src/components/AssetDetail.tsx#L368-L372) 直接把 `parseStatus === "raw_fallback"` 翻译成「本次反推未识别出维度片段…」给终端用户看，偏技术。
- **建议**：对用户隐藏 `parse_status` 内部值，只在「未识别出维度」时给一句中性引导（如「没有分段，可作为整段描述使用，或调整指令重试」）。
- **涉及**：AssetDetail.tsx 文案。

---

## P2 — 可以后做（取决于创作板进度）

### 7. 反推结果只能看，不能用
- **现状**：反推出的 caption 是创作板维度下拉的数据源（关键约定 10），但详情页这里零衔接——没有复制、没有「存为这张图的 desc 提示词」、没有「送到创作板」。
- **建议**：caption 卡片加复制按钮 + 「存为提示词（desc 角色）」（复用 `create_prompt` + `link_prompt`）。
- **涉及**：AssetDetail.tsx；与创作板（CreationBoard.tsx）落地时一并设计。

### 8. 反推指令全局共用，无单图记忆
- **现状**：[describePrompt](apps/desktop/src/components/AssetDetail.tsx#L145) 存全局 localStorage，所有图共用一条。人像图想反推「人物动作」、风景图想反推「构图」，得反复切换，且找不回「这张图上次用的指令」。
- **建议**：指令记忆按 asset 粒度（或至少在历史里标出「本图用过」）。
- **涉及**：AssetDetail.tsx；存储键设计。

### 9. 视频能否反推未验证
- **现状**：[isVideo](apps/desktop/src/components/AssetDetail.tsx#L50-L52) 只管预览切换，反推按钮对视频一样亮，但 `codex exec --image` 对视频是否支持未验证，大概率失败。
- **建议**：验证 codex CLI 对视频帧的接受情况；不支持则对视频置灰反推 + 提示，或自动抽首帧。
- **涉及**：AssetDetail.tsx；可能需要 media 层抽帧。

---

## 建议执行顺序
1. 先做 **P0-1**（结果管理：时间戳 + 指令 + 删除）和 **P0-2 的最小版**（取消 + 已耗时）——这俩是体验硬伤。
2. **P1（3/4/5/6）** 顺手一起改，成本低。
3. **P0-2 进阶（流式）** 改动稍大，单独一步。
4. **P2** 等创作板（CreationBoard.tsx）落地时一并处理。
