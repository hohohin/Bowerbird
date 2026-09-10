# 视频安全集成与下一次实测准备

> 已由 [VIDEO-API-INTEGRATION-V3.md](VIDEO-API-INTEGRATION-V3.md) 接续并完成主目录集成。此页是 v2 历史记录；原 v2 ready.patch/manifest 不再用于集成，视频迁移最终使用 0058。

> 2026-09-06，video-api-integration-prep-v2。执行任务 01a075d3-a061-76f0-b987-4329e8ac74a6。没有写回保存项目，没有鉴权请求、第二次真实视频 POST、部署或价格启用。

## 交付与集成范围

完整独立视频代码已提交为 **522a26df58e0c1a2aeefa6d4da5f6b632ac9f0d8**，基于 e2d2898c。该提交包含此前验证的 CLI 必要前置和 Cloud API 增量，不应直接覆盖已有 CLI/画板变更的保存项目。本轮后续提交包含验收工具、升级回归与集成证据。

保存项目只读快照：2026-09-06T09:47:32.464Z；HEAD 仍为 e2d2898c13674e1760a7da545dab3d340432cc6b，但工作区含未提交 CLI、画板、素材库、Agent 等并行工作。首轮逐文件三方比对：59 个任务文件中，13 个内容已存在、19 个新增/单边变化、6 个自动合并、21 个冲突。21 个冲突文件共 69 个冲突块，均已在隔离副本解决；没有要求用户处理工程冲突。

可审阅文件：

- `VIDEO-API-INTEGRATION-V2.json`：保存项目与合并后文件的 SHA-256、每个集成 hunk 的归因、冲突选择、补丁摘要文件位置和校验结果。哈希按 LF 规范化；缺失文件记为 null。
- 本 worktree `.tmp/video-api/integration-v2/ready.patch`：**相对当时保存项目工作区**的集成补丁，包含 Cloud 新文件以及共享文件的最小增量。
- 同目录 `tree/`：合并演练副本，保留保存项目的并行功能；`saved/`、`base/`、`comparison/` 保存只读比较依据，日志也位于本目录。临时副本及依赖不提交。
- `apps/desktop/scripts/verify-video-integration.mjs`：只读集成前/后哈希核对工具，不会应用补丁或写文件。

共享文件处理要点：

| 范围 | 保留保存项目 | 本任务集成 |
|---|---|---|
| App / 素材库 / CanvasWorkspace | LibraryHome、点击/拖动/取消、项目预览与现有路由；App 最终与快照一致 | 视频展示和引用载入所需差异；已有前置不重复插入 |
| CreationBoard / GenerationPanel / store | 当前 Agent 开关、工具栏样式、启动失败提示、素材库刷新/项目身份保护 | Cloud 视频渠道、1080p、逐轮恢复、明确引用、跨项目解绑 |
| 编辑器 / api / types / CreativeComposer | 原持久草稿、StrictMode 载入及精确节点类型 | 每轮 provider/节点历史和 Cloud 恢复 IPC；独立加入的重复声明去重 |
| Rust codex / generation_worker / task_queue | CLI 取回、现有任务/元数据 | Cloud 原 job/key 恢复、实际视频产物收尾 |
| project_canvas / migrations | 0024 文件及旧升级断言、现有节点布局/Agent投影规则 | 0025 同项目已生成素材可作 Input；跨项目与非 Input 跨线程边仍拒绝 |
| Cloud / VPS | 主项目的 Agent/Harness 增量不动 | 视频契约、代理、Worker、0058、隔离数据库测试 |
| AGENTS / PROJECT | 主项目原文与其他里程碑 | 仅本视频文档索引、状态、决策 |

v23→v24 测试之前使用 `db.migrate()`，在增加 v25 后不再固定验证 v24。演练将其明确迁至 24，**保留全部旧断言**；随后追加 v25 的 Input 允许、其他跨线程边/跨项目拒绝断言。该测试也已加入独立工作树。未把其他任务代码复制进视频提交。

## 验证与实际集成步骤

演练副本通过 297 项 Rust 库测试（3 默认忽略）、108 项保存项目当前画板相关测试、16 项视频/编辑器测试；桌面及 Worker TypeScript、Vite 构建通过。验收脚本 7 项离线测试通过；独立工作树新增升级测试后 274 项 Rust 测试通过。已有 v1 的 Cloud SQL/Worker/MP4 验证仍见原交接文档；本轮未把本地验证称作线上验收。

经理协调写入窗口后，先在当前保存项目运行只读 guard；任一文件漂移都停止应用，由执行任务重新合并，不能强推或让用户手改冲突。补丁已在独立目录执行 `git apply --check`、实际应用和逐文件 after 哈希检查。

```powershell
node apps/desktop/scripts/verify-video-integration.mjs dev-doc/VIDEO-API-INTEGRATION-V2.json D:/H/Project/Bowerbird before
# 上行工具也可使用本隔离 worktree 的绝对路径运行；实际应用另等经理安排。
```

保存项目没有这两个新文件时，从本 worktree 用绝对路径运行。应用后用同工具的 `after` 模式核对。本补丁绑定**未提交工作区快照**，不能仅凭 HEAD 相同就跳过 guard。SQLite 0024 不重写，0025 随新桌面迁移；云端 0058/Edge/VPS 仍待另行部署窗口，不随代码集成自动生效。

## 官方只读核对协议

2026-09-06 已取得国内官方完整正文：

- [任务列表](https://www.volcengine.com/docs/82379/1521675)：`GET /api/v3/contents/generations/tasks`，`page_num` / `page_size` 均 1–500，默认 1/20。仅最近 7 天；取消记录 24 小时后删除。可按状态、service_tier、重复 `filter.task_ids` 精确筛选。**filter.model 文档定义为 ep- 推理接入点 ID，不假设接受 doubao 模型名。**
- [任务查询](https://www.volcengine.com/docs/82379/1521309)：`GET /api/v3/contents/generations/tasks/{task_id}`；已知 ID 可精确查状态、产物与实际 usage。
- [创建任务](https://www.volcengine.com/docs/82379/1520757)：返回 task ID；`safety_identifier` 是固定且唯一的终端用户标识（建议用户信息哈希），会在查询/列表回显。它不是请求幂等键，不能为每个测试随机赋值冒充终端用户。

原 unknown 案例没有 task ID、HTTP request ID 或 safety_identifier；请求体哈希仅存在本地，列表不回显原 prompt/本地 request hash。时间、模型、时长、比例、分辨率只能筛出候选，不能建立唯一归属。即便某页为空，也不能证明未创建/未收费（分页、时效、删除均有影响）。没有公开证据支持先前 `/models/{model}` 诊断协议，404 仍不说明 Key/权限。

准备的 `list` 每次只读一页、20 条，不自动翻页；持久化 allowlist：task ID、model、status、created_at、duration、resolution、ratio、completion_tokens。不保存用户标识、提示词、输出签名 URL。`inspect` 只查经理明确给定的 task ID，仍标注关联未证实。要把原任务从 unknown 改成已知，必须由独立上游/账户日志取得可靠关联，不能人工挑“最像的一条”。本轮只准备协议，没有执行这些鉴权动作。

## 已准备的新独立最小案例

脚本：`apps/agent-worker/scripts/video-api-acceptance.mjs`。复用生产 `ArkVideoClient` 和 `arkVideoBody`；不读取或定位密钥文件，由经理沿用已有安全环境。命令必须显式带 `--execute` 才能联网。准备模式完全离线。

已准备案例目录：本 worktree `.tmp/video-api/acceptance-v2`。

- caseId：`98093630-e3e3-4d5e-86c2-7103be5296d6`。
- 请求 SHA-256：`23e31db8276316a92922ea88b0fff116fdfbee325953eba8cac523542b147d59`。
- 模型：国内 doubao-seedance-2-5-260628；4 秒、480p、16:9、无参考、无音频、MP4。
- 文本：固定镜头，黄色纸船在浅蓝色静水缓慢漂动；与原蓝色玻璃球案例独立。
- 费用：刊例 70 元/百万 completion_tokens；38430 tokens 示例约 2.6901 元，实际按 usage 记录。示例不是硬上限、不是正式应用售价，账单核对单独标记未完成。

只在经理确认具体执行范围后使用下列操作；本轮没有执行：

```text
node <script> list <new-readonly-evidence-directory> 1 --execute
node <script> inspect <readonly-evidence-directory> <independently-confirmed-task-id> --execute
node <script> submit <prepared-acceptance-v2-directory> --execute
node <script> query <same-prepared-directory> --execute
```

`submit` 在网络前以 wx 排他创建并 fsync 提交门闩；同案例第二次调用即失败。网络错误/5xx/无法解析均保留 unknown，不重发；403 等明确拒绝也不自动重试。成功得到 task ID 后保存到原 case，query 只 GET 同 ID。文件系统断电一致性及上游幂等不作保证，门闩丢失也不能据此授权重发。不能复制/删除 submission.json 来绕过门闩。

诊断只保存阶段、HTTP 状态、安全 request ID/错误代码和耗时，不保存 Key、Authorization、原始响应、异常消息或签名 URL。结果记录 completion_tokens、据刊例计算的成本与 invoiceVerified=false。这个最小案例验证上游 adapter；四模式参考上传、Cloud 积分账本、桌面下载入库和重启恢复仍需后续独立端到端验收。

## 待经理安排

1. 协调公共文件写入窗口；本任务负责冲突重算与实际集成，用户无需手动合并。
2. 选择是否先执行有限的一页只读核对；没有可靠关联时原 unknown 保持不变。
3. 安排新案例一次 POST 及后续同 ID 查询的具体授权执行，再推进完整链路验收。

正式价格未定不会阻塞本轮集成准备。生产部署、发包、价格启用、购买和充值均未执行。
