# Gemini 只读代码 MCP 部署与验收

用户明确确认执行第二步及部署和连接验证后完成本次上线。用户已配置 DNS，部署前在 VPS 核验 `mcp.bowerbird.cn` 解析至 `106.55.44.143`。

## 生效配置

- 管理登录为 `ubuntu@106.55.44.143`，复用本机 Lighthouse SSH key，host key 采用严格核验。此前 root 登录失败源于登录用户选择，不需要更改服务器管理密钥。
- 公共部署包上传至 `/home/ubuntu/bowerbird-mcp-deploy-20261115`，安装前 SHA256SUMS 全部通过。服务器证据副本保留在 `/var/lib/bowerbird-mcp/deploy/`，仅含配置、脚本、公钥及校验和。
- 新增 Nginx `bowerbird-mcp` 独立站点、`bowerbird-mcp-proxy.conf` snippet、`90-bowerbird-mcp.conf` sshd 限制，以及 `bowerbird-mcp` 专用转发账号。仅允许 `remote` 转发至 `127.0.0.1:48732`，`GatewayPorts=no`、`MaxSessions=0`、`PermitOpen=none`，禁止密码、TTY 和 Agent 转发。
- Certbot 使用独立 ACME webroot 签发 `mcp.bowerbird.cn` 证书，SAN 精确匹配新域名，有效期至 2027-02-13；配置了自动续期。Nginx／SSH 均先验证语法再 reload。
- 本机 `run-gemini.mjs` 已在后台启动，派生的 HTTP 进程使用 Node 只读权限、净化环境与固定快照，仅监听 `127.0.0.1:48731`；独立 SSH key 把 VPS 48732 转发至本机。运行实例 PID 记录及日志位于 `.local/gemini/`，PID 不是持久身份，终止前须核对命令和父子进程。

## 验收

- 18 项本机安全和协议回归通过，覆盖原 stdio 与新增 HTTP／OAuth。
- 真实公网 TLS 验证通过；授权服务器及受保护资源 metadata 可读取；匿名 `/mcp` 返回 401，带有授权发现信息。
- 通过真实 HTTPS 链路注册受控测试客户端，完成授权页面、密码／cookie／Origin 校验、S256 PKCE 换码和 MCP 2025-11-25 初始化。
- 四个只读工具均调用成功，读取 `PROJECT.md`、`control-transport.ts`、`settingsQueue.ts` 的 SHA-256 与本机快照一致。返回快照 `createdAt=2026-11-15T04:12:27.758Z`，北京时间 12:12，2425 个文件。
- 刷新令牌成功，撤销后原访问令牌立即返回 401。测试令牌已撤销，密码与令牌未输出到聊天或验证报告。
- 使用实际专用 SSH key，打开 shell 被拒绝，试图转发 48733 被拒绝；48732 仅在 VPS 回环接口监听。
- 官网 Nginx 配置 SHA-256 前后保持 `5a14126f96529e6330030f73adcb64409c404bd434f0893655ef4823c930e2d5`，官网 systemd 服务激活时间前后保持 2026-11-14 00:29:55 CST。

本机验证摘要在 `.local/gemini/public-verification.json`，官网基线在 `website-before.txt`／`website-after.txt`。这些文件均被 Git 忽略。

## 尚待用户账号完成的验收

公网受控客户端验证不代表 Gemini 账号已经连接。已请求用户在 `https://gemini.google.com/devmode` 创建自定义应用，填写 `https://mcp.bowerbird.cn/mcp`，使用本机 `.local/gemini/config.json` 中的 `adminPassword` 完成授权，再由 Gemini 调用 `project_overview` 返回日期和文件数。当前该步骤待用户反馈。

动态 OAuth 客户端注册与令牌驻留内存，HTTP 服务重启后需要重新连接并授权。2026-11-16 新增的手动客户端凭据保存在本机配置，可跨重启继续使用。账号入口是否可用仍取决于 Google 向该账号开放的功能。

## 2026-11-16 断线修复与复验

用户截图停在 Gemini 的连接窗口，提示 MCP server could not be reached，尚未进入本站授权页面。本机日志为 SSH Connection reset 后启动器退出，公网 `/mcp` 和授权 metadata 均为 502，VPS 转发端口未监听。修复后 SSH 关闭仅触发 5 秒重连，HTTP 进程及已有内存授权保留。新增回归在真实受限 HTTP 子进程上模拟 SSH 失败，验证重连期间健康接口和已注册 OAuth 客户端继续可用。

北京时间 2026-11-16 10:59，通过真实公网完成测试客户端的授权及 PKCE 换码，再精确结束该启动器的 SSH 子进程，等待自动重连，以原访问令牌调用 `project_overview` 成功。返回快照 `2026-11-15T17:03:29.613Z`，2459 个文件。测试令牌已撤销，摘要在 `.local/gemini/reconnect-verification.json`。新增诊断每个 HTTP 实例最多记录 100 条固定路由、方法与状态，不含请求参数和凭据。已请求用户重新点击 Next，Gemini 账号本身的连接结果仍待反馈。

## 2026-11-16 自动注册失败与手动凭据

用户再次尝试后，固定路由日志显示 metadata 200、匿名 MCP 401、`POST /oauth/register` 400，截图变为自动注册失败并要求手动填写 ID／secret。旧日志未记录拒绝字段，无法确定该次 DCR 的具体原因。新增固定原因码诊断，并将注册回调数量上限从 5 调至 16，覆盖 Google 文档列出的六类回调；不放宽官方域名及精确回调限制。

复用本机 `setup-gemini.mjs --redirect-uri` 生成预注册 ID／secret，绑定用户从 Gemini 复制的实际回调，保存到 ACL 限于当前用户的 `.local/gemini/config.json`。HTTP 启动时加载配置，手动客户端接受 Basic／POST secret 认证，仍要求密码同意、PKCE 和精确回调。凭据跨 HTTP 重启保留，已有授权令牌仍仅驻留内存。没有更改 VPS 配置或官网。

25 项隔离回归通过，新增用例覆盖预注册跨服务重建、错误 secret／PKCE／回调拒绝、六类回调动态注册和固定拒绝原因。北京时间 2026-11-16 11:25，使用真实公网及新预注册凭据完成 Basic 和 POST 两种认证、密码同意、PKCE、MCP 初始化、四工具发现、概览、刷新及撤销；快照为 `2026-11-15T17:03:29.613Z`、2459 文件。测试令牌已撤销，摘要保存在 `.local/gemini/manual-client-verification.json`。已向用户说明从本机文件复制客户端凭据，Google 账号实调尚待反馈。

## 2026-11-16 原生浏览器授权 403 修复

用户已能进入授权页，但提交 `adminPassword` 后返回 `{"error":"forbidden"}`。真实公网 Chrome 复现授权页 200、`Referrer-Policy: no-referrer`、原生表单 `Origin: null`、提交 403。该行为符合 [Fetch 的 Origin 生成规则](https://fetch.spec.whatwg.org/#append-a-request-origin-header)；此前协议测试手动指定 Origin，未涵盖浏览器实际生成请求头的过程。

最小修改仅覆盖授权 HTML 的来源策略为 `same-origin`，其余响应保留 `no-referrer`。Chrome 随后暴露原 `form-action 'self'` 也会阻止 302 到 Google；授权 HTML 的 CSP 额外允许当前精确注册回调的 Google origin。所有回调仍先校验官方域名并精确绑定，来源／密码／Cookie／PKCE 校验不变，`null` 或缺失 Origin 继续拒绝。没有修改 Nginx、服务器账号或官网。

新增可选 `test/consent.browser.mjs`／`test:browser`，借用工作区 renderer 的 Playwright 和 Chrome；路由转发到隔离 HTTP fixture，禁用浏览器 DNS，验证原生 POST Origin、Secure Cookie、Google 回跳可发起，以及人为恢复旧策略时 `null` Origin 继续被拒绝。修复前该浏览器回归失败；修复后 25 项原回归及 1 项浏览器回归通过。

北京时间 2026-11-16 11:46，重启本机受限 HTTP／SSH 后，真实公网 Chrome 原生密码提交 Origin 为 `https://mcp.bowerbird.cn`、响应 302，Google 回跳允许发起；测试阻断了向真实 Google 回调投递，以本机受控客户端完成后续 PKCE 换码和四工具发现，并撤销测试授权。摘要保存在 `.local/gemini/browser-consent-verification.json`，未输出密码、secret 或令牌。已通知用户关闭旧授权页，从 Gemini 重新发起连接；原凭据无需修改，Google 账号实际连接仍待反馈。

## 回退操作

停止本机 HTTP／SSH 实例后，在服务器本次部署目录运行 `sudo bash rollback.sh`，禁用独立站点、删除转发账号的授权公钥和账号、结束其连接，并移除专用 SSH／Nginx 配置。官网配置单独保留。证书与部署证据保留以便复核，DNS 记录可另行撤销。
