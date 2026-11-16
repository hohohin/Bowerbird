# DeepSeek 模型请求取消与截止时间 · 生产部署记录

2026-11-15 北京时间 01:41:44 启动新 VPS Worker，01:42:31 复核运行状态。用户已明确确认本轮部署与核验。

## 版本

- 基底与回退镜像 `sha256:3a2dd891316cc282d39616e483353214c2d33aa34255a13ece700b78fe33e9c7`。
- 现役镜像 `sha256:cf2c2eef3d557f76b74372de7ab922bfa5bb24af8a4236a290f25dbc490935bb`。从容器读回下列文件，与本轮候选逐一比对。

| 文件（相对 Worker src） | SHA-256 |
|---|---|
| `cloud-chat/runtime.ts` | `ac2e86c49a0da84f54393743fc00462aa8620964d55001f09af883da08f4a423` |
| `contracts/model.ts` | `00ab76a53ebf041f62e9482f82db3417574fff27caf9736f8d4ad63800624617` |
| `providers/deepseek/backend.ts` | `69e4d08a8098bd52b48e29592686fe387f10e902b90375120a1b43ef7b25da85` |
| `skills/bowerbird-html-layout-render/runner.ts` | `2bcdf0abf61cd8a57708d088538d4937c1c39b59b2bf97264ed964d6012ec4a8` |

前一轮控制传输及租约修复的 7 个文件另行核对，哈希均与前一轮上线记录相同。HTML Skill 在前后两个容器中以正式 loader 验证，身份均为 `bowerbird-html-layout-render 0.1.0 6a8065dc253ad1896da3a122a215ec2eafd8bf265d1e829f234032f0b8e86106`。

## 验收与边界

- 生产候选基于上述现役基底叠加四文件，使用网络隔离、根文件系统只读的容器验证 8 个套件，79 项全部通过。4 个环回 HTTP 用例实测请求发出后等待响应头超时、收头后正文超时、收头后租约失效、聊天适配器收到主动取消。每例服务端记录 1 次请求并观察到 socket 关闭。慢正文可在既有预算内返回，结束后清理定时器和取消监听。开发树的 9 个专项套件 88/88。
- 领取与结算继续使用原任务，控制传输的截止时间不用于模型调用。HTML 排版在模型调用期间持续观察原租约状态。Agent 默认 60 秒、视觉提炼默认 180 秒、普通聊天 90 秒的既有预算均沿用。
- 切换前后五类活动队列均为 0。01:42:31 检查生成、理解、Agent、视觉四个启动事件，自新容器启动以来领取与轮询错误数为 0。容器运行中，0 重启，未发生 OOM。环境、Compose、网络、资源限制、挂载、命令和入口参数摘要均与切换前一致。本次未调用真实模型，未修改 Edge、数据库、定价、官网或桌面端。

## 证据与回退

本地脱敏核验记录位于 `.tmp/deepseek-cancel-20261115/` 的 `worker-before.json`、`worker-active.json`、`queues-at-switch.json` 和 `verified.json`。VPS 备份目录 `/opt/bowerbird/deploy-backups/deepseek-cancel-20261115` 含四个原文件、候选测试日志与部署回执。回退标签为 `bowerbird/generation-worker:rollback-deepseek-cancel-20261115`。回退时先检查活动队列并复核当前镜像版本，恢复该备份的四文件，再沿原 Compose 切回基底镜像，并复核队列、启动事件和文件哈希。
