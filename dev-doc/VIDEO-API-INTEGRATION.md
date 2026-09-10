# 国内方舟 Seedance 2.5 视频接入

> 当前状态：视频与 FFmpeg 修复已完成主目录本地集成，见 [VIDEO-API-INTEGRATION-V3.md](VIDEO-API-INTEGRATION-V3.md)。视频迁移最终为 0058，未部署、未启价、未完成真实生成验收；下文保留 v1/v2 历史证据。

> v2 后续：完整代码已提交为 522a26d，安全集成演练和新实测准备见 [VIDEO-API-INTEGRATION-PREP-V2.md](VIDEO-API-INTEGRATION-PREP-V2.md)。下文 v1 状态保留为当时证据。

> 2026-09-06，结果版本 video-api-local-v1。独立 worktree / 未提交 / 未合入保存项目 / 未部署 / 未启用生产价格。代码与离线验证完成，真实生成验收未完成。

## 1. 已确定范围

用户选择 Bowerbird Cloud 托管、扣应用积分，与即梦 Dreamina CLI 并存。仅使用国内方舟模型 **doubao-seedance-2-5-260628**，地址 https://ark.cn-beijing.volces.com/api/v3；复用现有服务端 ARK_API_KEY，桌面不接收 Key。没有 BYOK 或海外回退。

四模式：文生视频、单首帧、首尾帧、多模态参考。Cloud 支持 480p/720p/1080p、整数 4–30 秒；CLI 保留其 480p/720p 契约。首尾帧采用 adaptive；其他模式支持六个明确比例及 adaptive。MVP 固定 MP4、24fps、无音频生成，多模态显式 reference，不扩展编辑/续写/音频输入/工具搜索。

复用现有创作板、项目/线程、历史、重试、视频素材入库与播放器。没有新增 Agent/Harness。视频渠道与每轮参数持久化；历史复用保留 provider 与引用次序。同项目精确节点跟随编辑器→任务→元数据→历史；跨项目复用保留素材并清除源项目节点绑定。

## 2. 官方契约与限制

已读取用户提供的完整国内创建文档，并通过公开文档接口读取以下官方正文（核验日期 2026-09-06）：

- [创建任务](https://www.volcengine.com/docs/82379/1520757)：POST /contents/generations/tasks，返回上游 task id。
- [查询任务](https://www.volcengine.com/docs/82379/1521309)：GET /contents/generations/tasks/{id}，成功结果含 content.video_url 与 usage.completion_tokens。
- [取消/删除](https://www.volcengine.com/docs/82379/1521720)：queued 可取消、running 不能取消，终态 DELETE 会删除记录。因此桌面停止等待不发 DELETE，恢复仅查询原任务。
- [模型说明](https://www.volcengine.com/docs/82379/1330310)、[2.5 使用指南](https://www.volcengine.com/docs/82379/2607688)、[当前价格](https://www.volcengine.com/docs/82379/1544106)。

图片最多 30 张，单图小于 30MB，宽高 300–6000、宽高比 0.4–2.5；桌面先隐私处理并压缩为最长边 1600 的 JPEG。当前 Cloud 图片请求沿用更严格的 20MiB 总量/10MiB 单图边界。视频最多 10 条，MP4/MOV、每条至多 200MiB、2–30 秒、合计至多 30 秒、24–60fps、宽高 300–6000、像素数 407696–8295044。VPS 下载后用本地 ffprobe 再验证，不能只信桌面元数据。

临时视频由服务端指定私有对象路径并签名，客户端不能指定任意 URL；上传完成后才入队。Worker 只接受 HTTPS 结果，禁止跳转，有下载大小/哈希/媒体类型校验，输出上限 500MiB。结果本地入库和元数据持久化后才确认收取。

官方任务记录与结果 URL 的保留期限不同；平台正常结果从成功开始保留至少 24 小时。超预留待人工结算的成功产物暂存 7 天，过期后可清理但保留 usage/账本。上传中断的恢复会原子结束仍处 uploading 的任务并释放预留；若另一请求已将它入队，则继续查询原任务。用户可随后明确新建，系统不会自动再生成。

## 3. 持久化、恢复与结算

桌面在网络前保存稳定键 video-{localJobId}-{turnKey}；服务端同 key/manifest 复用同一 hold/job，不同参数冲突返回错误。参考上传重放只针对原 key。VPS 在唯一一次上游 POST 前持久化 submitted，得到 task id 后立刻保存；已知 task id 的租约回收、进程重启、取消后取回都只 GET。

POST 结果未知且无 task id 时进入 outcome_unknown，保留预留，不自动退款/重发。Cloud 桌面失败重试和启动恢复以原 job id 或原 key 查询，不建立新轮次。找不到原记录也不猜测上游任务。

迁移 0058 新建视频价格配置但 **不写入任何活动价格行**；入口还要求非 Mock，mock Worker 不能把视频按零成本完成。计费快照锁定分辨率、是否输入视频、tokens/credit、上游单位成本及最大预留。正常成功按实际 completion_tokens 向上取整结算，多余预留释放；确认失败/取消才退款。排队或执行中的预留进入 pending_settlement，不被普通 30 分钟过期处理提前释放。

实际 tokens 超过保守预留时保存视频与 usage，停止自动结算并允许取回。service_role 专用 reconcile_video_usage 需要明确核对理由，批准扣分不超过原预留及实际报价，操作留痕；没有公开管理入口，也未对生产调用。用户测试“不设保留额度上限”的意思是继续功能验证，不删除生产预算与幂等保护。

## 4. 价格建议（未启用）

官方刊例价：480p/720p，无输入视频 70 元/百万 tokens、有输入视频 42 元；1080p 分别 77/46 元。1080p 2026-08-14 14:00 至 09-17 14:00（UTC+8）临时 72 折，不作为永久定价依据。音频开关同价，仅成功生成计费。

沿项目定价 v2 的上游成本目标 0.047 元/积分，建议无视频/有视频输入的 tokens/credit 如下，均向下取整保护成本目标：

| 分辨率 | 无视频输入 | 有视频输入 |
|---|---:|---:|
| 480p/720p | 671 | 1119 |
| 1080p | 610 | 1021 |

例：4 秒 480p 16:9 估算 38430 tokens，约 2.6901 元，对应建议 58 积分；实际按官方 usage 结算。输出尺寸、视频输入及最低 token 计费会改变用量，不能只按秒数估算。基础档 0.078 元/积分、专业档 0.054、新手包 0.099 是现有收入假设，需要经理统一确认正式价。历史 160/450/900 分视频规划不自动生效。

SQL 离线测试仅在内存数据库中用 500/800 tokens 每积分与 70/42 元作为独立测试样例，不能导入生产。

## 5. 基线与归因

基线 e2d2898c13674e1760a7da545dab3d340432cc6b，分支 codex/video-api-preflight，任务 01a075d3-a061-76f0-b987-4329e8ac74a6。保存项目 D:/H/Project/Bowerbird 只读。

CLI 快照提取 31 个候选补丁：24 个可直接迁入，7 个需要逐块处理。creativeLaunch 在必要前置后迁入；store/CreationBoard/GenerationPanel/CanvasWorkspace/AssetContextMenu 人工合并当前入口所需部分。未迁入依赖缺失 UI 的 creative-canvas prompt-menu 测试补丁，以当前真实 store/编辑器行为测试补覆盖；不弱化原测试断言。未迁入 projectAssetsViewRevision、文件夹 hover-preview 或与视频无关的 prompt-menu 功能。

额外必要前置包括 App 的待复用请求/项目路由、CreativeComposer 的持久载入、编辑器精确引用链、项目投影输入边与历史恢复。SQLite 0024 SQL 内容从保存项目迁入（独立提交规范化末尾空行；集成补丁保留保存项目原文件）；0025 为本任务新增，允许同项目跨线程引用已生成素材并检测整个项目的环，输出仍属于目标线程。详细原文件/补丁哈希、冲突处理说明及最终文件哈希见 VIDEO-API-PROVENANCE.json；原始候选补丁与运行日志保存在本 worktree 的 .tmp/video-api（不入库）。

## 6. 验证与证据边界

本地通过：Rust 库测试 273 项（3 项默认忽略）、实际短 MP4 入库/海报抽取 1 项；桌面既有画板相关测试 80 项；新增视频/恢复/编辑器测试 16 项；Worker 生成测试 21 项；桌面与 Worker TypeScript、两支 Edge Deno check、Vite 生产构建。

独立 PGlite 执行真实 0001/0002/0003/0004/0009/0015/0023/0058 SQL，验证默认不启用、幂等冲突、task id 不变、取消/重启、实际扣分、重复 finish、未知提交、超预留证据和人工核对、上传失败竞态、预留到期、权限隔离及 NULL 输入。适配仅提供 auth/storage schema、角色和 pgcrypto UUID 入口；这是单后端数据库测试，未替代真实多连接并发或已部署 Supabase 验收。

复现命令（仓库根目录；先安装项目锁定依赖）：

~~~powershell
node node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p apps/agent-worker/tsconfig.json
node --test apps/desktop/scripts/video-generation.test.mjs apps/desktop/scripts/video-reference-editor.test.mjs
node --test apps/agent-worker/src/cloud-generation/runtime.test.ts apps/agent-worker/src/cloud-generation/ark-video.test.ts apps/agent-worker/src/cloud-generation/video.test.ts
node apps/cloud/scripts/video-generation-db.test.mjs <isolated-PGlite-module-path>
cargo test --lib --manifest-path apps/desktop/src-tauri/Cargo.toml
~~~

Windows 内存不足时仅构建测试目标并关闭该目标 debug info：cargo rustc --lib --profile test --offline -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml -- -C debuginfo=0，再执行产物。真实 MP4 测试需 ffmpeg/ffprobe 可用。新增测试依赖不进入应用 package.json/lock。

## 7. 真实调用记录与未完成项

只有 **一次**真实视频 POST：2026-09-06 08:56 UTC，固定 4 秒/480p/16:9/无音频/无参考图。客户端 10 秒后记录 outcome_unknown，postCount=1，没有 task id、HTTP 状态、usage 或费用证据。原案例不可重发，也不能按时间猜任务。证据 .tmp/video-api/live-text-480p-4s/submission.json。

随后经理在用户明确授权下执行原只读诊断：2026-09-06T09:04:37.586Z，GET /models/doubao-seedance-2-5-260628，HTTP 404，request id 021788685476183b6ef94156a979b704a6b85dbeb7998fabcca73，404ms。公开官方文档尚未确认此 GET 路径的有效契约，故该 404 **不能证明密钥无效或模型未开通**。证据位于保存项目 .tmp/video-api/ark-connection-diagnostic.json，只读。

本任务自动审批曾拒绝本地读取 Key 的诊断动作，原因是转述的授权不足以构成可信授权；没有绕过。用户随后在经理窗口授权并由经理执行上述 GET。未在此任务重复凭据诊断或第二次提交。

待经理处理：确认是否合入这份未提交代码；核对首次未知提交，并在明确授权后安排可审阅的新真实案例；完成四模式、Cloud→桌面下载入库、重启恢复和实际账单的线上验收。需实际部署时按顺序应用云迁移、Edge、VPS（安装 ffprobe），最后桌面；先在隔离环境设置测试价格，正式价格须单独决定。当前未充值、未购买、未开通模型、未推送迁移、未发布桌面，不能称为正式接通。
