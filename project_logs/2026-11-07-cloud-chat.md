# 2026-11-07 Cloud 对话部署

用户确认“部署啊”，执行此前已完成源码的 DeepSeek · Cloud／DSH · Cloud 共用聊天服务上线，测试价保持 0 Bcoin。按 ub-mode 先核对现役、再部署最小增量、最后真实验收；工作区其他开发内容未纳入。

## 动作与理由

1. 复核 PROJECT、聊天协议、Cloud 通信、架构和定价约定。公网此前返回 chat-proxy NOT_FOUND；官网已具备对应路由，故不重发网站或桌面包。
2. 保存现役 Edge 清单、数据库迁移／计费函数／服务价格及 VPS 源码、镜像和配置哈希。线上有 0078、没有 0077；Worker 为 `834246b4560cc…`，官网为 `20261106-windows-26.11.602`。密钥值未输出，旧环境只备份在 VPS 的 0600 文件。
3. 复用既有单次 DeepSeek adapter、组合 Worker、Bcoin 账本与桌面对话循环。委派只读兼容审查，额外用 PGlite 演练“先 0078、后 0077”，确认共享计费函数、注册 200 赠币和余额保持。没有新建 Agent Runner。
4. 运行 18 项聊天／DeepSeek 行为测试和聊天数据库测试；两个冻结 Edge 入口 Deno 检查通过。全量 Worker typecheck 在工作区既有 `video-audio-probe.test.ts` 的 `node:child_process.execFileSync` 声明错误处失败；该未上线文件未纳入候选，不宣称全量通过。
5. 在真实库事务内执行 0077 后回滚，验证现役结构兼容；正式部署只应用并登记 0077，没有无筛选 db push。旧计费函数、0078、其他服务价格逐项保持。
6. 基于现役镜像构建增量候选：仅增加聊天消费循环、DeepSeek 可选 max_tokens、聊天模块及三个共享文件；两份服务器 Dockerfile 同步复制规则。候选断网、只读根目录导入真实 main，得到预期无消费循环结果。未更换 Node、依赖、DSH profile 或既有业务实现。
7. 新增专用 CHAT_WORKER_TOKEN，Edge CHAT_ENABLED 保持 false；部署 chat-proxy（平台 JWT 和 requireUser）与 chat-worker（专用 Worker token）。确认现有队列为空后切换 Worker，资源、网络与私有环境权限保持。
8. 检查原有四类消费者正常启动，再设置 CHAT_ENABLED=true。新增 Secrets 使既有 16 个 Edge 版本各加 2，其代码包 SHA、JWT 和入口保持。聊天当前对已登录用户开放，不套用独立 Agent 的测试白名单；账号频率与全局成本限制继续生效。
9. 使用新建隔离账号，经官网网关发送一条短文本。返回“云端对话已就绪”，模型 `deepseek-chat`，521 输入／5 输出 tokens。原请求重放、按键取回和冲突检查证明仅一任务、一 hold、一 confirm(0)，账号余额保持；非法用户／Worker token 和图片输入被拒绝。01:34:05（北京时间）18 项线上检查全部通过，临时 Auth 删除成功，保留账本审计。
10. 下载两条已部署 Edge 的 7 份源文件，与冻结候选逐字核对；回查仅多出 0077、共享计费和其他价格保持、Worker 运行且无聊天轮询错误、官网目录不变。更新项目当前状态、部署文档及本记录，旧里程碑原样移入归档，只提交本轮文档增量。

## 交付与证据

- `chat-proxy v2`：JWT=true，包 SHA-256 `5b1caf0b212dcacecd2cd57ddad83a6c65df3f1968e7f0f0195816d9353b6900`。
- `chat-worker v2`：JWT=false，内部专用 token 鉴权；包 SHA-256 `84dd80b2036d67afd5ed11533615298d6d8051cf333414d1ae123e1f16bc7713`。
- Worker：`sha256:8799ba09e5de45ed620b980f844f1ed8ee99c83cb5ee3bfb359206a1760b7b8e`。
- 本地证据：`.tmp/chat-deploy-20261107/` 的 `db-before.json`／`db-after.json`、`payload-manifest.json`、`worker-before.json`、`candidate-build.log`、`activation.log`、`live-test.json`、`verification.json` 和 `verified/`。
- VPS 回滚：`/opt/bowerbird/deploy-backups/chat-20261107/`；旧镜像标签 `bowerbird/generation-worker:rollback-chat-20261107`。先关闭 CHAT_ENABLED，保留查询、Worker 与原任务结算，不能删除账本或重排未知结果。

Windows 26.11.602 已包含入口，本次无需重发包。真实验收覆盖单次文本服务与计费／恢复；未重新运行桌面 DSH 完整工具轮次、画板建卡或 24 小时真实 TTL 等待。供应商真实模型请求有其自身成本，用户扣费为 0 Bcoin。原支付 Mock、Agent 门控及其他模型开关保持。
