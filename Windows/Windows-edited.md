# Bowerbird Windows 适配修改说明

本文记录本仓库 `git clone` 之后，为使 Bowerbird 能在 Windows 上安装、运行并稳定使用浏览器采集与 Codex 功能所做的全部修改。

## 1. 修改范围与组织方式

- 原始项目目录中的源码没有被直接改写。
- 所有手写的 Windows 适配文件都位于根目录 `Windows/`。
- `Windows/prepare.ps1` 会把原项目复制到 `Windows/.work/`，再用 `Windows/overrides/` 中的文件覆盖对应路径。
- `Windows/.work/` 和 `Windows/.cargo-target-*` 是生成目录，不是手写源码。
- `Windows/dist/` 存放最终 Windows 安装包。
- `Windows/extension/` 是供 Chrome / Edge 直接“加载已解压的扩展程序”的独立扩展目录。

## 2. Windows 构建与运行脚本

### `Windows/prepare.ps1`

- 检查 Node.js、pnpm、Rust 和 Cargo 是否可用。
- 强制要求 Rust 使用 Windows MSVC target，避免 GNU/MSVC 工具链混用。
- 使用 `robocopy` 将仓库复制到 `Windows/.work/`。
- 排除 `.git`、`Windows`、`node_modules`、`target`、`dist` 和 `AGENTS.md`，避免递归复制和污染工作目录。
- 将 `Windows/overrides/` 覆盖到临时工作树。
- 支持 `-Clean` 重建工作树。

### `Windows/dev.ps1`

- 自动准备 Windows 工作树。
- 在 `Windows/.work/` 安装依赖并启动 `pnpm tauri dev`。
- 对依赖安装和 Tauri 启动失败给出明确错误。

### `Windows/build.ps1`

- 自动准备 Windows 工作树并安装锁定依赖。
- 默认执行 TypeScript 检查和 Rust 测试。
- 构建 x64 NSIS 安装包。
- 将安装包复制到 `Windows/dist/`。
- 支持 `-Clean` 和 `-SkipTests`。

### `Windows/.gitignore`

- 忽略 `Windows/.work/` 和 `Windows/dist/` 生成内容。

### `Windows/README.md`

- 增加 Windows 环境要求、开发命令、构建命令和常见故障说明。
- 说明 WebView2、Rust MSVC、Visual Studio C++ Build Tools、Codex CLI 和 ffmpeg 等依赖。

## 3. pnpm 在 Windows 上的兼容调整

### `Windows/overrides/package.json`

- 固定 `packageManager` 为 `pnpm@11.10.0`，使 Corepack 和构建环境使用一致版本。

### `Windows/overrides/pnpm-workspace.yaml`

- 将 pnpm 11 的 `allowBuilds.esbuild` 设置为 `true`。
- 允许 esbuild 执行安装阶段的平台二进制准备，避免 Windows 前端构建缺少 esbuild 可执行文件。

## 4. Codex CLI Windows 适配

### `Windows/overrides/apps/desktop/src-tauri/src/codex/codex_cli.rs`

- 新增 Codex 可执行文件解析：
  - 支持 `BOWERBIRD_CODEX_BINARY` 显式指定。
  - Windows 优先查找 `%APPDATA%\npm\codex.exe`、`codex.cmd`、`codex.bat`。
  - 再回退到 `PATH` 中查找。
  - 优先 npm 安装版本，避免误用 WindowsApps 中过旧、无法解析新模型缓存格式的 Codex CLI。
- 新增 `codex_command`：
  - `.cmd` / `.bat` 通过 `cmd.exe /D /S /C` 执行。
  - Windows 子进程使用 `CREATE_NO_WINDOW`，避免弹出空白 CMD 窗口。
- Codex 登录目录支持：
  - `CODEX_HOME`。
  - `%USERPROFILE%\.codex`。
  - 非 Windows 环境继续回退 `$HOME/.codex`。
- Codex JSONL 标准输出改为按字节读取并使用 lossy UTF-8 解码，避免本地代码页字节导致 `stream did not contain valid UTF-8` 后整个生成失败。
- Codex 超时时主动终止子进程，并把 stderr 摘要返回给前端。
- Codex 未生成图片时返回明确错误，并附带文字回复摘要，不再只显示笼统“生成失败”。

### `Windows/overrides/apps/desktop/src-tauri/src/commands/codex.rs`

- Codex 健康检查改用 Windows 可执行文件解析和 Windows 用户目录。
- 修正生成取消句柄的清理位置，保证生成 future 结束时及时移除旧句柄。
- “在 Codex 中打开会话”增加 Windows 实现：打开 CMD 并运行 `codex resume <session_id>`。
- 对 session id 做字符校验，避免把任意字符串拼入命令。

## 5. 浏览器采集通路重构

旧通路是“扩展发送图片 URL → 桌面端使用 reqwest 重新下载”。该设计会丢失浏览器 Cookie、登录状态、页面授权和部分 Referer 上下文。WebSocket 显示“已连接”只能证明心跳可达，不能证明桌面端能访问图片。

新通路是：

```text
网页 content script
  → 扩展 background service worker 使用浏览器会话读取图片
  → WebSocket 发送 save_blob 元数据
  → WebSocket 发送图片二进制帧
  → 桌面端验证真实图片格式
  → 标准入库、生成缩略图、通知前端刷新
```

### `Windows/extension/manifest.json`

- 注册 Manifest V3 `background.js` service worker。
- 保留 `<all_urls>` host permission，使扩展后台可以读取网页图片。

### `Windows/extension/background.js`

- 接收 content script 的 `save_image` 消息。
- 使用 `credentials: "include"` 在浏览器环境中读取图片，保留当前浏览器会话。
- 检查 HTTP 状态、响应 Content-Type 和空响应。
- 先通过 WebSocket 发送 `save_blob` 元数据，再发送 `ArrayBuffer` 二进制图片。
- 增加 60 秒桌面端响应超时。
- 区分浏览器读取失败、非图片响应、桌面端未启动、桌面端提前断开和响应解析失败。

### `Windows/extension/content.js`

- 增加每 15 秒一次的 WebSocket 心跳，使桌面端能显示扩展连接状态。
- 图片保存改为发送消息给 background service worker，不再由 content script 只发送 URL 给桌面端。
- 批量采集改为串行提交，避免同时打开大量本地连接。
- 错误信息直接显示桌面端或扩展后台返回的具体原因。
- 去掉所有采集数量显示；现在只显示“正在采集”“已保存到 Bowerbird”“部分素材采集失败”或具体失败原因。
- 修复单张拖拽显示 `2/2` 的问题：
  - 浏览器拖拽图片时，`text/uri-list` / `text/plain` 往往是外层链接页面 URL。
  - `text/html` 中的 `<img src>` 才是真实图片 URL。
  - 现在优先使用 `<img src>`；只有没有 HTML 图片片段时才回退到 URI 文本。
  - 因此不会再把“页面 HTML + 真图片”当成两张素材。

### `Windows/extension/README.md`

- 更新 Chrome / Edge 加载步骤。
- 说明 `save_blob + 二进制帧` 协议。
- 说明修改扩展后必须在扩展管理页重新加载，并刷新待采集网页。

### `Windows/overrides/apps/extension/`

- 保存与 `Windows/extension/` 功能相同的 `manifest.json`、`background.js`、`content.js`。
- `prepare.ps1` 会将它们覆盖到 Windows 工作树中的原扩展目录。

## 6. 桌面端采集服务与入库修复

### `Windows/overrides/apps/desktop/src-tauri/src/collect/ws_server.rs`

- WebSocket 增加 `save_blob` 协议。
- 文本帧保存图片元数据，紧随其后的二进制帧作为图片内容。
- 未提供元数据却发送二进制时返回明确错误。
- 图片入库成功后统一执行：
  - 启动非阻塞自动命名和基础分析。
  - 发出 `library://assets-changed`，携带 asset id 和名称。
  - 返回 asset id 和名称给浏览器扩展。
- 收到扩展 `ping` 或旧 `save` 请求时发出 `collect://extension-connected`。
- 保留旧 URL 下载协议以兼容旧版扩展，并把页面 URL 作为 Referer 传入。
- 增加 `save_batch` 协议分支：主线扩展（含小红书结构化采集）批量提交 `save_batch`，override 原先只认 `save_blob` 会回 `unknown type`。现在逐项走 URL 下载入库（适用 xhscdn 等公开图床），响应对齐主线 `{ok, saved, total, results}`；`save_blob` 通路保留，按扩展协议自动分流。

### `Windows/overrides/apps/desktop/src-tauri/src/core/ingest.rs`

- 旧 URL 下载器增加：
  - 45 秒超时。
  - Windows Chrome User-Agent。
  - 图片 Accept 请求头。
  - 当前页面 Referer。
  - 更完整的错误链输出。
- 新增 `ingest_from_bytes`：
  - 接收浏览器上传的真实图片字节。
  - 使用临时目录进入原有 probe、缩略图、dHash、提色和数据库入库流程。
  - 入库后写入 `source=extension` 和原始 `source_url`。
  - 清理临时文件。
- 不再相信 URL 后缀、文件名或 Content-Type 来决定光栅图片格式；以图片魔数和实际解码结果为准。
- 支持 JPEG、PNG、WebP、GIF、BMP 和经检查的 SVG。
- HTML、空内容、伪造 SVG、未知格式和无法解码的内容会直接拒绝，不会生成数据库记录或不存在的缩略图路径。
- 该校验修复了 App 中显示为破图 `extension-image` 的问题。实际排查确认旧破图文件内容以 `<!DOCTYPE html>` 开头，是被误收集的网页 HTML，不是真图片。
- 增加三项回归测试：
  - 浏览器上传的 PNG 字节可以正常入库。
  - 文件名无扩展名且元数据不可靠时，WebP 仍按真实字节识别并生成缩略图。
  - HTML 响应被拒绝，资产数量保持为 0。

## 7. 桌面端新用户体验与采集可见性

> **2026-07-20 更新**：本节所述四个前端 override（`store.ts` / `App.tsx` / `Toolbar.tsx` / `WelcomePanel.tsx`）已**删除**，其差异化功能（扩展连接状态 `extensionConnected`、采集提示 `collectedNotice`、环境状态面板）已并入主项目源码（`apps/desktop/src/store.ts` / `App.tsx` / `components/SettingsDialog.tsx` / `Toolbar.tsx`）。
> 原因：主项目 store 演进（presets / colorRebuild 进 store / 删 boardPickMode / startGeneration 改签名）后，整文件覆盖式 override 与主项目分叉，导致 `.work` 里「主项目新组件 + override 旧 store」类型对不上、`tsc` 失败。codex / ingest 等 Rust override 不受影响、保留；ws_server override 因主线新增 `save_batch` 协议曾导致小红书采集报 `unknown type`，已在 override 侧补齐 `save_batch` 分支（见 §6）。

### `Windows/overrides/apps/desktop/src/App.tsx`

- 空素材库时显示新的首次使用面板，不再用 Codex 配置遮罩阻止进入应用。
- 监听扩展连接事件并写入全局状态。
- 监听采集入库事件，保存最近采集素材名称。
- 保持当前列表刷新逻辑，使扩展采集后素材能够进入 App 数据状态。

### `Windows/overrides/apps/desktop/src/store.ts`

- 新增 `extensionConnected` 状态及 setter。
- 新增 `collectedNotice` 状态及 setter。

### `Windows/overrides/apps/desktop/src/components/WelcomePanel.tsx`

- 新增空库首次任务引导：
  - 导入本地文件或文件夹。
  - 安装浏览器扩展。
  - 配置 Codex AI。
- 明确素材库功能不依赖 Codex，AI 是可选增强。

### `Windows/overrides/apps/desktop/src/components/Toolbar.tsx`

- 增加“环境状态”面板，显示：
  - Codex 是否安装和登录。
  - 浏览器扩展是否通过心跳连接。
  - 后台自动分析是否运行。
- 扩展采集成功后显示最近采集素材提示。
- 点击提示会清除文件夹、收藏夹、搜索、智能筛选和颜色筛选，回到总库查看新素材。
- 顶部状态同时显示后台分析数量。

## 8. 生成目录与交付产物

### `Windows/.work/`

- 由 `prepare.ps1` 生成的完整 Windows 临时工作树。
- 可以删除并重新生成，不应作为手写源码维护。

### `Windows/.cargo-target-blob/`

- Cargo 测试和 release 构建缓存。
- 可以删除；删除后下一次构建会重新编译依赖。

### `Windows/dist/Bowerbird_0.1.0_x64-setup.exe`

- 当前 Windows x64 NSIS 安装包。
- 最后构建时间：2026-07-20 16:06:58（Asia/Shanghai）。
- 文件大小：3,660,865 bytes。
- SHA-256：`6CD2331FB9D5B9A29F5A8A184863341F4C01186F2E7892140668FFEF94E6F24D`。
- 安装器、卸载器与应用本体均使用新的 Bowerbird Logo；安装包尚未做 Authenticode 代码签名。

## 9. 验证结果

- 插件 `content.js` 和 `background.js` 已通过 `node --check`。
- 两份扩展 Manifest 均可正常解析。
- TypeScript `pnpm lint` 通过。
- Windows 覆盖工作树 Rust 测试：52 项通过，0 项失败（2026-07-20 重新验证）。
- Tauri release 构建成功。
- NSIS 安装包生成成功。
- 本机实际故障文件检查确认：旧 `extension-image` 破图对应的 `.jpg` 实际内容是 HTML；同一次拖拽的另一条 `.webp` 才是真图片，验证了原 `2/2` 的根因。

## 10. 使用和升级注意事项

1. 桌面端源码和扩展协议同时修改，升级时必须同时更新两部分。
2. 完全退出旧 Bowerbird 后运行 `Windows/dist/Bowerbird_0.1.0_x64-setup.exe`。
3. 在 `chrome://extensions` 或 `edge://extensions` 中重新加载 `Windows/extension/`。
4. 刷新待采集网页，让新的 content script 生效。
5. 旧版本已经误入库的 `extension-image` HTML 记录不是真图片，无法恢复；为避免擅自删除用户库数据，本次没有自动清理，可在 App 内手动删除。
