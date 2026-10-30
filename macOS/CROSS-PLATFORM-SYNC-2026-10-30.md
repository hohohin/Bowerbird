# 2026年10月30日 Mac 跨端更新说明

本轮汇总远端 `mac@300124daabb6cd85f75e734fc65bf7417fc95463`（10 月 16 日）之后，至本次本地存档的完整源码更新，供 Windows、Intel Mac 及其他接收端按共同祖先合并。**本地存档 `ad6c132` 已获用户确认；推送因 GitHub 拒绝当前凭据而未完成，远端仍为 `300124d`。恢复认证后可继续正常推送。** 本轮不打包、不上传安装包、不部署服务或切换更新通道。

## 基线和接收范围

存档前本地为 `d95eed4`，已包含远端基线，另有 25 个未推送历史提交，以及本次草稿选区、图片粘贴和 Codex 生图参数增量。25 个历史提交包含从 Windows dev 接收的功能及 Mac 合并／适配，不能全部算作 Mac 原创功能。更新包括桌面、扩展、配套 Cloud／Worker／官网源码与历史部署记录；本次推送只同步 Git 内容。

Mac 源码版本仍为 **26.10.1502**，SQLite 从基线 **0034** 增至 **0047**。现成 ARM 1502 安装包来自较早的 `5fecb7c`，不包含本说明新增功能；下次发包需提高版本。当前线上版本以发布系统为准，本次未重新核验官网。

## 用户可见更新

| 范围 | 相对上次 mac 推送的主要变化 |
|---|---|
| 文件和资料 | 文件优先工作区、全局文件聚合、项目目录与 BowerbirdLibrary；文件夹独立分类、随图提示词／分析／标签保存与恢复、资料根迁移、中断恢复和共享文件转存；原文件与托管副本所有权分开处理 |
| 素材库和分类 | 素材分页与虚拟布局、全部／标签／集合及来源筛选、独立多栏浏览、素材抽屉和统一右键操作；Tactical 样式与多选动效；分类来源、规则继承、内部英文规则／缓存、启用后新增素材处理和托管 Jev 分类 |
| 创作和工作流 | 本机 Codex 图文对话、停止与历史、图片／视频／对话独立草稿；受控创建生成／内容／触发／循环卡片，默认不执行生成；按次数循环、完成触发、批量删卡、外部变更合并、异步授权连续编辑修复；内容卡普通文本和媒体自适应 |
| 草稿编辑器 | 新建白底画布与图片重开；画笔／橡皮压感和惯性、独立参数记忆、图层／文字、自由套索与增减选、颜色板、裁剪／扩展、撤销重做、PSD 导出；独立工程保存、同卡更新与失败重试 |
| 生成和视频 | Seedream 模型选择及冻结参数、删除最后一张生成结果时隐藏空会话卡；视频导入／封面／截帧／尾帧／裁剪、视频复刻分析和改写、持久任务及工作流交付；Mac AVFoundation 原生媒体路径 |
| 探索和扩展 | 分类暂存展示、探索页浏览器插件教程／连接状态、扩展 0.2.0 串行采集与逐项回执；保留网页拖图和原生网页边界 |
| 账号和配套 | Bcoin／Pro 门控、账号分区与实际试用回执、积分记录、中文错误展示、微信回跳和后台昵称源码；只读代码 MCP 及使用文档；支付和云端功能沿既有开放边界 |
| Mac 适配 | 系统目录别名归一化、文件颜色缓存、玻璃背景与回退；截图完成／取消归还焦点、贴图不拉起主窗及工具栏跟随；保留 Mac 标题栏、媒体实现、签名和更新公钥 |

## 本次新存档的三项增量

1. **草稿反选和选区边界**：反选按钮及 Cmd／Ctrl+Shift+I，支持空洞和分离区域；全选反选保留显式空选区。黑白蚂蚁线沿闭合轮廓连续显示，缩放时保持屏幕线宽和虚线节奏，减少动态效果时静止。入口为 `DraftEditor.tsx/.css`、`draftSelection.ts`；补入反选和像素边界测试。
2. **外部图片粘贴到画板**：内部卡片协议优先，否则读取首张剪贴板图片，在导入前冻结项目和视口中心，入库后创建画板节点；素材库展开时仍可粘贴，阻止全局重复入库，保留编辑控件／模态隔离和失败重试。入口为 `CanvasWorkspace.tsx`，专项为 `canvas-image-paste-ui.test.mjs`。
3. **Codex 生图默认参数**：未显式覆盖模型时，首轮和原生续轮均使用 `gpt-6-luna`，思考强度 `low`；显式模型覆盖仍保留。修改仅作用于图片生成调用，不调整理解任务和本机对话模型配置。入口为 `src-tauri/src/codex/codex_cli.rs`；真实服务对该模型的可用性和出图质量仍待验收。

## 数据和平台边界

- 本地迁移 **0035–0040**：生成诊断、分类维度／预设、随图队列／指纹、资料迁移回执；**0041–0045**：外部引用显式入库、新素材自动分类、分页索引、分类来源和内部英文缓存；**0046／0047**：本机对话、受控建卡回执与冻结参数。前后端及迁移注册必须配套更新，在资料库副本上验证升级；旧包不可读取已升级的新库。
- **H3 仅接收过早期基线，后续专属增量继续暂缓。** 10 月 22／25／28 日合并保留旧 H3 环境、卡片、端口和结果行为；暂缓创作框首尾帧、自动安装／进度、下载授权等。Git 历史已含相关 dev 父提交不代表实现齐平。其他端合并时必须保留其现有 H3，不能用 Mac 旧文件整段覆盖；恢复时按各轮排除清单显式合并。
- Windows 保留 MSVC／WebView2、私有 CLI、NSIS 登录保留与平台版本；Mac 保留 Apple Silicon／Intel 原生分支、钥匙串、签名、公钥与媒体实现。Windows 不使用 Mac Cargo runner，也不复制 Mac 的版本号或签名配置。
- Cloud 目录含 0062–0076 配套及历史／预留迁移。同步源码不授权重复应用迁移；尤其 **0068 仍为未应用记录**，0076 昵称按远端已部署记录统一去重。发布前读取当前 `apps/cloud/DEPLOY.md`，不能将整个迁移目录直接批量部署。
- 草稿工程随完整资料库保存，随图 sidecar 不能恢复完整图层工程／画板。保存与重试依赖新原生命令，不能仅覆盖前端。

## 验证和待验项

本轮 10 月 30 日针对未提交增量复核：

- 前端纯逻辑 **47/47**：草稿历史、裁剪、选区与画板逻辑。
- **6 组界面回归**：选区像素／轮廓、反选与蚂蚁线、选区操作、外部图片粘贴、媒体导入、表格粘贴，均通过。
- Rust Codex 相关 **39 passed / 1 ignored**，离线编译与假 CLI／临时数据；不代表真实模型调用通过。
- TypeScript 与 Vite production build、最终 diff 空白检查通过；保留既有大 chunk 提示。
- 日志保存在本机 `/tmp/bowerbird-archive-20261030/`，不提交临时截图、缓存和安装产物。

较早完整组合验证沿 [10 月 28 日记录](DEV-SYNC-2026-10-28.md)：Rust 736 passed／18 ignored、ARM64 编译、196 项逻辑、39 组桌面界面及官网／扩展／PGlite；本轮未重新运行这整套，不能将旧结果计作本次全量通过。该记录中的旧循环 `child proceeds independently` 失败仍未修复；临时 CLI 0.153.4 已做假模型协议验证，记录中的系统 CLI 0.146 不满足部分代码通道要求，接收端需自行核对并升级。真实 WKWebView／系统剪贴板／数位板、真实资料升级、登录和付费模型仍待实机验收。

## 其他端接收步骤

1. 等本轮恢复认证并成功推送后，保存接收端工作，运行 `git fetch origin mac`，核对 `git log HEAD..origin/mac` 与差异。按共同祖先普通合并，已从 dev 接收的内容交给 Git 去重。
2. 先核对 H3 暂缓清单及平台配置，再处理共享组件冲突；不要把 Mac 的功能排除反向带回已完成 H3 的分支。
3. 在隔离数据执行迁移、类型／构建与相关回归，重点覆盖文件归属、资料恢复、草稿保存、粘贴失败重试、本机对话建卡及工作流恢复。
4. 另行完成原生运行和发布验收。本次存档已确认，推送待恢复认证；不包含新包发布或官网／Cloud 部署。

分轮实现、平台排除和历史验收见 [10 月 19 日](DEV-SYNC-2026-10-19.md)、[10 月 22 日](DEV-SYNC-2026-10-22.md)、[10 月 25 日](DEV-SYNC-2026-10-25.md)、[10 月 28 日](DEV-SYNC-2026-10-28.md)。项目决策以 `PROJECT.md` 为准。

## 本轮存档前的待推送历史

以下为基线之后尚未出现在远端 mac 的 25 个历史提交；本次新增代码与本文随新的本地存档提交保存。

```text
428d7c1 feat(windows): archive video tools and versioned Mac sync handoff
19ae4cc release(mac): publish Intel 26.10.1501 update channel
eedc71d merge(mac): sync desktop progress through 300124d into Windows dev
2dd1e14 chore: archive current desktop baseline before folder mode
89808c5 feat(desktop): browse folders in workspace with isolated classification
eb3b582 chore: archive file-first workspace and desktop progress
37d6856 chore: archive material workspace and local H3 progress
7e1bba1 fix(mac): sync Windows dev and preserve filesystem alias identity
5e496bf chore: archive catalog canvas and H3 updates
4510ecb fix: archive completion triggers and classification browsing
f98283e chore: archive desktop updates for Windows 26.10.2201
70ad8c1 docs: record Windows 26.10.2201 publication and verification
fcd01e6 merge(mac): sync Windows dev while deferring H3 updates
d6bad0c chore: archive Windows 26.10.2202 catalog and login updates
3602f45 docs: record Windows 26.10.2202 and classification v6 release
4156e8e chore: archive Windows 26.10.2301 video workflows and H3 updates
397d960 docs: record Windows 26.10.2301 CDN publication and verification
fd94849 chore: archive Windows 26.10.2401 media, Bcoin and bilingual installer release
c34c088 docs: record Windows 26.10.2401 and classification v10 publication
691cc8d merge(mac): sync Windows 2401 shared updates while deferring H3
11fb03e chore: archive library panes, tactical styling and account updates
a369e25 chore: archive explorer collection, library and generation fixes
4f371ec chore: archive local chat, controlled canvas cards and interaction updates
46e2d63 chore(mac): archive draft editor, screenshot and account updates
d95eed4 merge(mac): sync dev chat and library updates while deferring H3
```
