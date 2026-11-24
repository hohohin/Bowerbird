# 2026 年 11 月 24 日 Mac 跨端存档说明

| 范围 | 基线 |
|---|---|
| 远端 `origin/mac` | `300124daabb6cd85f75e734fc65bf7417fc95463`，10 月 16 日存档。11 月 24 日通过远端引用复核 |
| 本轮源码及验收记录 | `ac3d2e6a38fa64d90028202ac7f77227aa8d1165` 冻结 ARM 包源码，`3a1442a1` 记录测试包与 R2 回执 |
| 已合入的共享开发线 | `dev@0d044e83017f42d1c6464434ca01939d39c49815`，包含 Windows 26.11.2402 发布源码 `7ce371ee0` |
| 基线后的累计范围 | `300124da..3a1442a1` 含 278 个提交、2,957 个文件的净变更。其中 262 个提交在上述 dev 历史内，16 个在 Mac 分支历史内。本说明及索引另以一个文档提交归档 |
| 交付范围 | Git 源码、迁移、测试、合成夹具、专项说明及历史记录。安装包和校验文件已在 R2 独立测试目录交接，本机原始日志在 `macOS/dist/verification/26.11.2403-aarch64/` |

## 自上次推送以来的更新

| 范围 | 完整区间内的主要变化及详细入口 |
|---|---|
| 文件工作区与素材库 | 文件优先工作区、全局文件、项目目录及随图资料恢复。连接真实目录，管理集合、分身、外部引用、离线原件、回收与重连。后续补齐增量扫描、预览版本与目录范围缓存、路径索引、常驻侧栏、项目折叠、标签导航、分页和多栏浏览。 [文件工作区](../dev-doc/FOLDER-MODE.md) · [目录性能回执](../project_logs/2026-11-23-folder-library-performance.md) |
| 分类、搜索和图片 | 划分分类规则、来源及内部英文缓存，接入托管 Jev 补标签并保护人工结果。新增常用／固定素材、HEIC／HEIF、独立 SigLIP2 语义索引。Mac 修复原件目录系统路径别名导致的索引失效漏刷，使用 Core Image 管理 P3／PQ 等 HEIC 预览颜色，JPEG 缩略图转换到 sRGB。 [分类](../dev-doc/LOCAL-CLASSIFICATION.md) · [HEIC 与目录](../dev-doc/FOLDER-MODE.md) |
| 项目、画板和工作流 | 项目内创作线程、视口恢复及重项目首屏优化，工业制图样式和投影 HUD。生成组图可拆分重组，折叠卡结果预览随锚点移动，素材与结果支持缩放及媒体选择。补齐批量连线、完成／手动／每天／指定时间触发、循环、分区受控建卡、图片中继、取消与原单恢复。 [项目画板](../dev-doc/PROJECT-CANVAS-PLAN.md) · [工作流](../dev-doc/CANVAS-WORKFLOW.md) |
| 草稿、截图和标注 | Mac 草稿原位编辑与保存、画笔／橡皮、图层、套索反选和轮廓、颜色、撤销、PSD 与外部图片粘贴。接入共享素材侧栏供草稿选图。截图保留 Mac 焦点归还，接收历史、标注、浮动工具栏及截图发往画板。截图和图片共用画笔及可编辑文字标注。 [草稿](../dev-doc/DRAFT-EDITOR.md) · [标注复用](../dev-doc/reuse/ANNOTATION.md) |
| 写作和办公文件 | 连接文本、DOCX 和表格原件，Plate 编辑、文档卡、段落 Agent、同一写作工具入口及 Cloud 增量预览。富文本草稿异步保存与恢复、自定义选区工具栏、A4 矢量 PDF 分页导出。 [文本和办公](../dev-doc/TEXT-LIBRARY.md) |
| 音频、视频和生成 | 统一播放器、波形、转录逐字定位和音视频裁剪，外部原件支持另存，覆盖后刷新画板与预览并失效旧转录。补齐视频信息、封面、截帧、音轨提取、复刻分析与改写、音频参考、声音录音克隆和 HyperFrames 工作流。接收 H3 提示词优化／卡片／参考及投递更新、Seedream 5.5 和个人订阅路由。 [音频](../dev-doc/AUDIO-LIBRARY.md) · [视频](../dev-doc/VIDEO-MEDIA.md) · [声音](../dev-doc/VOICE-STUDIO.md) · [H3](../dev-doc/COMFYUI-LOCAL-VIDEO.md) |
| 探索、浏览器和快速交付 | 扩展从旧采集流程升级至 0.5.2，带当前项目目标及采集入画板。探索接收 Pinterest、图搜和小红书媒体采集、独立浏览记录及视频下载。新增 LocalSend 浏览器收发、原件持久化与跨应用拖出，保留 Mac WKWebView 遮罩坐标和本机拖放接缝。 [探索](../dev-doc/EMBEDDED-BROWSER.md) · [扩展](../apps/extension/README.md) · [快传](../dev-doc/QUICK-TRANSFER.md) · [外拖](../dev-doc/EXTERNAL-DRAG.md) |
| 对话与 Agent | 桌面统一对话、Agent 卡片、会话待答与恢复，提供本机 Codex、本机 DSH 及 DSH · Cloud v2。首轮按卡和请求隔离，旧 Cloud 单据按原身份恢复。异步 Agent Run 复用统一 Harness 和 Tool Gateway。Mac 保留本机生图默认参数、会话诊断剪贴板、本地凭据与签名接缝。 [桌面对话](../dev-doc/CHAT-PROVIDERS.md) · [Cloud 对话](../apps/cloud/CHAT.md) · [Harness](../dev-doc/UNIFIED-AGENT-HARNESS-PLAN.md) |
| 账号、云端与官网 | 同步 Bcoin 账本与门控、注册及 Pro 赠币、微信订单／回调／补偿／退款、支付宝订阅候选、统一网关与原请求恢复、Worker 取消与正文限额、计量结算与过期清理、转录试跑、素材库画面分析关闭态候选。包含 Cloud 0062–0101 源码迁移及其历史部署回执，候选与生产生效情况以部署记录为准。 [Cloud 部署](../apps/cloud/DEPLOY.md) · [网关](../dev-doc/CLOUD-TRANSPORT.md) · [项目当前状态](../PROJECT.md#源码发布与部署) |
| 代码只读 MCP | 接收 GPT／Gemini 共用脱敏快照、Gemini OAuth、刷新与授权保全，以及 Windows PowerShell 更新脚本。Mac 回环启动与既有配置兼容，冻结候选的两套配置在 Node 24 环境验证。 [MCP](../apps/code-reader-mcp/README.md) |
| 桌面更新与发行 | 顶栏后台下载、验签后点击安装、保存画板与重启；Windows 保留 NSIS 更新登录契约。Mac 发布脚本支持正式签名、公证与 TOS 不可变上传，本轮候选使用原 updater 公钥和既有本地证书，在独立 R2 测试目录交付。文档含公开 Windows 版本发布、跨端接收、回退及安装验证记录。 [桌面更新](../dev-doc/DESKTOP-UPDATES.md) · [Mac 候选回执](RELEASE-READINESS.md) |

## 各轮接收与平台差异

| 日期 | 本机归档及主要边界 |
|---|---|
| 10 月 16–30 日 | 文件优先工作区、分页、分类、工作流、Mac 草稿和截图。SQLite 从远端 Mac 源码 0034 到 0047。多轮合并暂缓专属 H3 增量。10 月 30 日曾批准当时的范围，GitHub 拒绝写入凭据。 [10 月 30 日汇总](CROSS-PLATFORM-SYNC-2026-10-30.md) |
| 10 月 31 日 | 合入 `d78475d`，接收工业主题、HEIC、分区建卡和图片中继。SQLite 0047，H3 暂缓。 [10 月 31 日](DEV-SYNC-2026-10-31.md) |
| 11 月 3 日 | 合入 `cbf6893`，连接式素材库、文本工作区、媒体、快传和拖出。SQLite 0050，H3 暂缓。 [11 月 3 日](DEV-SYNC-2026-11-03.md) |
| 11 月 6 日 | 合入 `bceb903`，投影 HUD、定时和自动连线、视频 Skill、标注、支付源码。SQLite 0052，修复 Mac 浏览器遮罩，H3 暂缓。 [11 月 6 日](DEV-SYNC-2026-11-06.md) |
| 11 月 19 日 | 合入 `325f446f`，接收后续媒体、Agent、本机 DSH、办公文件及 H3 共享源码。保留草稿和诊断等 Mac 接缝，恢复本机 Gemini MCP 实现。 [11 月 19 日](DEV-SYNC-2026-11-19.md) |
| 11 月 24 日 | 合入 `0d044e83`，补齐以文搜图、目录扫描、音频和画板、写作与 PDF、更新交互及 H3 新增量。Mac 源码 **26.11.2403**，SQLite **0062**，修复系统路径别名、HEIC 颜色与独立原生测试例程。 [候选自测](RELEASE-READINESS.md#候选回执) |

- **Apple Silicon** 使用 WKWebView、AppKit、钥匙串、AVFoundation／Core Image。Tauri 与 Cargo 版本为 26.11.2403。Mac updater 公钥沿用 `tauri.macos.conf.json` 中的原值。客户端本机语义搜索支持 Apple Silicon macOS 14 及以上，模型与运行库需按专项准备。
- **Intel Mac** 保留独立更新架构和既有原生构建入口。本轮按用户确认跳过 Intel 构建、运行与升级验收。以文搜图的模型包源码仅列出 Apple Silicon macOS 与 Windows x64。
- **Windows x64** 接收时沿用目标分支的 Windows 版本、NSIS、MSVC、WebView2、FFmpeg／媒体回退和 Windows updater 配置。先按共同祖先合并并核对接收方已经具备的 H3、安装及媒体行为，再处理共享 UI 与平台接缝。
- **数据** 桌面源码区间新增 SQLite 0035–0062，含文件归属、资料库身份、对话／会话、语义索引及连接扫描。Git 基线源码为 0034，实际公开 ARM 26.10.801 安装归档为 0033。接收端应在各自真实旧版的独立库副本验迁移和恢复。Cloud 迁移、配置及现役版本应按各自发布回执核对。

## 验证回执及待验项

| 检查 | 结果 |
|---|---|
| 早期分轮验证 | 10 月 31 日 ARM Rust 778 通过、19 忽略，42 组隔离前端通过；11 月 3 日 1,035 通过、21 忽略，43 组浏览器专项通过；11 月 6 日 1,072 通过、23 忽略，32 组浏览器专项通过。分别详见上表原回执。11 月 19 日类型、Vite 及 Rust library／binary／tests 检查通过，独立例程缺依赖在 11 月 24 日修复 |
| 最终 ARM 26.11.2403 | macOS 27.2.1、Rust 1.97.1（`aarch64-apple-darwin`），锁定依赖安装、lint、生产前端和 `cargo check` 通过。最终 `cargo test --locked` 为 **1427 通过、0 失败、55 忽略**。对话逻辑 67/67、扩展 35/35、HEIC 7/7、MCP 32/32。画板逻辑 141/150，9 项失败在原始 dev 重现，页面专项另验证画板图片与批删 |
| 包内迁移与媒体 | 最终 DMG 工具两次运行 0033 → 0062，目录、素材、画板和历史数据保留，完整性及外键检查通过。系统 WKWebView 合成页通过可信点击、遮罩和媒体播放。五种音频格式通过选区时间点检查，画板音频覆盖后刷新。Plate 输出 5 页 A4 PDF，合成 P3／PQ 验证 SDR 颜色 |
| DMG、签名与 R2 | 本地证书严格校验、原 Mac updater 公钥验签，660×400 布局、Applications 链接，归档与挂载 app 的 85 个文件逐字节一致。R2 隔离目录 7 个对象均完成公网全字节、SHA-256 及更新归档签名核对。Apple 公证和离线权益宽限验签待配置 |
| 发布与原生待验 | 旧客户端的真实用户库／登录态与干净账户应用内升级、实际网站跨 WebView 拖图、Finder 投递、外盘拔插、真实 HDR 屏幕及专用账号 DSH · Cloud v2 恢复待实机。公开通道、正式签名与交付见现有发布手册 |

[ARM 安装候选、完整哈希和 R2 回执](RELEASE-READINESS.md#安装包与更新归档) · [Windows 发布验证和通道](../dev-doc/DESKTOP-UPDATES.md)

## 核对提交和文件

以下命令以不可变提交标识列出完整源码区间。本说明随本轮归档提交追加。

```bash
git log --reverse --topo-order --format='%h %as %s' 300124da..3a1442a1
git log --reverse --first-parent --oneline 300124da..3a1442a1
git diff --name-status 300124da..3a1442a1
git diff --stat 300124da..3a1442a1
```

接收端可在推送确认后抓取 `origin/mac`，按共同祖先合并并保留独有工作，再使用对应平台的构建和隔离验收流程。H3 历史暂缓范围及恢复进度按上表对应阶段核对。
