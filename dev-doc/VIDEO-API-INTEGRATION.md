# 国内方舟 Seedance 2.5 视频接入

> 当前状态：0058、Worker 与 Edge 已于 2026-09-11 部署，未启价、未完成真实视频生成/账单验收；后续 Worker 与函数更新见 [收费化进度](ARCH-ADJUST-PROGRESS.md)。本文保存视频协议与当次部署回滚证据，历史集成哈希见 [v3 记录](VIDEO-API-INTEGRATION-V3.md)。

## 2026-09-11 云端同步部署

用户授权“全面都更新后就再存档并重新打包”。核验 Supabase 原为 0001–0056，本次只应用 **0058_video_generation_jobs.sql**（SHA-256 `59745e7bbb97206e827b00ac178366cd1c08c0424793903552102dda005de826`）；0057 仍为未集成 Harness 预留，没有补造或执行。迁移后远端与本地一致，视频价格配置和 Seedance 2.5 活动服务行均为 0，未启用模型计费。

全部 12 个 Edge Functions 已从当前审核工作区部署，保留各自原 JWT 设置及既有 Secrets；无删除函数操作。发布清单与源码哈希为本地 `.tmp/release-20260911/edge-deployment-manifest.json`，上线结果为 `edge-after.json`。

| 函数 | 版本 | verify_jwt |
|---|---|---|
| generate-proxy | 33 → 34 | false |
| understand-proxy | 32 → 33 | true |
| entitlement | 35 → 36 | true |
| create-checkout | 23 → 24 | true |
| payment-webhook | 24 → 25 | false |
| agent-run | 48 → 49 | false |
| agent-worker | 54 → 55 | false |
| generation-worker | 25 → 26 | false |
| understand-worker | 16 → 17 | false |
| visual-profile | 12 → 13 | true |
| visual-profile-worker | 11 → 12 | false |
| wechat-login | 11 → 12 | false |

当次 VPS Worker 镜像为 **`sha256:a353810bd6385c9c70caf50b879515994c5170d58778e355c10ff19104fef46c`**（336367007 bytes）。本次以已核验现役镜像叠加 FFmpeg/CA 与当前 Worker 源码，保留锁定的 DSH 依赖；正式 Dockerfiles/Compose 已补齐同等构建要求。`cloud-shared` 只复制 `video-contract.ts` 和测试所需 `task-authorization.ts` 到镜像对应跨包路径，VPS 源文件位于 `/opt/bowerbird/cloud-shared/`。现役容器 `agent-worker-generation-worker-1` 保持 node 用户、只读根目录、全部 capabilities 丢弃及原 1536 MiB 内存/CPU/PID 限制；/tmp 从 64 MiB 调整为有界 640 MiB，容纳单个最大 500 MiB 探测文件；唯一新增环境字段是 Cloud 共享源码构建目录。品牌提示词及 DSH Profile 已逐文件核对一致；renderer 运行源码一致，无需重建或重启。

验证：本地 Worker 352/352 与类型检查、视频 PGlite SQL 测试、Edge 52 tests/15 steps 和 12 入口 Deno check 通过。修复全量检查发现的权益签名 typed-array/结构类型、undefined 规范化既有断言与理解 Worker 日志状态类型；线上签名公钥验签通过，临时账号清理已核验。镜像在原 1536 MiB 内存限制下无网络探测 500 MiB（524288000 bytes）合成 MP4，通过合法 free box 补足大小，返回 320×320、24fps、1s；验证的是探测容量，不替代真实下载/生成/计费或并发峰值验收；DSH 离线 ACP/取消/审批/持久化调用/用量/封闭工具面探针通过。完整源码测试搬入精简只读镜像为 335 passed/17 failed，失败项为缺仓库夹具或不可写的测试路径；额外夹具上传被自动审批拒绝，未放宽生产权限，未将其称为容器全套通过。

上线后 12 函数 ACTIVE、JWT 配置逐项一致；10 个受保护入口未登录均 401；有效 Worker 身份访问新 video_input_url 路由的随机不存在任务返回 404，未写入数据；video_service_pricing 与 Seedance 2.5 活动服务均 0。Worker 四循环启动、重启 0、控制面无排队/活动/失效租约，renderer healthy。未调用 Ark/DeepSeek，未发起真实生成、未对历史未知任务重发或退款；真实视频结果、账单及桌面完整链路仍待正式启价后专项验收。支付 Mock、DSH test-only 范围保持不变，未重跑基础镜像漏洞扫描或扩大账号开放。

回滚：VPS 原镜像保留为 `bowerbird/generation-worker:rollback-full-20260911`，ID `sha256:04732a2a630d0a58f814696d98ffdbf35313224639ed41dbc45b279057ecf977`。原源文件与仅远端保存的 0600 环境备份在 `/opt/bowerbird/deploy-backups/full-20260911/pre-source.tar`、`pre-env.generation`；切换脚本带失败自动恢复，实际未触发。需要回退时在停接新任务并核验无活动租约后，恢复对应文件/环境，将 rollback 镜像重新标为 local，以原 Compose no-build 重建 Worker；新增兼容迁移保持关闭价格，不做生产 DROP。

自动审批拒绝将 12 个现役 Edge 源码下载到本机，也拒绝额外技能/插件测试夹具上传；这些传输均未执行。没有声称拥有完整的上线前 Edge 源码备份；本地 `cloud-local-before.tar` 来自 Git `4d21dd3`，并非现役字节快照。需要 Edge 回滚时必须核对该函数目标版本与源文件，不能盲目整体回推本地旧树。新发布的源码、JWT/版本元数据与 VPS 回滚镜像已保留。

---

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

当前只剩真实调用与启价验收：核对首次未知提交，在明确执行范围后准备独立新案例，完成四模式、Cloud→桌面下载入库、重启恢复和实际账单核对。代码集成、0058/Edge/VPS 部署及桌面本地打包已完成，不再重复安排；正式价格仍须单独决定。

最小上游验收使用 `apps/agent-worker/scripts/video-api-acceptance.mjs`，准备模式离线，联网操作须显式 `--execute`。`submit` 在网络前排他写入并 fsync 门闩，同案例不可二次提交；结果未知保留原记录，不删除/复制门闩绕过。已知 task ID 的 `query` 只 GET 原任务。`list` 每次只读一页，`inspect` 只核对独立取得的 ID；时间、模型或相似参数不能建立唯一归属，空列表也不能证明未创建/未收费。`safety_identifier` 是终端用户标识，不是请求幂等键。诊断不落 Key、原始响应、提示词或签名 URL；实际 usage 与账单是否核实分别记录。此脚本只验上游 adapter，不替代完整 Cloud 账本及桌面验收。
