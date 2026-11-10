# 2026-11-09 Agent 文本容量链路部署与 HTTP 413 修复

## 现场与根因

用户工作流 `39aaaa87-2a82-47a7-98ec-2d07fa093f82` 的 Agent 卡片在 16:34:41（北京时间）上传报 HTTP 413。此前取消文本限额只完成源码及隔离验证，未发布 Cloud。现役官网 `cloud-routes.json` 对 `agent-temp/.../inputs/request.json` 仍配置 65,536 字节；后续 Edge 输入 64 KiB、检查点 1 MiB、Worker 输入／结果 16,000 字、数据库事件 16 KiB 和模型代理限制也仍存在。

只读本机工作流与身份诊断，按原幂等键查询得到 Cloud run `fe157d09-9f1e-4935-bd8c-baa562f4d4a6` 已 `cancelled`、hold 已 `rolled_back`；未入执行队列。部署后再次核对两者一致。没有修改用户本机库、重建或重排原任务。

## 实际发布范围

- 只执行 `0081_agent_text_payloads`、`0083_agent_text_capacity` 并登记迁移；先事务演练回滚，再应用。`text.result` 取消字节配额，普通事件仍 16 KiB 且必须为 JSON 对象；`agent-temp.file_size_limit = null` 继承平台真实上传容量。0082 和其结算逻辑保持，未执行全量 `db push`。
- `agent-run` v56 → **v57**、`agent-worker` v61 → **v62**；先下载现役函数及依赖，仅替换容量相关入口，保留 `verify_jwt=false` 和内部鉴权。上线读回与候选完全一致，其他 Function 版本保持。
- Worker 在四类活动队列均为 0 时，于 **16:57:26** 完成切换。镜像从 `sha256:5d5190c9c6768203ac96dbd57827180ed40386d6b63e730f4bd176d0fcb7624c` 更新为 **`sha256:87538bf645e5f70fb4b7ca807079b727e3334e276bdb9b3ea7690d95c7261d5a`**。仅覆盖 8 个 Agent 模块与 3 个 DSH profile，保留现役 Skill 正文／哈希；VPS `/opt/bowerbird/dsh-profile/` 构建源同步更新。环境、Compose、密钥、只读 Skill 挂载、资源与安全配置完全保持，restart 0，无启动／运行错误事件。
- 官网切换到 `/opt/bowerbird/website-releases/20261109-agent-capacity`，只改 `cloud-proxy.mjs`、`cloud-routes.json`，86 个其他文件保持。Agent JSON 上传／控制请求／结果取消固定配额；Nginx 仅 `/api/cloud/` 的 `client_max_body_size` 从 200m 改为 0，媒体配额仍由固定网关路由执行。签名、精确长度、账号、并发与不自动重发保持。
- 桌面源码没有重新打包或发布。本次服务端 413 修复直接生效；旧安装包自己的字符校验仍需对应桌面版本更新，不能把 Cloud 部署当作桌面已发布。

## 验证证据

- 现役镜像叠加候选的 **66 项**断网回归通过：长输入／完整结果、检查点恢复、原工具调用复用、用量持久化、取消与租约、既有 Skill 完整性等。首次 65/66 因隔离测试缺公开 `/cloud/.env.example` 夹具，补齐只读夹具后全过；没有修改生产配置绕过测试。
- 真实 DSH 解析规划、HTML 执行和内容执行三份 profile：上下文 1,048,576、输出 393,216 tokens、自动摘要关闭，各阶段原工具权限保持。
- 现役官网副本 **23 项**网关回归通过；生产公网 **14 项**鉴权／拒绝路由检查通过。候选 Edge 长输入、检查点和结果跨原限额往返通过；数据库约束和迁移读回通过。
- **16:59:27** 公网签名上传 **26,400,257 字节（约 25.2 MiB）**合成 Agent 清单返回 HTTP 200。Cloud Storage 读回长度、SHA-256 完全一致，测试对象删除返回 200。真实任务新增 0、付费模型调用 0。此项验证实际网关和 Storage，不宣称无限物理容量或真实长文模型质量已验。
- 证据目录 `.tmp/agent-capacity-deploy-20261109/`：`worker-prepare.log`、`website-prepare.log`、`profile-probe.log`、`live-upload.json`、`verified.json`、`functions-before/after.json`、`db-before/after.json`、`edge-before/after/`、`manifest.json`、`finalized.json`。不保存或输出密钥及签名 URL。

## 回滚与后续

Worker 旧镜像标签 `bowerbird/generation-worker:rollback-agent-capacity-20261109`；持久备份 `/opt/bowerbird/deploy-backups/agent-capacity-20261109/` 保存 8 个旧模块、3 份旧 profile、Compose、哈希与 Nginx 原件。先确认队列空闲，再恢复对应文件／旧镜像，保留原任务身份及账本。官网旧版本 `/opt/bowerbird/website-releases/20261106-windows-26.11.602` 可恢复软链接并重启，Nginx 恢复前先 `nginx -t`。

Edge 原版本依赖保存在本地 `edge-before/`，仅回退这两个函数并保留 JWT 配置。数据库不应盲目恢复旧大小约束：新长文本可能已合法写入，回退代码时保留放宽后的约束和迁移记录，不截断／删除内容或重算历史账本。

用户真实任务生成质量及超出模型／平台实际容量的行为仍需相应任务验收。本次未调用付费模型，也没有替用户重新启动已取消任务。
