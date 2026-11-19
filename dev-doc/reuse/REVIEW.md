# 复用地图：覆盖与核验

[返回主索引](../Bowerbird开发计划.md#复用地图) · 首次核验：2026-11-03；维护复查：2026-11-06

本轮以当前本地工作区为准，包含此前已有的未提交源码；不代表公开安装包或线上服务状态。地图补充现有架构入口，视觉规则继续由 [UI-DESIGN-SPEC](../UI-DESIGN-SPEC.md) 维护，产品决定继续由 [PROJECT](../../PROJECT.md) 维护，不复制另一套规范。

## 状态怎么读

| 状态 | 含义 |
|---|---|
| 可跨模块复用 | 已找到公开入口及真实调用；只在条目标明的运行时、身份和宿主条件内复用，不代表跨应用通用包 |
| 模块内部专用 | 可以参考职责和接入方式；不要从其他板块直接导入私有实现，即便函数带 `export` 或 Rust `pub` |
| 待提取候选 | 已见重复职责，但尚无适合跨模块调用的接口；本轮不提取、不合并 |
| 已明确废弃 | 仅在源码或现行协议有明确退出证据时使用；旧文件、少量调用或名称带 legacy 均不足以判定 |
| 尚待确认 | 接口边界或行为等价证据不足；先补查，不宣称标准实现 |

本轮没有把任何实现判为“已明确废弃”。历史兼容入口和隐藏功能不能据此删除。每项的状态不等于上线／验收状态。

## 业务板块与覆盖深度

| 板块与实际入口 | 本轮覆盖 | 未展开部分 |
|---|---|---|
| 应用壳、首页与设置：[App.tsx](../../apps/desktop/src/App.tsx)、[HomeWorkspace.tsx](../../apps/desktop/src/components/HomeWorkspace.tsx)、[SettingsDialog.tsx](../../apps/desktop/src/components/SettingsDialog.tsx) | 主题加载、通用控件、弹层、保活、通知及状态边界 | 设置的每个业务选项、更新／引导全链路 |
| 素材库／集合／多栏：[CategorizedLibrary.tsx](../../apps/desktop/src/components/CategorizedLibrary.tsx)、[ConnectedCollections.tsx](../../apps/desktop/src/components/ConnectedCollections.tsx) | 身份、选择、拖动、虚拟布局、预览、独立栏状态 | 每种筛选组合、目录扫描和跨设备恢复全部分支 |
| 项目／画板／创作：[CanvasWorkspace.tsx](../../apps/desktop/src/components/CanvasWorkspace.tsx)、[CreationBoard.tsx](../../apps/desktop/src/components/CreationBoard.tsx)、[GenerationPanel.tsx](../../apps/desktop/src/components/GenerationPanel.tsx) | 共用创作输入、草稿、项目恢复、生成模型入口与交互适配 | 全部工作流节点、规划器／调度器／撤销状态机和历史协议迁移 |
| 详情／媒体／文本：[AssetDetail.tsx](../../apps/desktop/src/components/AssetDetail.tsx)、[TextWorkspace.tsx](../../apps/desktop/src/components/TextWorkspace.tsx)、[ScreenshotWindow.tsx](../../apps/desktop/src/components/ScreenshotWindow.tsx) | 标注核心、媒体预览、文档与创作编辑器区别 | 图层工程／PSD、视频剪辑、分类推理及全部编码格式 |
| 本机后端：[lib.rs](../../apps/desktop/src-tauri/src/lib.rs)、[commands](../../apps/desktop/src-tauri/src/commands/)、[media](../../apps/desktop/src-tauri/src/media/) | IPC 注册、provider、权益、原件与 FFmpeg 入口 | 所有数据库迁移、原生平台分支、安装签名与真实磁盘副作用 |
| 云控制面／执行：[functions](../../apps/cloud/supabase/functions/)、[agent-worker/src](../../apps/agent-worker/src/) | 认证／错误／计费边界、工具网关和 renderer 接入 | 全部 Edge Function、SQL/RLS、每个 provider 和历史 Agent 协议 |
| 网页采集与官网：[extension/manifest.json](../../apps/extension/manifest.json)、[website/server.mjs](../../website/server.mjs) | 扩展原生脚本加载与本机桥接、官网代理／错误边界 | 扩展所有候选提取算法、官网两版编辑器和后台 UI 全量复用审查 |
| 独立 HTML renderer：[main.ts](../../apps/html-renderer/src/main.ts) | 作为 Worker 调用的隔离服务定位 | Chromium 内部资源策略、渲染实现的完整安全与性能审查 |

检索跨越业务目录、`lib`、Rust commands/media/codex、Edge `_shared`、Worker harness 和独立 JS 应用；不是只遍历公共目录。排除依赖目录、构建输出、生成 bundle、`.tmp`、冻结预览／旧版备份、实验产物作为推荐实现；测试／fixture 只作为验证线索，不作为生产调用证据。未对所有私有函数建索引，也未据目录名将所有 `spikes` 判为废弃。

## 多实现与后续建议

这些是下一轮可选工作，不是本轮重构授权。除已注明的公共入口外，不推荐从另一业务组件导入其内部函数。

| 能力／状态 | 源码与实际使用证据 | 区别与建议 |
|---|---|---|
| 解析素材色板 JSON；关键词 `parseColors`、颜色；**可跨模块复用** | [assetColors.ts](../../apps/desktop/src/lib/assetColors.ts) 导出 `parseColors`，由 [AssetDetail.tsx](../../apps/desktop/src/components/AssetDetail.tsx) 与 [MasonryGrid.tsx](../../apps/desktop/src/components/MasonryGrid.tsx) 调用 | 2026-11-06 已提取原有同构解析；仅保留字符串数组项，不添加颜色校验或通用 JSON 抽象。入口与边界见 [桌面地图](DESKTOP.md) |
| Shift 范围选择；关键词 `selectCatalogItem`、`selectionVersion`；**待提取候选** | [catalogSelection.ts](../../apps/desktop/src/lib/catalogSelection.ts) 仅负责单项增删与多选状态；[CategorizedLibrary.tsx](../../apps/desktop/src/components/CategorizedLibrary.tsx) 和 [ConnectedCollections.tsx](../../apps/desktop/src/components/ConnectedCollections.tsx) 的 `select` 各自处理分页范围 | 前者为 Asset ID，后者为目录 entry ID，分页源和失效保护必须保留。先复用现有单项入口；范围算法是否提取需另外验证身份与异步取消，不能宣称整个 Shift 逻辑已经共用 |
| Agent v3 任务授权契约；关键词 `TaskAuthorization`、`parseTaskAuthorization`；**模块内部专用（各端契约）** | Cloud [_shared/task-authorization.ts](../../apps/cloud/supabase/functions/_shared/task-authorization.ts) 与 Worker [contracts/task-authorization.ts](../../apps/agent-worker/src/contracts/task-authorization.ts) 分别由 [_shared/unified-agent-plan.ts](../../apps/cloud/supabase/functions/_shared/unified-agent-plan.ts) 与 [adaptive-tool-gateway.ts](../../apps/agent-worker/src/harness/adaptive-tool-gateway.ts) 消费 | 2026-11-06 增加 [一致性检查](../../apps/agent-worker/src/contracts/task-authorization-sync.test.ts)，统一换行后比较完整源码，保持独立运行时。共享源提取仍为候选，不跨应用导入生产实现 |
| 菜单定位／键盘／弹层；**尚待确认** | [UI 地图](UI.md) 的普通选择器、专用选择器和 portal 条目 | 普通 listbox、比例图形及模型／报价面板有不同语义；`ModalShell`／`ContextMenu` 已用局部 portal 宿主，部分选择器仍挂 body。可审查基础定位与宿主接口，不据相似外观合并整个控件 |
| 多媒体缓存／队列；**尚待确认** | [filePreviewQueue.ts](../../apps/desktop/src/lib/filePreviewQueue.ts)、[audioPreviewPeaks.ts](../../apps/desktop/src/lib/audioPreviewPeaks.ts)；调用见 [桌面地图](DESKTOP.md) | 图片预览路径缓存与带协议验证／内容版本的音频波形缓存职责不同；队列结构相似不足以证明可用一个通用缓存替换 |
| 错误翻译；**可跨模块复用（各自运行时内）** | 桌面 [userError.ts](../../apps/desktop/src/lib/userError.ts) 的 `generationErrorMessage` 被 [GenerationPanel.tsx](../../apps/desktop/src/components/GenerationPanel.tsx) 调用；官网 [user-error.js](../../website/user-error.js) 的 `reportUserError` 被 [app.js](../../website/app.js) 调用 | 桌面处理本机错误和生成恢复语义；官网使用审核文案表及 HTTP 状态。Edge `_shared/errors.ts` 则生产结构化协议错误。分别沿本端入口复用，不统一为展示字符串；规则见 [错误专项](../USER-FACING-ERRORS.md) |

## 三个常见任务的静态查找演练

这些演练验证“能否从地图走到实现和实际调用”，不执行功能、不操作用户库或调用模型，不代替 UI／原生／线上验收。

| 模拟任务 | 查找链与核实点 | 决定／修正 |
|---|---|---|
| 新增一个带长内容的设置弹窗，沿用深浅主题和滚动条 | 主索引 → UI 地图 → `ModalShell` → `SettingsDialog` 实际调用；主题回到 UI 规范第 11 节及 `App.tsx` 加载顺序；滚动管理器回到 `main.tsx` | 使用现有模态壳和主题；普通 overflow 区域由全局管理器接管。`OverlayScrollArea` 只在需要布局／scrollRef 包装时使用；已明确其不是第二套滚动条 |
| 为新素材视图加入多选和拖出原文件 | 主索引 → 桌面地图 → `catalogSelection`／拖动入口 → `CategorizedLibrary` 与 `ConnectedCollections` 的真实调用 | 先确定 Asset ID 与 entry ID；单项选择复用公共函数，范围与路径解析保留宿主适配。已把“选择共用”收紧为实际共享部分，避免直接复制整份列表或跨模块导入私有 `select` |
| 给现有生成面板增加 Cloud 视频的“取回原任务”操作及失败反馈 | 主索引 → 服务地图的 IPC → [api.ts](../../apps/desktop/src/lib/api.ts) 的 `recoverCloudVideo` → [commands/codex.rs](../../apps/desktop/src-tauri/src/commands/codex.rs) 的 `recover_cloud_video` → [lib.rs](../../apps/desktop/src-tauri/src/lib.rs) 注册；桌面地图错误入口 → [GenerationPanel](../../apps/desktop/src/components/GenerationPanel.tsx) 中 `recoverCloudVideo(activeJob.id)` 与 `notifyError` | 复用现有恢复 API 和中文展示函数，保留原 job 身份与原始诊断；不改成重新生成。生成终态原因使用 `generationErrorMessage`，不能把所有失败都替换成一般网络提示 |

2026-11-03 首次核验结果（历史计数，不代表后续增量）：三个分类共 **43 项用途入口**；架构入口及分类／核验页的 **311 个本地链接与文档锚点**有效，**212 个标识符引用**通过关联源码文本检查。逐项对照实现、导出和生产调用，并沿上述三个任务独立交叉回查；补齐了设置弹窗的直接样例链接，以及原先从服务页跳转后缺失的视频播放入口，同时注明 `MediaPreview` 仍保留原生播放器分支。核验期间检测到其他工作继续修改源码，已保留并重查关联入口，没有将工作区当作冻结版本。未运行业务测试或构建，因为本轮只改导航文档。

首次建图时只修改根 `AGENTS.md`、现有架构入口和本目录四份文档，保留原有工作区改动，未暂存、提交或推送。当时 `.gitignore` 的 `dev-doc/*` 规则忽略架构入口及本目录；该可见性缺口已由下述 2026-11-06 精确白名单修复。


## 2026-11-06 复查与确认后的修复

本次直接修正 ModelSelect 的 portal 说明，补齐标注专项的源码／调用链接、状态与平移边界，并从主索引直达标注专项。新增文档沿现有条目维护；原 43 项及 311 链接数字仅保留为首次核验历史。已核对标注双宿主调用和三个选择器的实际 portal 目标；这是静态核查，不代表完成运行时回归。

复查时 Git 仅跟踪 UI.md、ANNOTATION.md，其余地图受忽略规则影响。用户确认后已在根 `.gitignore` 精确放行主索引及 UI／DESKTOP／SERVICES／ANNOTATION／REVIEW 五页，其余开发笔记和 reuse 内未列名文件继续忽略。未跟踪的地图现在能被默认 `git status` 发现；尚未暂存或提交，不能据此称已同步到远端。

用户已确认前三项，并由子代理分别实施代码提取和契约校验；第四项保留待调查：

| 细项 | 修改范围与验收 | 建议 |
|---|---|---|
| 地图可随仓库同步 | 精确放行主索引与五份分类／核验文档；验证 git status 可见，保留其他忽略规则，不自动提交 | 已修正忽略规则 |
| 色板 JSON 解析重复 | 将 AssetDetail、MasonryGrid 的同构 parseColors 提为桌面纯函数；验证空值、非法 JSON、混合数组及两调用方 | 共用入口为 assetColors.ts |
| 双端任务授权契约漂移 | 为 Edge 与 Worker 的 task-authorization 增加一致性检查，保持运行时隔离；验证当前一致及刻意差异能失败 | 已接入 Worker 既有测试匹配范围 |
| 下拉菜单 portal 覆盖 | TacticalSelect、RatioSelect 评估接入现有宿主；验证 TextWorkspace 内焦点、键盘、定位及普通 body 宿主 | 先做问题复现；目前只有接入差异证据，不据此宣称功能故障 |

范围选择和媒体队列继续保留为候选：身份、缓存版本及并发语义不同，本轮不合并。业务修改仅限用户确认的色板纯函数及两处调用；授权契约生产源码保持独立且不变，既有未提交改动保留。

验证结果：

- 白名单独立复核：六个目标可见，七个未列名文件／目录负例仍忽略；未暂存、提交或推送。
- 桌面目录运行 `node --experimental-strip-types --test scripts/asset-colors.test.mjs`：5 项通过，包含原数据边界及两消费者共用入口。
- Worker 的 `task-authorization-sync.test.ts`：3 项通过，覆盖当前一致、CRLF/LF 兼容和类型／能力名／调用上限三种内存漂移拒绝；现有 `src/**/*.test.ts` 匹配范围可发现测试。两份生产契约未修改，新增测试独立严格类型检查通过。
- 桌面完整类型检查未通过：当前有 76 条诊断。使用 TypeScript compiler host 仅在内存恢复两消费者提取前源码再次检查，诊断仍为同样的 76 条，本次未新增类型错误；未修改其他编辑器／依赖工作。Worker 完整类型检查另受既有 `video-audio-probe.test.ts:3` 的 `execFileSync` ambient 声明缺失影响。
- 更新后的 402 个本地链接目标均存在，所改已跟踪文件的差异空白检查通过。本轮没有执行 UI／原生／线上验收。
