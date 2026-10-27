# Bowerbird 只读代码 MCP

让 ChatGPT 网页端了解项目：列出文件、按行阅读、搜索代码、查看快照信息。无第三方 npm 依赖，需要 Node.js **24.10+**、Git 和官方 `tunnel-client`。

## 连接结构

```text
本机项目 ──手动导出/筛选/脱敏──> .local/snapshot.json
                                      │ 只读加载到内存
ChatGPT <──官方私有 HTTPS 隧道──> stdio MCP 子进程
                                      └── 无写入/命令/刷新工具
```

采用官方 [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)：隧道客户端主动向 OpenAI 建立 HTTPS 连接，本机 MCP 没有 HTTP 监听端口。访问权限由 Platform 组织和 ChatGPT 工作区的隧道授权控制。不要把本服务接到匿名公网桥或无鉴权的普通隧道上。

这是私有开发工具，不是 Bowerbird 产品内的 Agent Runner，不涉及 Cloud 部署、账号数据库或桌面安装包。

## 首次使用（PowerShell）

1. 在项目根目录生成并检查本地快照：

   ```powershell
   node apps/code-reader-mcp/export.mjs
   node --test apps/code-reader-mcp/test/security.test.mjs
   ```

   `.local/report.json` 记录筛选结果；`.local/snapshot.json` 是实际会开放给 GPT 的文本。两者都被 Git 忽略。快照可能包含业务源码和内部文档，请在连接前检查分享范围。生成快照不上传任何内容。

2. 打开官方文档中的 [Platform 隧道设置](https://platform.openai.com/settings/organization/tunnels)，创建私有隧道并关联你使用的 ChatGPT 工作区。记录 `tunnel_id`。创建者需要 Tunnels Read + Manage；运行专用 key 和使用者需要 Tunnels Read + Use。不要直接使用生产服务密钥。

3. 从官方 [tunnel-client releases](https://github.com/openai/tunnel-client/releases/latest) 安装对应 Windows 版本，将可执行文件加入 PATH，或在下一步传入 `-TunnelClient 'C:\实际路径\tunnel-client.exe'`。先运行 `tunnel-client help quickstart` 核对本机版本。若下载页没有对应平台产物，按其官方安装说明操作，勿下载第三方同名程序。

4. 首次配置并启动，替换隧道 ID：

   ```powershell
   .\apps\code-reader-mcp\start-tunnel.ps1 -TunnelId tunnel_你的ID -Configure
   ```

   脚本隐藏输入隧道 runtime key，不把它写入文件或命令参数；退出时恢复原环境变量。该 key 仅供隧道进程使用，MCP 子进程的环境会清理。先 `doctor` 再 `run`，保留窗口运行。后续继续使用同一 profile 时可省略 `-Configure`；更换 ID 时重新配置。

   如果访问 OpenAI 需要本机代理，请显式传入当前代理地址（下面的端口仅为本机示例）。Windows 浏览器能访问 Platform 不代表隧道进程会沿用系统代理：

   ```powershell
   .\apps\code-reader-mcp\start-tunnel.ps1 -TunnelId tunnel_你的ID -ControlPlaneProxy http://127.0.0.1:7890
   ```

   此参数只设置官方客户端的 `--control-plane.http-proxy`，不改变系统代理、MCP 文件权限或本机 stdio 连接；代理地址不能包含凭据。

5. 在 ChatGPT 的 [Plugins](https://chatgpt.com/plugins) 添加自定义 MCP，Connection 选择 **Tunnel**，选择相同隧道（或填 ID）。本 stdio 服务无额外 OAuth 登录，应用层选择 **No authentication**；访问控制由私有隧道承担，不能据此改用公网匿名访问。页面入口和可用性以账号实际显示为准。

6. 在启用此工具的聊天中验证：

   > 调用 project_overview，再读取 PROJECT.md 和开发计划，概括 Bowerbird 的当前架构。引用文件路径和行号；区分当前实现和待办。只做分析，不修改任何内容。

只有网页端真实工具调用成功才算接入完成。若没有 Tunnel 入口或看不到隧道，检查工作区关联及权限；不能用猜测的公网 URL 替代。此实现无需 OpenAI 模型 API 调用，但官方隧道需要自己的 runtime key。

### 配置失败时的连接验证

不要仅用 `/healthz` 的 `live` 或 `/readyz` 的 `ready` 判断远端连接成功。通过 `.local/health.url` 指向的本机接口读取 `/health?details=true`，检查 `components.control-plane` 的状态、失败原因与成功轮询证据；`/metrics` 中的 `commands_poll_last_successful_timestamp_seconds` 应为近期非零时间。`network_error`、连续失败且成功时间为 0，说明客户端尚未成功连接控制面，即使网页显示“应用配置受到速率限制”，也应先排查出站网络。随后查看 `/health/mcp` 的初始化和工具发现结果，最终用 ChatGPT 的真实 `project_overview` 调用验收。

服务同时支持 MCP `2026-07-28` 的 `server/discover`、逐请求 `_meta` 与 `resultType: complete`，以及旧版 `initialize` → `notifications/initialized` 流程。隧道会复用 stdio 子进程，因此重复旧版初始化会重新开始握手；现代请求独立验证版本和客户端能力，不会打开旧版初始化门禁。两种协议都只调用同样的四个只读工具。

## 只读与保密边界

- **工具能力**：仅 `project_overview`、`list_files`、`read_file`、`search_code`；不提供 shell、文件写入、Git、网络请求或快照导出工具。所有工具声明 `readOnlyHint: true`，实际限制由实现执行。
- **文件权限**：`run.mjs` 用 Node Permission Model 启动服务，只许可读取服务模块和固定快照；不授予文件写入、子进程、Worker 或原生 addon 权限。服务拒绝不带权限约束的直接启动。模型提供的路径只用于查内存索引，永不传给文件系统。
- **导出范围**：固定项目根；只读当前工作区内 Git 已跟踪的文本文件（含未提交修改），另明确纳入 `dev-doc/Bowerbird开发计划.md`。未跟踪文件默认不可见；文件增加/删除后需人工检查范围。`core.mjs` 的白名单控制目录及扩展名，排除点目录、`.env`、Git 数据、密钥文件、日志、数据库、构建产物、资源及测试 fixtures。
- **路径与容量**：拒绝绝对路径、`..`、反斜杠、百分号、Windows ADS；导出拒绝 symlink、junction、硬链接、二进制及单文件 >1 MiB；快照 ≤64 MiB / 10,000 文件。单次请求 ≤64 KiB，读取最多 200 行且有字符上限；搜索是字面匹配，避免正则回溯。
- **凭据**：导出时隐藏疑似 token、带口令 URL、私钥块和常见带引号凭据赋值，保留行号。自动扫描可能漏掉自定义、拆分或未标注的敏感值；不能宣称任何代码都绝对无秘密。将特别敏感文件从白名单排除，审核快照后再授权隧道。
- **信任边界**：Node 权限模型是可信代码的防误用限制，[不是抵御恶意本机代码的 OS 沙箱](https://nodejs.org/api/permissions.html)。本方案假设运行时、服务脚本和本机账号可信；本机管理员仍可改源码、快照或进程。导出期间应避免其他本机进程并发替换目录。需要抵御本机进程攻击时，应再用独立低权限账号/只读容器隔离。
- **数据流向**：GPT 请求的源码片段会发送到 OpenAI 并进入对应聊天的数据处理边界。只读表示不能修改项目，不表示代码不离开本机。MCP 不记录源码和查询正文到日志。

## 更新与撤销

更新代码后，停止隧道（Ctrl+C），重新运行 `export.mjs`，检查快照后重新启动隧道；运行中的服务保持启动时的内存快照，GPT 无权刷新。`revision` 是导出时 HEAD，**不代表未提交修改已提交**，文件 SHA-256 对应脱敏后内容。

临时停用：Ctrl+C 停隧道。长期撤销：在 ChatGPT 移除连接，并在 Platform 禁用/删除隧道或撤销专用 runtime key。快照是本机副本，可按需删除 `.local`；这不能撤回已进入聊天的文本。

## 本轮验证与限制

2026-10-24：10 项本地隔离测试通过，覆盖真实 stdio 初始化/工具调用、未知方法/写入拒绝、路径穿越、junction/硬链接、脱敏、容量限制、源目录不变和 Node 权限拒绝。实际项目快照已成功导出。

2026-10-24 启动准备：官方 Windows amd64 客户端 **v0.0.18** 已安装到 `.local/tunnel-client-v0.0.18`，发布 ZIP 的 SHA-256 已核对为 `8d0da1ce79532d44ccc5ed5d8bd36cdfffba37dfd287c602d69635c8bb5db2b2`，`help quickstart` 和相关命令帮助执行成功。启动脚本自动回退使用该本地客户端，profile 保存在 `.local/profiles`，显式启用 `--mcp.stdio-send-initialized-notification`，管理端口仅监听本机随机端口并将地址写入 `.local/health.url`。

2026-10-24 启动修复：本机 PATH 同时存在多个 Node，PowerShell `Get-Command` 返回数组，旧脚本将其拼为 `System.Object[]`，导致客户端预检找不到程序。现对 Node/隧道客户端均按 PATH 顺序取第一项，保留路径引号，并将 `init` 预检放在密钥输入前。`test/launcher.test.ps1` 覆盖重复 PATH、空格路径、初始化参数和环境恢复；官方客户端使用隔离的合成隧道 ID 实际执行 `init` 已通过，测试未访问远端隧道。

2026-10-24 用户完成配置后，本机实际核验 tunnel-client 进程运行，`/healthz` 返回 HTTP 200 `live`，`/readyz` 返回 HTTP 200 `ready`。隧道客户端已就绪；尚无 ChatGPT 网页端工具调用成功证据，浏览器内容读取持续超时，不能将健康就绪视为网页端验收完成。保留启动窗口运行，再在 ChatGPT 添加/启用同一隧道并调用 `project_overview` 验证。失败退出会恢复原密钥环境，不保存新输入的 key，重试需在本机重新输入。服务实现 MCP 的 stdio 基础生命周期与工具子集，不提供 HTTP/SSE、资源订阅或 sampling。

2026-10-26 更正连接判断：重启后虽然 `live/ready` 为 200，详细健康状态却显示控制面 `network_error`、29 次连续失败、从未成功轮询，MCP 初始化尚未被观察到。无凭据网络探测直连 OpenAI 超时，经用户现有 Windows 代理 `127.0.0.1:7890` 收到预期 HTTP 401（未携带 key），证明代理路径可达，不代表凭据鉴权通过。启动脚本增加显式控制面代理参数，默认直连、参数透传和拒绝带凭据/路径的代理地址测试通过；用户输入 key 后，2026-10-26 10:03（北京时间）核验控制面 status=ok、state=polling，last_success 为 10:02:41、consecutive_failures=0，代理 healthy，成功轮询指标非零；启动期曾有一次 timeout，随后已恢复。MCP initialize/tools_list 仍为 not_observed，尚未收到网页端发现请求，网页端验收仍待完成。

2026-10-26 10:04（北京时间）网页设置请求已到达本机、三次响应投递被控制面接收，但 MCP 发现失败。官方客户端记录同一子进程收到新版 `server/discover` 和两次旧版初始化；旧实现不支持新版发现且拒绝重复初始化。本轮按 [MCP 发现协议](https://modelcontextprotocol.io/specification/2026-07-28/server/discover) 与双版本兼容契约修复。12 项安全／协议测试及启动脚本测试通过；通过官方客户端 v0.0.18 `dev proxy` 回环测试实际完成新版发现、四工具列表、`project_overview` 调用、两次旧版初始化与列表，健康状态 `ok/discovered`、工具目录完整。临时测试进程已停止，用户输入 key 后，10:17（北京时间）实际隧道已加载新进程并成功轮询控制面，连续失败为 0、代理 healthy；该新进程尚未收到网页端发现请求，ChatGPT 网页端最终验收仍待完成；快照未更新。

2026-10-27 用户重新输入 key 后，控制面 ok/polling、连续失败 0、代理 healthy；通过当前已接入的 bbmcp 插件实际调用 project_overview 与 read_file(PROJECT.md) 均成功，确认远端插件到本机只读服务的链路可用。返回快照 createdAt=2026-10-24T09:15:45.264Z、1274 个文件；本次未更新快照。
