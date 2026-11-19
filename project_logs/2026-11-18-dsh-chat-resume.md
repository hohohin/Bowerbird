# DSH Cloud 续聊恢复失败（已部署）

用户报告工作流 `b3b51ed4-92c5-49cc-a143-2648b9955b1e`、卡片 `3ca07bc2-e66a-433c-bd14-710bcf4a2550` 于北京时间 2026-11-18 01:02:31 显示 `chat_no_reply: 云端未能读取本轮输入`。对应时间的 Worker 任务为 `7206dca3-420c-4bc4-94e4-0cd3f45817da`，01:02:29 以 `failed/chat_input_unavailable` 结束。

只读核验原输入仍返回 HTTP 200、SHA-256 一致、通过 v2 输入验证，上一成功任务 `1faabf47-f727-45a6-8118-c7ff38d09832` 的持久快照存在。使用该快照的临时副本、现役固定依赖、不可用的回环模型端点，仅执行初始化与 session/load，复现 `handle.agent.model.select(route)` 对 undefined 访问 select。`agents.resume` 已成功，额外调用不兼容线上 0.1.1-rc.2 AgentHandle。诊断没有调用模型、重新提交原任务或改写原快照。

修复删除额外 select，通过既有 `agents.resume({resumeSessionId, agentOptions: route})` 传递模型选择；Worker 在输入校验通过后区分 `chat_dsh_start_failed`，两个聊天 Edge 的共享错误表补充中文原因。租约、提交次数、失败结算与未知结果不重发的规则保持。

验证：

- 针对现役源码的新增回归失败于相同 TypeError，修复后通过。
- 对话专项 13 项通过；真实本地固定 DSH 多进程续聊、独立会话、临时会话及压缩回归通过（1 项集成测试）。
- 线上固定依赖对原会话临时副本的修复探针完成 initialize/load，无模型调用。
- 基于现役分别下载的 chat-worker/chat-proxy 候选通过 Deno check。
- 全库测试与 TypeScript 未通过：技能文件哈希、音频探针及未涉及文件的 Node 类型声明等失败不计为本轮通过项，完整输出在 `.tmp/chat-input-fix/worker-tests.txt`。

部署候选与现役备份位于 `.tmp/chat-input-fix/{candidate,before}/`，逐文件哈希在 `manifest.json`。基线镜像 `sha256:03e0693eb4dcaa0310b25d5906119ea8a8236418d456c2c5b414fba2a138dc74`。候选对现役仅定向修改 Worker 的 `cloud-chat/native-chat-acp.mjs`、`cloud-chat/runtime.ts`，以及两个 Edge 各自的 `_shared/chat.ts`，不将脏工作区整包发布。没有数据库迁移或桌面发包。用户明确回复“确认部署”后，于北京时间 2026-11-18 01:23 完成配套部署与现役核验。

部署结果：`chat-worker v7 → v8`（3 份文件）、`chat-proxy v10 → v11`（7 份文件）均 ACTIVE，JWT 设置保持，下载的现役文件逐字节匹配候选。Worker 现役镜像 `sha256:764dcd888aae224e3804662b0cffee562dded0b745dcbcb9e58df7669ac957e0`，两个运行文件哈希与候选一致。切换前 generation/understand/visual/agent/chat 在途数均为 0；切换后四消费循环启动、restart 0，配置、挂载、资源限制比对通过。Agent health 的队列、过期租约、TTL 均为 0。

发布后直接使用现役桥与原会话副本，initialize/load 通过，没有临时修改桥源码。现役固定 DSH 完整合成模型集成测试通过，覆盖续聊后执行/保存、独立身份、临时会话和压缩；不调用真实上游模型、不重跑用户原任务。候选镜像断网对话专项 13/13；Worker 镜像继续使用原共享输入验证文件，中文错误表只由配套 Edge 发布，故候选 Worker 测试只断言错误码，中文原因通过 Edge 候选校验与读回验证。全库测试 410 passed / 66 failed，未以此作为全库通过证据。

回退保留 `bowerbird/generation-worker:rollback-chat-resume-20261118`，VPS 源码及部署回执位于 `/opt/bowerbird/deploy-backups/chat-resume-20261118/`；切换脚本 `/tmp/bowerbird-chat-resume-20261118/worker-release.py rollback`。Edge 原版本下载包保留在本地 before 目录。构建过程的 Dockerfile 也复制到了 Worker 的 `/app/src/Dockerfile`，仅为构建文本，不参与运行。旧失败任务终态保持，新请求可继续原会话。
