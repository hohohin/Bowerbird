# PROJECT.md

Bowerbird 的当前状态、决策和未闭环事项维护在本页。技术契约与验收沿专项链接查阅。线上状态依据仓库的日期化发布和部署记录。

## 项目说明

**Bowerbird（园丁鸟）是一款以本地多类型素材库和项目画板为中心的 AI 创作工作台。** 创作者可以从一张参考图、一段视频或一份文档开始，在素材库里浏览、整理和创作。需要比较不同方案或连续加工时，可以把参考、指令和结果放在同一块项目画板上，沿用前一轮产物继续做。桌面应用采用 Tauri 2，浏览器扩展负责网页采集。

### 从素材到作品

| 想做的事 | 在应用里怎么做 |
|---|---|
| 收集和找回素材 | 连接已有文件夹，原件留在原位置；也可以导入零散文件，通过浏览器扩展或内置「探索」收集网页图片、视频，通过局域网快传接收手机原件。素材库支持浏览、搜索、分类和标签。[文件与归属](dev-doc/FOLDER-MODE.md) · [探索](dev-doc/EMBEDDED-BROWSER.md) · [扩展](apps/extension/README.md) |
| 从参考图开始创作 | 在素材详情分析图片，选取想复用的特征，和自己的要求一起送入共用创作框。可以生成或编辑图片，也可以把图片拆成透明图层，独立修改并导出。[项目画板](dev-doc/PROJECT-CANVAS-PLAN.md) · [分层编辑](dev-doc/LAYER-EDITING.md) |
| 使用文字和表格 | 在详情编辑器里写 Markdown、修改 DOCX 正文和基础格式。XLSX／CSV 支持查看工作表内容并将内容卡加入画板，供后续创作引用。[文本与办公文件](dev-doc/TEXT-LIBRARY.md) |
| 处理声音和视频 | 音频可按波形浏览和试听，角色声音工具可用参考录音生成语音。视频可播放、截帧、裁剪和提取音轨；普通复刻从分析与改写进入画板，强化复刻支持逐镜生成与音频字幕合成。本机 H3 提供视频生成，HyperFrames 支持基于工程制作并继续编辑。[音频](dev-doc/AUDIO-LIBRARY.md) · [角色声音](dev-doc/VOICE-STUDIO.md) · [视频复刻](dev-doc/VIDEO-REPLICATION.md) · [H3](dev-doc/COMFYUI-LOCAL-VIDEO.md) · [HyperFrames](dev-doc/VIDEO-SKILL.md) |

### 项目、执行与数据归属

一个项目对应一块无限画板，可以容纳多条创作线程。用户可以直接从素材库发起创作，任务由应用记录项目归属。项目成员记录素材属于哪些项目，画板上的卡片记录素材在此处的位置和用途。同一原件可以重复摆放；移除画板实例、移出项目和删除磁盘原件是三个独立操作。连接目录按原路径索引，零散导入按导入方式落盘，随图资料可通过分身保存。[项目与实例](dev-doc/PROJECT-CANVAS-PLAN.md) · [文件保存与删除](dev-doc/FOLDER-MODE.md)

画板上的内容卡提供素材，指令卡描述任务，生成卡和 Agent 卡执行任务，视觉规范可作为约束，循环与发条组织重复执行和启动顺序。例如，把第一张生成卡接到第二张的数据输入，第一轮产物就会成为下一张的参考，无需再输入 `@`。普通创作框可显式选择参考；工作流按连接和端口传递本轮结果。任务中断后按原请求恢复。[连接、结果与恢复](dev-doc/CANVAS-WORKFLOW.md)

普通对话和 Agent 卡片共用持久会话、模型选择、停止与恢复。当前源码提供本机 Codex、本机 DSH、DSH · Cloud 三个选项，可用性取决于本机配置和账号权益。通用 Cloud Harness 的受控工具与 HTML 渲染另有测试准入。[对话通路](dev-doc/CHAT-PROVIDERS.md) · [通用 Harness](dev-doc/UNIFIED-AGENT-HARNESS-PLAN.md)

素材库与长期创作资料保存在本地。启动 Cloud 任务时，应用按任务需要提交所选素材和指令；批量分类的范围可以包含多张图片。Pro 功能权限、Cloud 服务开放状态和 Bcoin 用量分别管理，具体以所选服务为准。[分类](dev-doc/LOCAL-CLASSIFICATION.md) · [传输与恢复](dev-doc/CLOUD-TRANSPORT.md) · [权益与计费](dev-doc/Bowerbird定价方案v2-订阅积分制.md)

## 目前进展

### 源码、发布与部署

| 范围 | 当前状态与证据 |
|---|---|
| Windows | 公开版 **26.11.2403**，发布源码 8aca9a8c2 含 SQLite **0062**。11 月 24 日北京时间 18:02 公网复核通过，Tauri 更新签名有效，按用户授权跳过 Authenticode。[发布与回滚](dev-doc/DESKTOP-UPDATES.md#windows-26112403-已公开发布2026-11-24) |
| macOS | 公开通道为 Apple Silicon **26.10.801**、Intel **26.10.1501**。Apple Silicon 26.11.2403 本地签名测试包已交付 R2 独立目录。Mac 源码统一至 `dev` 26.11.2403／SQLite 0062。ARM 构建、Rust 全量和隔离 WKWebView 烟测通过，负责人已确认真实登录及线上 DSH · Cloud v2 验收通过。[桌面自动更新](dev-doc/DESKTOP-UPDATES.md) · [Mac 正式验收](macOS/RELEASE-READINESS.md) · [源码收口验证](macOS/DEV-CONVERGENCE-2026-11-24.md) |
| 浏览器扩展 | 公开桌面包内为 **0.5.2**，扩展 **0.5.3** 源码待发。新版本合并多标签页心跳和批量连接，桌面能提示扩展更新。更新文件后在浏览器重新加载并刷新采集网页。[版本与验收](apps/extension/README.md) |
| Cloud 与官网 | Cloud 网关、原请求恢复和 VPS 定时巡检已上线。微信 Native v3 已开放公开购买，注册及 Pro 月度赠币已启用。Seedance 2.5 已开三档，分层已部署。GPT／Flash 未启价，Studio 未新增销售。[部署](apps/cloud/DEPLOY.md) · [微信支付](apps/cloud/WECHATPAY.md) · [现行定价](dev-doc/Bowerbird定价方案v2-订阅积分制.md) |
| 对话 | 桌面对话与 Agent 卡片共用本机 Codex、本机 DSH 0.2 和 DSH · Cloud v2。Cloud 仅对标记账号开放 0 Bcoin 试用，0094／0095 已上线，0096 付费版是默认关闭的隔离候选。[桌面契约](dev-doc/CHAT-PROVIDERS.md) · [云端契约](apps/cloud/CHAT.md) |
| 云端异步 Agent Run | 统一 Harness 与独立 HTML renderer 已部署，保持 **test-only**。[Harness](dev-doc/UNIFIED-AGENT-HARNESS-PLAN.md) |
| 素材视频转录 | 0099、逐字时间 Worker 已部署。指定账号可按每条 1 Bcoin 重复试跑，公开入口关闭。[转录与试跑](dev-doc/VIDEO-MEDIA.md#2026-11-21-转录入口直接报价与逐字定位) · [部署](apps/cloud/DEPLOY.md#2026-11-21-指定账号可重复转录与字级时间已部署) |

### 未闭环事项

| 事项 | 完成条件与入口 |
|---|---|
| 全量发布门禁 | 11 月 21 日第九轮复审维持 **No-Go**。待 Windows 可信发布者签名及正式双签包，Mac 双架构正式签名、公证和发布环境回执，双平台原生及旧版升级实机验收，目标规格混合压测、容灾与远端告警送达，供应商和商业化实账、微信登录与 Pro 到期实测。团队当前缺 Windows 正式签名资源。[第九轮复审](https://gemini.google.com/u/1/app/7000ffa86b500fd5?pli=1&pageId=none) · [发布和签名](dev-doc/DESKTOP-UPDATES.md) · [复审流水](project_logs/2026-11-22-project-docs-history.md) |
| 对话启费与 Harness 扩围 | DSH · Cloud 等待首条生产自然用量及供应商实账，验证单轮授权、扣费、回退及启费范围。通用 Harness 扩围前补自然任务小名单样本，重扫并处理基础镜像风险。[对话](apps/cloud/CHAT.md) · [Harness](dev-doc/UNIFIED-AGENT-HARNESS-PLAN.md) |
| 任务数据过期 | 用专用账号验证理解／视觉终态仍可按原身份在线取回，并检查过期拒读和清理。[部署与读回](project_logs/2026-11-11-audit-cloud-deployment.md) |
| 文件工作区 | 完成跨设备随图资料恢复，验收真实回收站、跨盘、Mac 原生及大型 NAS。核验旧迁移启动进度、界面恢复和 Vite 跨重启。补充连接原件变更触发自动分类的设置说明。[文件工作区](dev-doc/FOLDER-MODE.md) · [迁移诊断](project_logs/2026-10-19.md) · [分类](dev-doc/LOCAL-CLASSIFICATION.md) |
| 桌面原生体验 | 验收用户库升级、重项目长期性能、项目删除、拖放／剪贴板、HEIC HDR／广色域和视频封面。排查探索可滚动但不可点击，验证真实站点拖图及 Mac 媒体稳定性。[画板](dev-doc/PROJECT-CANVAS-PLAN.md) · [探索](dev-doc/EMBEDDED-BROWSER.md) · [发布验收](dev-doc/DESKTOP-UPDATES.md) |
| 视频、分层与分类 | 验收 H3 全新 Portable 安装、模型、GPU、恢复和播放。补 Cloud 视频参考模式／高分辨率、即梦四模式、分层与托管分类的真实成本及原生链路回执。转录待指定账号实跑两小时及正式报价，独立复刻 Demo 待全链成片。[H3](dev-doc/COMFYUI-LOCAL-VIDEO.md) · [Cloud 视频](dev-doc/VIDEO-API-INTEGRATION.md) · [即梦](dev-doc/SEEDANCE-2.5-INTEGRATION.md) · [分层](dev-doc/LAYER-EDITING.md) · [转录](dev-doc/VIDEO-MEDIA.md) · [Demo](spikes/video-replication-demo/README.md) |
| 反推与后续能力 | 单图指令记忆、视频反推、流式结果及默认指令保存语义待闭环。创作记忆 CM0–CM7、PSD 预览、OCR／版式／灵感卡待实施。用途／智能精修、技能／助手／模板库和图谱保持隐藏，FilmCraft 处于调研。[反推](apps/desktop/src/components/AssetDetail.tsx) · [创作记忆](dev-doc/CREATIVE-MEMORY-PLAN.md) · [功能开关](apps/desktop/src/lib/featureFlags.ts) · [剪辑调研](dev-doc/FILMCRAFT-RESEARCH.md) |

### 近期里程碑

- **2026-11-25｜Windows 26.11.2403 后的源码存档。** 探索改为一级入口，素材库优化导航、搜索与大库概览。收录 H3 安装与参考素材、折叠卡恢复与删除、Seedream 5.5 分层候选、采集扩展及 MCP 本机管理工具。[验证记录](project_logs/2026-11-25-desktop-cloud-archive.md)

- **2026-11-25｜Windows 26.11.2501 发布候选。** H3 与声音环境安装和诊断、工作流编辑恢复及折叠生成卡移除。[发布记录](dev-doc/DESKTOP-UPDATES.md#windows-26112501-发布候选2026-11-25)

- **2026-11-24｜macOS 源码收口至 dev。** 保留 Mac 原生桥接及更新公钥，完成 ARM 构建、Rust 全量与隔离 WKWebView 烟测。负责人确认 Mac 真实登录、DSH · Cloud v2 对话、恢复及原单查询通过。独立 Gemini 隧道通过本机双域及热刷新验证，Mac 公网端点待部署。[收口与验收](macOS/DEV-CONVERGENCE-2026-11-24.md)

## 关键约定

### 数据、文件与项目

- **本地权威。** SQLite、原件和长期创作资料保存在本地。Cloud 根据任务授权接收必要输入，托管分类可按所选范围上传图片。[文件工作区](dev-doc/FOLDER-MODE.md) · [传输](dev-doc/CLOUD-TRANSPORT.md)
- **项目和画板。** 一项目一块无限画板。素材、项目成员、画板实例、线程和执行身份分离。新意图建线程，续轮／重试／分支沿用原线程。空 provisional 项目暂存，手动名称及项目顺序保留。打开先恢复保存的视口，屏外内容按空闲和视口优先级补齐。[项目画板](dev-doc/PROJECT-CANVAS-PLAN.md)
- **保存和切换。** 项目路由与写入串行，异步结果核对项目及修订号。离开前冻结交互并按 FIFO 保存，失败时阻断切换或编辑。恢复保留用户隐藏、布局与任务终态。[画板持久化](dev-doc/PROJECT-CANVAS-PLAN.md)
- **连接和分身。** 连接原位索引真实目录，零散导入按来源保存到当前收集箱。分身指向原件，目录条目与素材身份独立。断开连接保留原件及项目引用，独立收集和其他有效来源继续可见。浏览优先复用缓存，由变化通知或手动刷新触发扫描。[连接与分身](dev-doc/FOLDER-MODE.md) · [局域网快传](dev-doc/QUICK-TRANSFER.md)
- **项目删除。** 默认保留素材。待运行和待交付任务解除项目归属并保留执行审计，迟到结果不得重建项目。仅对显式选择且复核为独有、受管的文件执行清理。[项目删除](dev-doc/PROJECT-CANVAS-PLAN.md) · [文件归属](dev-doc/FOLDER-MODE.md)
- **原件操作。** 移出项目、画板实例、分身删除及原件回收分别执行。物理删除走系统回收站，失败可恢复。失效清理要求可信卷及重复确认，离线和权限不明时保留索引。外拖、导出及定位用当前原件，失联时仅使用已核验的同素材历史路径。[文件操作](dev-doc/FOLDER-MODE.md) · [原件外拖](dev-doc/EXTERNAL-DRAG.md)

### 生成、理解与分类

- **通路和门控。** 图片走 Codex、即梦、Cloud 或固定本机 H3，理解走本机 Codex 或 Cloud。视频、分层和本机模型沿专项契约。客户端、Rust 和 Cloud 同步核验权益。本机 CLI 使用应用私有凭据。[通路](dev-doc/Bowerbird开发计划.md#生成与理解) · [本机 H3](dev-doc/COMFYUI-LOCAL-VIDEO.md) · [分层](dev-doc/LAYER-EDITING.md)
- **任务与续轮。** 请求发出前冻结身份，未知结果按原键取回。重试追加轮次，保留原会话及画板位置，冻结参考按原身份重放。续轮只自动带入最近产出轮的图片。即梦自有订阅的独立并行遵循供应商受理。[画板运行](dev-doc/CANVAS-WORKFLOW.md) · [Cloud 恢复](dev-doc/CLOUD-TRANSPORT.md)
- **同会话组图。** 生成素材在当前查询范围归组并默认显示最新项，解散只改变展示，定向内容格保留原绑定。Agent 图片按单张展示。[组图与精确来源](dev-doc/CANVAS-WORKFLOW.md) · [文件夹归组](dev-doc/FOLDER-MODE.md)
- **入库后台分析。** 自动命名和描述只走本机，历史 Cloud 自动理解开关不触发上传。用户主动提交的 Cloud 任务按所选服务处理，命名与分类分别调度。
- **分类与以文搜图。** 分类复用 Jev 判断及 Cloud 补标签，保护人工结果，原件变化按开关重排并拒绝过期结果。以文搜图使用独立本机 SigLIP2 索引，按素材版本和查询范围检索。[分类](dev-doc/LOCAL-CLASSIFICATION.md) · [语义搜索](dev-doc/reuse/SERVICES.md#以文搜图)
- **视频转录与理解。** 用户主动触发豆包整段音轨识别，文稿按原件版本保存，支持搜索、复制和按原生字词时间跳回。素材库画面描述独立核价，按原片总时长计费，超过两小时在本机按单段最长两小时处理。视频云端打标签可使用当前版本的文稿、画面描述或两者，发送纯文本。两项服务均以实际供应商成本的 1.6 倍拟价，关闭态核验和正式启价分别确认。第三层复刻在本机调整切点并复用该文稿，按勾选镜头报价，结果可发送为画板分镜卡或可编辑工作流。逐镜服务已完成源码实装，生产部署与启价另行确认。[素材视频](dev-doc/VIDEO-MEDIA.md) · [复刻](dev-doc/VIDEO-REPLICATION.md)
- **标注、文本与视觉规范。** 标注与 caption 独立，以最终图像坐标保存。办公文档与随图资料依原件和版本恢复。视觉规范独立于项目，生成时显式选用已确认版本。[标注](dev-doc/reuse/ANNOTATION.md) · [文本](dev-doc/TEXT-LIBRARY.md) · [视觉规范](dev-doc/AGENT-RUNTIME-PLAN.md)

### 工作流、Agent 与本机对话

- **工作流权益。** 建卡、编辑和保存草稿可离线进行。需 Pro 的工作流在运行时核验账号权益，已有运行仍沿原身份保存检查点和恢复结果。[画板工作流](dev-doc/CANVAS-WORKFLOW.md)
- **画板连线。** 卡片接收与输出共用加号。精确引用绑定实例、端口或单元格，生成结果沿连接交付。连同新建、断开和撤销按完整关系保存。发条、循环和失败恢复沿原运行身份。[画板工作流](dev-doc/CANVAS-WORKFLOW.md)
- **Agent 卡片与桌面对话。** 共用会话、续聊、模型、停止和恢复。改动同步核验本机 Codex、本机 DSH 与 DSH · Cloud。受控建卡须显式授权并按原轮次幂等写入，执行生成沿独立工作流。新增工具字段按客户端能力协商。[对话 provider](dev-doc/CHAT-PROVIDERS.md) · [Cloud 协议](apps/cloud/CHAT.md)
- **Skill。** 本机 DSH 复用自己的登录、原生会话和用户 Skill。Cloud DSH 加载 VPS 发布的内置 Skill，客户端提交标识与参数，恢复沿原请求和冻结输入。[本机 Skill](dev-doc/CHAT-PROVIDERS.md#2026-11-15-本机-dsh-在卡片第一轮使用-skill) · [Cloud Skill 部署](project_logs/2026-11-08-cloud-dsh-skills.md)
- **异步 Agent Run。** 新建仅接受统一 Agent + DSH。图片与 HTML 复用 Tool Gateway。DSH 管理执行上下文，控制面保管授权、预算、审批、账本、恢复与取消。旧 Run 按原协议恢复，Codex 对话与直接生成沿各自入口。[Harness](dev-doc/UNIFIED-AGENT-HARNESS-PLAN.md) · [HTML](dev-doc/HTML-RENDER-PLAN.md)
- **批准。** 默认请求批准。用户开启自行批准后按项目／线程记忆，沿原接口核验权益、预算、版本和过期，失败切回人工批准。应用退出及旧授权均不触发新代批。[审批契约](dev-doc/UNIFIED-AGENT-HARNESS-PLAN.md)

### Bcoin、权益与云端边界

- **服务与收费。** 服务端目录、快照和账本决定报价与结算，已受理任务沿原身份与报价处理。正式 DSH Token 候选按实际用量、固定费率版本及 1.60 倍折算，当前试用价为 0 Bcoin。[现行定价](dev-doc/Bowerbird定价方案v2-订阅积分制.md) · [Cloud 对话](apps/cloud/CHAT.md)
- **Pro、充值与赠币。** Pro ¥39／月、¥359／年，一次性 7 天主动试用不自动续费。充值 ¥1 = 20 Bcoin。新注册赠 200、Pro 每订阅月赠 800，年付分 12 次，到账 30 天有效。旧订单和兑换快照沿用原规则，历史注册和订阅月不补发。[权益与赠币](dev-doc/Bowerbird定价方案v2-订阅积分制.md)
- **微信支付。** 使用普通商户 Native v3，校验签名、商户、订单与金额后原子入账。未知支付或退款查原单；补偿、退款与日账独立于新购开关。[微信支付](apps/cloud/WECHATPAY.md)
- **Cloud 通信。** 使用统一网关和登记路由，按原账号与键恢复。账号、预算、计量、密钥和幂等由控制面掌管。日志保留阶段与关联 ID，移除内容和凭据。远程 prompt 不可用时回退内置默认。[Cloud 通信](dev-doc/CLOUD-TRANSPORT.md) · [部署](apps/cloud/DEPLOY.md)

- **云端修改交付规范（2026-11-09）。** 所有与云端相关的修改，包括 Cloud／Edge、VPS Worker／DSH、数据库／Storage、网关及影响云端协议的客户端改动，都必须在修改与验证完成后，向用户说明本次具体部署范围和验证结果，并取得明确的部署确认；不能把同意修改视为此次部署确认。用户确认后立即执行本次配套部署，不重复询问、不留作后续待办。部署后核验现役版本、相关链路和实际生效结果，完成部署与核验后才算任务完成；仅源码修改完成、隔离测试通过或“待部署”均不算完成。若部署或核验受阻，明确记录阻碍及尚未完成的部分，继续处理，不能宣称任务完成。

### 界面、平台与交付

- **本机 Codex 生图和诊断（2026-11-03 保留）。** 生图首轮／续轮默认 `gpt-5.6-luna / low`，显式模型覆盖仍有效；依据此前 CLI 账号目录修正，不能用桌面可选型号推断 CLI 可用性，真实出图仍需实机验收。Mac 复制会话诊断在点击时开启剪贴板写入，异步等待冻结会话的完整报告，查询失败或拒绝写入不报成功。该两项未提交修复已随本轮保全。
- **Mac 源码分支。** Mac 与 Windows 统一在 `dev` 开发，`mac@13fdfdb2` 保留为历史归档，停止新增业务提交。历史 `mac` 存档需列出相对远端基线的完整内容和跨端说明，经用户明确确认后再推送；范围变化须重新确认。[收口与验收](macOS/DEV-CONVERGENCE-2026-11-24.md)

- **界面改版先网页确认。** 先提供独立网页示意，经用户确认后接正式组件。沿用工业制图主题和共用素材卡、菜单、焦点及悬浮反馈，保留媒体几何和交互。[设计规范](dev-doc/UI-DESIGN-SPEC.md) · [UI 复用](dev-doc/reuse/UI.md)
- **素材与编辑。** 素材库、详情和画板复用媒体预览及播放。首页、画板和文本工作区共用左侧栏，按分栏和项目上下文记忆模式、层级目标和收起状态。层级模式支持全部素材、项目及文件夹，标签模式使用全局标签。截图、标注、文本、视频采集及多选遵循各专项的输入、取消与恢复规则。[桌面复用](dev-doc/reuse/DESKTOP.md) · [素材库设计](dev-doc/UI-DESIGN-SPEC.md#71-素材库) · [媒体](dev-doc/VIDEO-MEDIA.md) · [文本](dev-doc/TEXT-LIBRARY.md)
- **文本编辑器工具栏。** 固定栏保留写作常用格式、插入素材、Agent 和导出。表格、代码和其他块操作从 `/` 进入。选区浮动栏可自选并排序最多 8 个富格式，本机记忆顺序，素材详情与放大工作区共用。「更多」保留本机评论与修订。窄窗按编辑区宽度收纳操作。[文本工具栏](dev-doc/TEXT-LIBRARY.md#文本工具栏)
- **音频裁剪。** 调整入点或出点后，裁剪模式的播放及进度定位限制在选区内。暂停时按空格从入点播放，到出点停止。外部引用只能另存，覆盖受管原件时失效该版本的转录文稿。[音频素材](dev-doc/AUDIO-LIBRARY.md#音频详情与转录)
- **探索与扩展。** 探索为一级入口，目录与素材流在左，网页在右。画板素材栏默认收起，右侧探索与一级探索共用原生网页和登录资料。拖放时冻结项目和落点。扩展沿浏览器会话及配对协议采集。网页内容不扩大 Agent 权限。入门引导暂时隐藏，历史项目、素材与进度保留。[探索](dev-doc/EMBEDDED-BROWSER.md) · [扩展](apps/extension/README.md) · [引导](dev-doc/ONBOARDING.md)
- **错误提示。** 在展示边界转为有依据、可执行的中文，保留原始诊断。超时、断线和未知结果提示按原单恢复。[错误规范](dev-doc/USER-FACING-ERRORS.md)
- **平台与验收。** 维护一份主源码，平台差异落在必要接缝。区分源码、构建、运行进程、公开包与真实服务。原生验收隔离用户库、文件和凭据，核对实际产物路径。[Windows](Windows/README.md) · [macOS](macOS/README.md)
- **桌面更新。** 发现新版后后台下载，顶栏下载图标可打开「设置 → 系统设置」查看进度。11 月 23 日源码改为验签后点击安装图标即可保存画板、安装并重启。有进行中的本地生成时先询问用户，系统设置内安装遵循相同规则。[更新行为与验收](dev-doc/DESKTOP-UPDATES.md#客户端行为与代码入口)
- **桌面发版。** 用户确认本轮范围后完成验证、存档推送、冻结构建、发布、回读及回滚核验。Windows 官网包按现有授权可跳过 Authenticode，保留 Tauri 验签和 /UPDATE 登录契约；全量放行仍需正式双签。Mac 按固定 DMG 流程交付。[发布流程](dev-doc/DESKTOP-UPDATES.md)
- **代码只读共享。** 根目录 `update-mcp.ps1` 导出当前工作区，本机分支控制台也可选择指定分支的提交。GPT 与 Gemini 在下次工具调用时校验并热切换同一份脱敏快照，失败沿用上一版。概览记录分支、提交和工作区修改状态。Gemini 保留有效授权，撤销跨重启生效，代理只能读取。[代码 MCP](apps/code-reader-mcp/README.md)

## 踩坑记录

- **平铺素材库概览读取不必要的统计。** 平铺只查询列表总数，标签模式继续读取完整汇总。大库隔离基准已通过，真实外接盘和 NAS 仍待测。[素材库性能记录](project_logs/2026-11-25-material-library-performance.md)
- **压缩音频裁剪偏离选区。** 编码前快速定位依赖容器的寻址信息。改为按解码后的时间轴裁剪，并在覆盖后刷新各画板引用。真实外接盘和 macOS 仍待原生验收。[音频素材](dev-doc/AUDIO-LIBRARY.md#音频详情与转录)
- **Mac 语义索引漏刷。** 同一原件的系统路径别名导致通知无法命中登记记录，统一通过既有 Mac 路径别名函数匹配。相同大小和修改时间的换图已通过原生回归，真实外盘重接待实机验收。[ARM 验收](macOS/RELEASE-READINESS.md#候选回执)
- **Mac HEIC 预览偏色。** 带 P3／PQ 色彩描述的输入使用 Core Image 生成带颜色描述的 SDR 预览，JPEG 缩略图转换到 sRGB。合成色条已与系统参考对照，真实 HDR 屏幕效果待验。[HEIC 实现](dev-doc/FOLDER-MODE.md) · [ARM 验收](macOS/RELEASE-READINESS.md#候选回执)
- **折叠生成卡预览被素材盖住或拖动时脱离锚点。** 预览层级改为高于当前画板的可见卡片和拖动抬升层，拖动时随锚点同步绘制，原卡保存位置和结果绑定各自保留。[画板契约与回归](dev-doc/CANVAS-WORKFLOW.md#折叠生成卡的悬停预览)
- **H3 录音引用阻断其他画板编辑。** 旧原生校验拒绝新版已保存的 reference-audio，整张画板无法保存。兼容有效绑定，恢复连线时核对上游和环路。[H3](dev-doc/COMFYUI-LOCAL-VIDEO.md)
- **DSH Cloud 续聊误报输入丢失。** 固定版本 AgentHandle 缺额外的模型切换接口。恢复沿原生 agents.resume 参数，区分启动和恢复失败。[诊断和修复](project_logs/2026-11-18-dsh-chat-resume.md)
- **扩展源码更新后浏览器仍显示旧版。** 浏览器可能加载安装目录的打包副本。核对已加载路径并更新，再重载扩展以保留原 ID 和配对。[扩展指南](apps/extension/README.md)
- **真实迁移后白屏。** 核对实际迁移与运行路径。开发 Vite 未随 EXE 自动重启，迁移结果及界面恢复分别验收。[故障记录](project_logs/2026-10-19.md)

[整理前原文](project_logs/2026-11-22-project-docs-history.md) · [历史索引](project_logs/README.md) · [里程碑归档](dev-doc/进展归档.md)
