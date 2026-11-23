# 文本编辑器 Cloud DSH 增量预览部署

用户批准定向更新 VPS Agent Worker 的五个运行模块。候选基于当时现役镜像 `sha256:4fecd3f8645a51795939f8c23b644161265caaabddba9be750a0f5e7f1d3d671`。五个旧源码的容器与宿主哈希一致，分别匹配 `f0d77daa9` 的改动前版本。依赖、配置、权限、挂载、Edge 和数据库沿现役版本。

## 验证与切换

1. 断网候选用实际固定版本的 DSH 与回环模拟模型复现了原五文件候选的延迟。计量代理完成整条上游响应的持久化后才将正文交给 ACP。修正在同一范围内观察上游 SSE 的助理正文，最终结果仍以计量代理持久化的完整响应为准。
2. 定稿候选断网用例 23/23 通过。实际 DSH 探针等待第一条正文预览后才让模拟模型发送终段，确认终态前已有非空预览。故意中断终态发布后沿同一 Run 恢复，只有一次模拟模型请求、一条用量记录、一个最终正文事件和一次完成提交。本地 Worker 类型检查和计量代理 29 项回归通过。
3. 北京时间 21:32:45 检查生图、理解、视觉、Agent、聊天队列均为 0，21:32:50 切换至 `sha256:37b7a2a2099e8ca94bc00d78014bbac98c697ba643de2009aa6b425fd7baea6f`。独立回读确认宿主／容器各文件哈希与候选一致，环境、资源限制和挂载指纹一致，运行中、重启 0、OOM 0。21:33:43 Agent 健康监测无活动、过期租约或清理积压，21:33:48 五类队列再次为 0。`agent-run` v65 和 `agent-worker` v71 均为 ACTIVE，匿名请求均返回 401。发布验收使用回环模拟模型。

| 现役文件 | SHA-256 |
|---|---|
| `cloud-agent/unified-planning-run-processor.ts` | `37935e1891e1b51052ba018c8484508f2b16453d4badd23aae4e891b6b414138` |
| `harness/contracts.ts` | `941932d3b7409895e147046ca28318d8fca35cd79d45cf10ea085b475c0622e3` |
| `harness/dsh-acp-harness-adapter.ts` | `413fd08bf9affb29fc14080ee311850c0cbf2e4cbd892a2928c429cafec69c2e` |
| `harness/unified-planning-harness-runner.ts` | `e502225792d08aa1629fd964e45ed6469d2f42487b9ea1966ef200e488136340` |
| `skills/bowerbird-unified-agent/text-rewrite.ts` | `c67b207fea8867c1ee341d0a53ee773c638e1c24f5180efa97f03d339fbce1e7` |

本机部署证据位于 `.tmp/text-editor-cloud-deploy-20261123/`，最终传输包 SHA-256 为 `d930c9c9481cddf41846c00dabfecb7d1d2bec1657bca271050b619368a29529`。回退先确认共用 Worker 无在途任务，再运行 VPS 上的 `/opt/bowerbird/deploy-backups/text-editor-stream-20261123/release.sh restore`。旧镜像标签为 `bowerbird/generation-worker:rollback-text-editor-stream-20261123`，原五文件位于同级 `host-before/`，恢复时保留现有 Run 和结算记录。
