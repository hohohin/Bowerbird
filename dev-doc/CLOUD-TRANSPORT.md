# Cloud 通信与原请求恢复

## 2026-11-06 整改范围

当前产品决策以 PROJECT.md 为准。本专项处理登录、生成、Agent 等入口曾分别修复连接重置而遗留直连路径的问题，不保证消除运营商、代理或服务端的所有网络中断。

- `website/cloud-routes.json` 是桌面 Function 与签名 Storage 路由的共同契约。Rust 构建内嵌，官网从同目录读取；两份发布必须携带同一文件。未登记 Function 返回不可用，网关返回 404，不自动降级直连。官方构建固定官网入口；没有官网配置的隔离测试仍可指向假服务。
- 六个受控 Function：`generate-proxy`、`chat-proxy`、`agent-run`、`understand-proxy`、`visual-profile`、`jev-proxy`。新增路由不启用其业务开关或改变 test-only、订阅与计费权限。
- Agent 清单、参考图片、本机结果上传和用户可见图片下载统一经 `upload_signed`／`download_artifact` 映射；生成视频／音频上传与图片／视频／图层结果继续使用同一受限 Storage 契约。来源必须为配置中的 Cloud HTTPS 源；签名查询原样保留，禁止附带任意 URL、重复签名、路径穿越及跨源地址。存储不携带账号 Bearer／apikey／Cookie。
- 图层文字识别仅开放 `GET /rest/v1/understand_jobs` 的固定列、`limit=1` 和原幂等键精确查询；原用户 Bearer 和 RLS 保持。不开放其他表或任意 REST 查询。
- 账号、支付查单和 Comfy 授权继续走已有账号网关。模型／安装包公共下载、官网更新 CDN、用户配置的本地服务与 BYO provider 属于独立通路，不改成任意网址代理。Cloud HTTP 禁止重定向，网关不自动重试业务请求。

## 断线与诊断

- 正式客户端发送带幂等键的创建请求前，将请求 ID、账号哈希、Function、原幂等键、请求体哈希、版本与时间写入应用数据 `diagnostics/cloud-submissions/<requestId>.json` 并刷盘。只保留身份，不保存正文、密钥、令牌或签名 URL；保存失败时不提交。记录表示曾开始提交，不代表云端接受、生成或扣费成功。
- Agent create 失败只追加一次 `get_by_key` 只读查询，不再调用 create。服务端按当前用户的 billing account → 原 hold → 原 run 查询，并验证原清单哈希、Skill、运行时、图片数量、provider 和视觉规范身份。
- 找到 `uploading` 原任务时只更新签名并继续原上传；找到已排队／运行／终态任务时只读取原状态。查不到或查询失败保留错误和原幂等键，不换新键、不自动重发、不退款。此查询不新增 hold、容量预留、队列状态或模型调用。
- 工作流已有 `submissionStarted`、`agentRunId`、普通生成原 key／job ID、对话原 completion 等恢复保护保持。跨重启时身份日志可供核对；没有云端身份且状态未知的步骤仍需确认原任务，不宣称所有未知任务都能自动继续。
- 连接诊断增加版本、网关／直连、控制／存储／查询阶段及目标主机；授权请求带关联 ID 和耗时，Agent 网关 HTTP 错误保留状态与关联 ID。查询串、签名和正文不进入错误信息。

## 验证与发布

- `node apps/desktop/scripts/cloud-routing-contract.test.mjs` 扫描实际 Rust 调用，拒绝未登记 Function、业务代码直接读取 Supabase URL／REST 地址以及 Agent 绕开公共上传映射；已纳入桌面 `build`。
- `website/scripts/cloud-proxy.test.mjs` 覆盖路由、授权、查询约束、签名和字节保持、大小限制、断开、超时、取消以及付费 POST 不重放；连同账号／更新入口 35 项通过。
- Rust Cloud／Agent 首轮 80 项通过；最终冻结版完整原生回归 1149 项通过、34 项按原规则跳过。Edge 恢复的 3 项内存隔离测试和 Deno check 通过，覆盖丢响应、原任务终态、账号隔离、哈希冲突及无写入。
- 2026-11-06：官网已部署 `20261106-cloud-routing`，原 `20261106-h3-agent-gateway` 可回滚；只改代理并添加契约，86 个其他文件保持。候选／现役／公网各 14 项拒绝路径检查通过，无真实任务／模型调用。
- `agent-run` v53→v54，只新增只读恢复。候选基于下载的现役依赖，不携带工作区尚未部署的文本改写校验、billing 和 FeaturePolicy 差异；原 `verify_jwt=false` 与函数内部 `requireUser` 保持，其他函数版本保持，源码回读一致。备份／证据 `.tmp/cloud-routing-20261106/`。
- Windows 26.11.602 已按源码 4b3c4b92 冻结签名发布，2026-11-06 19:25:05（北京时间）完成公网复核；网关与 Edge 先于客户端部署。TypeScript／Vite、冻结源码 Rust 1149 passed／34 ignored、Cloud 路由构建门禁 2 项、官网 35 项与 Edge 恢复 3 项通过；2002 个冻结输入匹配 Git，76 个资源、x64／双语安装器／更新登录保留钩子、原公钥验签与篡改拒绝、包内原生媒体／等待及生产 bundle 检查通过。 [发布与回滚](DESKTOP-UPDATES.md#windows-2611602-已发布2026-11-06)。官网回滚保留新增路由，不删除任务／账本；另一台故障电脑的真实更新及优化仍待实机验收。
