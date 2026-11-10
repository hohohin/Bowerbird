# H3 优化入口与纯文本运行修复

状态：桌面源码修复已验证；用户明确授权后，Worker 已于 2026-11-07 08:13（北京时间）部署并通过运行核验。未发布桌面安装包。

## 实际故障与原因

- 只读检查本机两个 H3 优化记录：均为 `failed / unified_agent_input_invalid`，并非此次仍发生连接重置。只读 SSH 核对现役 `/app/src/skills/bowerbird-unified-agent/schemas.ts`，`allowedKeys` 未包含 `textRewrite`。现役 Worker 是 11 月 7 日聊天上线版本；那次部署仅带聊天增量，文字改写尚未配套。
- 原生 `start_unified_agent_run` 无条件调用 `begin_creative_launch`，输入 threadId 时先建提示词会话节点，保存／查询 Run 又投影 Agent 执行组；前端模拟 IPC 没有覆盖这些原生副作用。底部入口另为优化创建 H3 卡片，进一步放大了多余节点。

## 修复

- 底部优化使用共用 `startCloudTextRewrite`，只提交文字，不准备项目、线程、画板落点或 H3 卡片；结果在原输入框查看和采用，原请求保留在原生 Agent 历史中。原 H3 卡片仍保留自己的步骤／恢复记录。
- 原生纯文本模式保留用户原文作为显示内容，内部 Skill 正文仍用于模型输入；不设置创作线程、不创建 launch，保存和刷新均不投影画板。图片／HTML Agent 保持原逻辑。共用文档文字 Agent 同步去掉多余建线程。
- `H3OptimizeButton` 复用于创作框提示词右上角和 H3 卡片提示词工具区，使用轻量工具按钮及积分图标，移除独立大按钮／额度说明行。
- 不自动重提已失败任务，不修改原账本或删除用户现有画板内容。

## 验证

- 原生 Cloud Agent 25 项通过，包括真实隔离 SQLite 的零会话／零画板节点与历史保留。Windows 测试 EXE 副本嵌入 Common Controls 清单；原始测试程序缺少入口点，未改动应用 EXE。
- `composer-h3-optimization-ui.test.mjs` 先复现额外 H3 节点，再验证两端零优化建卡、显式采用、手动生成及图片引用保持；`h3-prompt-optimization-ui.test.mjs` 和 `text-agent-ui.test.mjs` 回归通过。
- TypeScript、隔离 Vite 构建及针对本次修改的 diff 检查通过；构建保留既有大 chunk 提醒。
- Worker 在现役源码本地副本上只覆盖下面 3 个文件，16 项纯文本／图片／HTML／工具拒绝／中断恢复测试通过，使用假模型，无真实付费调用。本机直接工作树测试因 CRLF 导致既有 Skill 哈希不匹配，未计为通过；候选保留现役 Skill 原字节验证通过。

## 已批准并完成的上传与部署

目的地：既有 Bowerbird VPS `ubuntu@106.55.44.143`。仅上传以下 3 个 Worker 文件、两份相关测试和准备／切换脚本至 `/tmp/bowerbird-h3-text-repair-20261107`，构建现役镜像上的单独候选；断网测试通过、确认没有正在运行的任务后，再切换现有 Worker。

| 文件（相对 apps/agent-worker） | 作用 | SHA-256 |
|---|---|---|
| `src/skills/bowerbird-unified-agent/schemas.ts` | 接受并校验纯文本输入 | `5e98bfd2f5bc507925c34d33a7f4786f9a9a2d716ab87f88e116c6004cfaec32` |
| `src/skills/bowerbird-unified-agent/text-rewrite.ts` | 文字模式提示词及结构化结果校验 | `8739db27544730030ab1a79fb07d4e8d5c46dd3f52742ee96ffd32e41eec8b59` |
| `src/cloud-agent/unified-planning-run-processor.ts` | 无工具文字执行与结果恢复 | `0b23c8e98395f923127457216322068f720c1887a031d0442a6212cdfd8eaee4` |

保留现役聊天功能、环境变量、模型配置、资源限制与计费／测试账号边界，不部署其他工作区增量。旧镜像及 3 个源文件先备份到 `/opt/bowerbird/deploy-backups/h3-text-20261107`；切换失败恢复旧镜像和文件，不删除任务或重排未知结果。候选脚本与完整 manifest 位于 `.tmp/h3-text-repair-20261107/`。

自动审批拒绝了首次准备命令，理由为私有源码上传目的地及具体载荷缺少明确用户授权；该命令未执行，现役未变。

随后用户回复“允许”，明确授权上述目的地、载荷及部署步骤。候选基于现役 `sha256:8799ba09e5de45ed620b980f844f1ed8ee99c83cb5ee3bfb359206a1760b7b8e`，仅叠加表中 3 个源文件；测试文件仅只读挂载，不进入镜像。第一次服务器测试因测试工作区默认落在只读 `/app` 失败，补充测试容器 `TEMP=/tmp` 后 16 项全通过；未修改生产运行配置。

08:13:10 只读确认 generation／understand／agent／chat 四类活动队列均为 0，随后备份并切换。现役镜像为 **`sha256:4e732efa289246a064883e997db99bac88ccdab6c4dbbf5dff4bed2afe6ba6b3`**。08:14:03 核验服务 running、重启 0、无失败／fatal 日志，现役源码和容器内 3 文件哈希与清单一致；文字输入、结构化文字输出及原聊天模块导入通过。环境文件、Compose 与容器资源／安全限制逐项保持，无 Edge、迁移、价格、密钥或官网变更。

回滚镜像 `bowerbird/generation-worker:rollback-h3-text-20261107`，源文件及原镜像记录在 `/opt/bowerbird/deploy-backups/h3-text-20261107/`。回滚须先确认无运行任务，恢复两份旧源文件并移除本次新增的 `text-rewrite.ts`，再将回滚镜像标为 `local` 并通过原 Compose 重建；不得重排未知结果或删除任务。部署证据位于本机 `.tmp/h3-text-repair-20261107/{prepare.log,queues-before.json,activate.log,verification.json}` 和服务器同名临时目录。

验收边界：服务器测试使用假模型且断网；现役协议检查不请求模型。未重提旧失败任务、未执行真实付费 H3 优化／GPU 生成，也未更新桌面安装包。按钮和零画板投影修复仍需新版客户端；不能据此声称旧客户端的布局和建卡副作用已消失。
