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

这是私有开发工具，与 Bowerbird 产品内的 Agent Runner 独立。ChatGPT 使用官方私有隧道；Gemini 网页端使用下方独立子域名方案。

## Gemini 网页端（已部署，账号连接待验收）

根目录 `update-mcp.ps1` 导出当前工作区一次。运行中的 ChatGPT 和 Gemini 在下一次工具调用时校验并读取新快照，Gemini 保留原访问／刷新令牌。新文件损坏、超限或暂时缺失时，两端继续提供上一份有效快照。日志中的 `snapshot-rejected.reason` 区分 `invalid_snapshot`、`size_limit` 和 `read_error`。读错会在下次调用时重试，同一份校验失败的文件只记录一次。Gemini 进程未运行时，统一入口会在导出成功后自动后台启动它。

目标地址为 `https://mcp.bowerbird.cn/mcp`。本机 `http-app.mjs` 复用 `core.mjs` 的四个只读工具与脱敏快照，通过 Streamable HTTP 提供 MCP 2025-03-26／2025-06-18／2025-11-25。HTTP 进程使用与 stdio 相同的 Node 只读文件权限，仅绑定 `127.0.0.1:48731`。公网 Nginx 经受限 SSH 反向转发到本机，VPS 只持有配置和转发公钥。

OAuth 支持 Google 官方回调域名内的动态客户端注册及本机预注册客户端，使用精确回调、S256 PKCE、一次性短时授权码及本机随机授权密码。访问令牌有效期 1 小时。刷新令牌自签发或上次成功刷新起有效 30 天，刷新时复用原值。撤销授权会同时使该授权下的所有访问令牌和刷新令牌失效。授权密码、预注册客户端凭据及 SSH 私钥保留在 `.local/gemini/`。2026-11-15 经用户确认已部署，真实公网 OAuth／工具调用验证通过。详见[部署与验收记录](../../project_logs/2026-11-15-gemini-code-mcp.md)。

2026-11-20 起，Gemini 启动器在本机私有目录 `.local/gemini/oauth/` 原子保存动态客户端注册、访问／刷新令牌的校验摘要和到期时间，HTTP 子进程保持只读。服务启动时校验并恢复有效记录。原始令牌、授权码和授权页面的临时会话不落盘。升级前签发的令牌只存在旧进程内存中，升级后需完成一次 Gemini 授权。之后用相同的本机配置重启服务或电脑可继续使用有效授权。修改本机授权密码或已配置的客户端凭据／回调会使原授权状态失效。

### Apple Silicon／Intel Mac 独立 Gemini 隧道

Windows 的 `@bbmcp` 使用 `https://mcp.bowerbird.cn/mcp` 和 VPS 回环 `48732`。Mac 的 `@bbmcp-mac` 使用 `https://mcp-mac.bowerbird.cn/mcp`、VPS 回环 `48734` 和专用账号 `bowerbird-mcp-mac`。每台机器在自己的 checkout 生成快照，OAuth 状态与本机配置存放在各自的 `.local/gemini/`。Windows 原配置缺少 `remotePort`、`sshUser` 字段时继续采用 `48732`、`bowerbird-mcp`，OAuth 状态继续使用原签发方。

在 Mac 项目根目录使用 Node.js 24.10+。首次准备需要已有可信的 VPS SSH 主机记录。

```bash
node apps/code-reader-mcp/setup-gemini.mjs --origin https://mcp-mac.bowerbird.cn --remote-port 48734 --ssh-user bowerbird-mcp-mac
node apps/code-reader-mcp/prepare-gemini-deploy.mjs
```

Mac 的 `config.json`、SSH 私钥及 `known_hosts` 归当前用户独占读写。部署包位于 `.local/gemini/deployment-mac/`，只包含脚本、配置、转发**公钥**与校验和。已有其他签发方或旧回环配置时，从另一工作树独立初始化，避免破坏原授权。

**部署门禁**。负责人批准后，在火山引擎 DNS 添加 `mcp-mac.bowerbird.cn` 的 A 记录 `106.55.44.143`。核对 DNS、现役 MCP 和官网健康、管理凭据以及远端回环端口可用性。上传并校验 Mac 部署包，在 VPS 执行其中的 `sudo bash activate.sh`。包从现有模板生成独立 `bowerbird-mcp-mac` SSH Match、Nginx 站点、认证限制区及代理 snippet，证书由 Certbot 通过专用 webroot 签发。SSH 仅允许 `127.0.0.1:48734` 远程 TCP 监听，禁止 shell／SFTP、TTY、代理及本地转发。用同一包的 `sudo bash rollback.sh` 关闭 Mac 站点和专用账号，证书及证据留存，DNS 单独回退。核对官网 4173 和 Windows MCP 在上线及回滚前后的健康。

上线后从 Mac 导出并启动，后续运行同一命令热刷新。

```bash
bash apps/code-reader-mcp/update-gemini-mcp.sh
```

该入口先导出本机工作树和未推送改动，成功后复用已经运行的实例。新实例后台启动，PID 与两份启动日志保存在 `.local/gemini/`。回环就绪后，SSH 断开每 5 秒重连。授权成功后，下一次工具调用读取经过校验的快照并保留 OAuth 状态。公网验收时确认匿名 `/mcp` 返回 401，发现文档的 issuer 和 resource 均为 Mac 域名，并在 Gemini 单独新增 `@bbmcp-mac`，授权后调用 `project_overview`，比对快照提交、导出时间及一处未推送文件的 SHA-256。

若 Gemini 要求手动注册，在 Mac 执行 `node apps/code-reader-mcp/setup-gemini.mjs --redirect-uri 'Gemini 复制的精确回调 URL'`。从 Mac 的 `config.json` 取 `oauthClient` 的 ID／secret，重启 Mac 实例加载配置。授权页面单独使用 `adminPassword`。

### 既有 Mac 回环配置

现有 Mac 回环配置使用 `clients` 数组、独立的 origin 和可选的 SSH 参数。保留原来的配置、注册客户端及 `node run-gemini.mjs` 启动方式。首次建立独立配置可用 `node setup-gemini.mjs --origin http://127.0.0.1:48731`。启动器默认只监听回环，显式使用 `--ssh` 时才按该配置启动转发。该模式的授权保存在进程内存中。下文的固定域名与授权持久化流程使用正式服务配置。

### 本机准备

```powershell
node apps/code-reader-mcp/setup-gemini.mjs
node apps/code-reader-mcp/prepare-gemini-deploy.mjs
```

准备程序生成独立 Ed25519 转发密钥、固定来源地址及随机授权密码，并复用本机已经信任的 VPS host key；Windows 文件 ACL 限于当前用户。查看授权密码时在本机打开 `.local/gemini/config.json` 的 `adminPassword`。部署包位于 `.local/gemini/deployment/`，只包含 `deploy/` 配置、安装／回滚脚本、公钥和 SHA256SUMS。

### 本次已确认的部署范围

1. 用户已在火山引擎 DNS 添加 `mcp.bowerbird.cn` 的 A 记录，值 `106.55.44.143`。部署前核实解析，服务器已签发新子域名独立证书，有效期至 2027-02-13。
2. 使用历史部署脚本已核验的管理登录 `ubuntu@106.55.44.143`，身份为本机 `~/.ssh/bowerbird_lighthouse_ed25519`。`root` 公钥登录被拒绝；无需重置服务器密钥或开放 root 登录。
3. 本次已上传部署包至 `/home/ubuntu/bowerbird-mcp-deploy-20261115` 并运行 `sudo bash activate.sh`。脚本先核对 SHA256SUMS、DNS 和空闲端口，再创建 `bowerbird-mcp` 专用账号及 `127.0.0.1:48732` 转发权限，配置专用 Nginx 站点、ACME webroot 和 Certbot 独立证书。SSH 与 Nginx 均先检查语法再 reload。首装若发现同名账号或文件会停止，由操作者检查现状。
4. 专用 SSH key 只允许远程转发到 VPS 回环端口 48732；禁止 shell、SFTP、TTY、代理转发及本地转发。官网继续使用 4173。候选配置位于 `deploy/`，脚本包含失败时禁用 MCP 入口的回退。

### 上线后启动与验收

在任意 PowerShell 中运行以下命令导出快照并启动本机 HTTP 和 SSH 转发，保持窗口开启，Ctrl+C 会结束两个本机进程。已有 Gemini 进程须先 Ctrl+C 停止，再更新启动。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\H\Project\Bowerbird\update-gemini-mcp.ps1"
```

公网 HTTPS 证书、OAuth metadata、匿名 `/mcp` 返回 401、DCR／密码确认／PKCE／刷新／撤销及四工具调用均已验证。接下来在 Gemini Developer Mode 输入目标地址，完成本机授权密码确认，再实际调用 `project_overview` 与 `read_file`，比对快照日期和文件哈希。公网验证脚本属于受控测试客户端，尚不能计作 Google 账号实调。

本轮后台进程记录在 `.local/gemini/run.pid`，输出在 `run.out.log`／`run.err.log`。该 PID 是本次启动实例的记录，操作前应核对实际进程及子进程身份；不要仅凭旧 PID 终止进程。后续使用前台启动命令时先结束当前实例，避免端口占用。

2026-11-16 连接恢复：旧启动器在 SSH 收到 Connection reset 后同时退出 HTTP 服务，公网返回 502，Gemini 因而在打开授权页前显示无法访问。现改为保留 HTTP 及内存授权，每 5 秒重连 SSH；手动停止或 HTTP 本身退出时结束整个实例。真实公网已完成密码授权／PKCE 后，定向结束专用 SSH 子进程，再验证自动重连、原访问令牌和 `project_overview` 可用，测试令牌已撤销。回归使用真实受限 HTTP 子进程模拟掉线并验证 OAuth 注册保留。HTTP 进程前 100 个响应可记录固定路由、方法及状态码，不记录查询串、请求头、正文、密码或令牌。

Gemini 连接窗口的 Client ID／Client secret 属于 OAuth 客户端注册信息。若显示 “Automatic registration with this server failed”，使用预注册凭据，不能继续假设可以留空，也不能把授权密码填入 Client secret：

1. 点击 Gemini 的 **Copy redirect URI**，取得当前应用的完整回调 URL。在本机执行以下命令；占位内容须替换成复制的 URL：

   ```powershell
   node apps/code-reader-mcp/setup-gemini.mjs --redirect-uri '复制的Google回调URL'
   ```

2. 程序在 `.local/gemini/config.json` 保存 `oauthClient.clientId`、`oauthClient.clientSecret` 和精确的 `redirectUri`；再次执行保留原有 ID／secret。只有 Google 官方回调格式可注册，不接受通配符。配置文件仍限本机当前用户读取，不进入 Git、快照或 VPS 部署包。
3. 重启本机 Gemini MCP 加载配置。将 `oauthClient.clientId` 填入 Gemini 的 **Client ID**，将 `oauthClient.clientSecret` 填入 **Client secret**，点击 Next。进入本站 `/oauth/authorize` 页面后，才使用同一文件中的 `adminPassword` 完成只读授权。若重新创建应用导致回调变化，重新执行第 1 步并重启。

2026-11-16 已为用户提供的精确回调生成手动凭据并重启；25 项回归通过，真实公网手动客户端的 Basic／POST secret 认证、密码确认、PKCE、四工具列表、概览、刷新及撤销均通过。自动注册的回调数量上限从 5 调整为 16，可容纳 Google 文档列出的六类回调；每条仍单独校验并精确绑定。先前真实 DCR 400 只记录了状态，尚不能确定具体拒绝字段；现新增固定原因码诊断，不记录提交内容。Google 账号的实际连接结果仍需对应账号确认。

2026-11-16 授权页原生表单修复：真实 Chrome 复现提交密码后 `Origin: null`、403 `forbidden`。根因为全局 `Referrer-Policy: no-referrer` 也会清除原生表单 POST 的 Origin；旧协议测试手动设置 Origin，未覆盖此浏览器行为。授权 HTML 现单独使用 `same-origin`，其余响应保留 `no-referrer`；CSP 的 `form-action` 仅额外允许当前精确注册回调所属的官方 Google 域名，避免 Chrome 阻止授权码回跳。同源／密码／Cookie／PKCE／精确回调校验仍保留，缺失或 `null` Origin 继续拒绝。已重启本机服务，以真实 Chrome 经公网完成原生密码提交、Google 回跳放行、PKCE 换码、四工具发现和测试授权撤销。重启前打开的授权页须关闭，从 Gemini 重新发起；原客户端凭据与授权密码无需更换。

原有 25 项隔离回归之外，新增可选浏览器回归（需工作区 html-renderer 的 Playwright 与已安装 Chrome），覆盖原生 Origin／Secure Cookie、旧策略的 `null` Origin 拒绝及 Google 回跳放行；浏览器 DNS 禁用，使用隔离 HTTP fixture，不连接 Google 账号：

```powershell
node --test apps/code-reader-mcp/test/consent.browser.mjs
```

回退先停止本机窗口，在 VPS 部署目录运行 `sudo bash rollback.sh`。脚本禁用独立站点、撤销转发账号、公钥和连接，并重载通过语法检查的配置；证书和部署证据保留在 `/var/lib/bowerbird-mcp` 供复核。DNS 记录另行撤销。再次部署前需核对保留文件及证书，不能盲目重跑首装脚本。

2026-11-15 准备核验：管理用户 SSH 成功，现役官网 active，证书 SAN 为 `bowerbird.cn`／`www.bowerbird.cn`，至 2027-01-22 到期；现役允许 SSH 转发且 GatewayPorts=no，48732 及专用账号可用。候选 Nginx 在内存配置中通过语法测试，测试时临时引用已有官网证书以校验配置；候选 sshd 及安装／回退 Bash 语法通过。展开候选 sshd 有效配置，确认仅允许 remote 转发、PermitListen=127.0.0.1:48732、PermitOpen=none、MaxSessions=0，禁用 TTY／密码／Agent 转发。18 项本机回归通过，含公有／机密客户端注册、PKCE／刷新／撤销、Host／Origin、真实受限 HTTP 进程及原 stdio 安全测试；Windows PowerShell 5.1 入口语法通过。没有启用候选配置、签发新证书或创建服务器账号。

## 日常更新并启动（PowerShell）

在项目根目录 `.env.tunnel` 填入 `MCP_UPDATE_KEY=你的隧道runtime key`，支持不带引号、单引号或双引号的单行值。文件已被 Git 忽略，且在快照排除范围内。

在任意目录运行一行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\H\Project\Bowerbird\update-mcp.ps1"
```

入口读取本机配置，导出成功后复用同一可执行文件和项目 profile 的 GPT 隧道，隧道未运行时执行检查并启动。此入口使用现有 tunnel ID 和 `http://127.0.0.1:7890` 代理，首次启动后保持代理和隧道窗口开启。根目录脚本加 `-RestartTunnel` 可强制重启 GPT 端并加载新版服务代码。升级此次修改前已启动的 Gemini 也需重启一次以加载新读取器和元数据字段；有效的持久化授权随启动恢复。日常更新快照无需再重启。密钥文件缺失、配置为空或重复时停止操作。覆盖检查失败时保留原快照和隧道。

## 在本机选择分支

从项目根目录启动控制台，浏览器会自动打开。

```powershell
pnpm --filter @bowerbird/code-reader-mcp console
```

在「本地分支」找到目标行并点击「更新快照」。当前分支默认导出工作区中符合筛选规则的文件，勾选「仅导出干净 HEAD」可分享已提交内容。其他本地分支按页面所列的提交在系统临时目录建立 detached worktree，清理后才发布。页面显示导出文件数、脱敏行数和覆盖检查结果。失败时查看页面原因或同目录的覆盖报告。

两端同时使用最近发布的一份快照。调用 `project_overview` 可核对 `branch`、`revision`、`isDirty` 和 `createdAt`。旧快照未记录的分支和工作区状态返回 `null`。直接从 detached 工作区导出时分支标记为 `(detached HEAD)`。控制台只监听本机回环地址，发布操作校验 Host 与同源 Origin。关闭控制台不会停止只读 MCP 服务。

运行 `pnpm --filter @bowerbird/code-reader-mcp test` 可在临时仓库验证切换、失败回退和工作区完整性。已安装 Chrome 和仓库内 Playwright 时，`pnpm --filter @bowerbird/code-reader-mcp test:browser` 还会实际点击分支按钮并验证授权页面。

## 首次使用（PowerShell）

1. 在项目根目录生成并检查本地快照：

   ```powershell
   node apps/code-reader-mcp/export.mjs
   node --test apps/code-reader-mcp/test/security.test.mjs
   ```

   `.local/report.json` 记录最近一次完成覆盖检查的导出尝试，含门禁失败的诊断。`.local/snapshot.json` 是实际共享给两端的文本，可按 `createdAt` 匹配报告。两者都被 Git 忽略。快照可能包含业务源码和内部文档，请在连接前检查分享范围。生成快照不上传任何内容。

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
- **导出范围**：固定项目根，以 Git 已跟踪文本及 `EXPLICIT_FILES` 为起点，递归补齐静态本地依赖，并按命名、源码文件名引用查找相关测试。发现的未跟踪源码也可进入候选。所有候选均执行相同的路径、链接、容量及脱敏检查，排除点目录、`.env`、Git 数据、密钥文件、日志、数据库、构建产物、资源及测试 fixtures。源码／测试／脚本目录中的 Python 文件受支持；`auth.ts`／`auth.rs` 等源码可读取，`auth.json` 等凭据配置继续排除。
- **路径与容量**：拒绝绝对路径、`..`、反斜杠、百分号、Windows ADS；导出拒绝 symlink、junction、硬链接、二进制及单文件 >1 MiB；快照 ≤64 MiB / 10,000 文件。单次请求 ≤64 KiB，读取最多 200 行且有字符上限；搜索是字面匹配，避免正则回溯。
- **凭据**：导出时隐藏疑似 token、带口令 URL、私钥块和常见带引号凭据赋值，保留行号。自动扫描可能漏掉自定义、拆分或未标注的敏感值；不能宣称任何代码都绝对无秘密。将特别敏感文件从白名单排除，审核快照后再授权隧道。
- **信任边界**：Node 权限模型是可信代码的防误用限制，[不是抵御恶意本机代码的 OS 沙箱](https://nodejs.org/api/permissions.html)。本方案假设运行时、服务脚本和本机账号可信；本机管理员仍可改源码、快照或进程。导出期间应避免其他本机进程并发替换目录。需要抵御本机进程攻击时，应再用独立低权限账号/只读容器隔离。
- **数据流向**：GPT 请求的源码片段会发送到 OpenAI 并进入对应聊天的数据处理边界。只读表示不能修改项目，不表示代码不离开本机。MCP 不记录源码和查询正文到日志。

## 更新与撤销

委派网页 agent 规划前，先导出所需分支，再让规划者调用 `project_overview`。核对分支、提交和导出时间，并检查 `coverageCheck`。相同 HEAD 下仍可能有新的未提交改动。

### 自动依赖补齐与覆盖检查

`dependencies.mjs` 只分析文本，不执行项目代码。支持 JS／TS 静态 import／export、字面量 require／import()、`@/` 源码别名、扩展名与 index 解析，以及 Rust `mod`／`#[path]`／`include_str!`／`include_bytes!`／`include!` 的字面量路径。自动补齐递归执行并去重，再发现相邻单元测试、scripts／test／tests 下的相关测试，测试的静态依赖也进入同一检查。新的无引用实现、生成器和独立数据库迁移仍可能需要显式清单。

本机存在却因链接、容量或策略限制而不可导出的核心源码依赖，会使导出以失败状态结束，写出 `.local/report.json` 的具体来源、目标和原因，保留之前的 `snapshot.json`。fixtures、第三方依赖、构建产物及冻结预览 bundle 的排除单独记录。文件在本机就不存在、或路径由表达式动态拼接时，记录为待核验引用，不能据此宣称已覆盖其运行时行为。

成功快照携带覆盖元数据。`project_overview.coverageCheck` 展示检查状态、补齐依赖／测试数量、未解决核心依赖数、排除数量、待核验引用数量和样例；完整清单在本机报告中。`checked` 表示已解析的现存静态核心依赖通过门禁，测试关联采用启发式，不能替代动态路径和业务行为审查。旧快照返回 `not_recorded`。

2026-11-16 验证覆盖了 DSH 自动安装／登录／宿主、订阅设置组件和通知消除持久化，以及 Python 原生测试、账户 fixture 和 UI 测试。递归循环、Rust 原始字符串／生命周期、计算路径、关联测试、受限核心依赖失败保留旧快照和旧元数据兼容均有回归。

导出使用随机临时文件并在同目录原子替换，Windows 遇到短暂共享冲突会重试。每个文件在读取和脱敏后分别检查 1 MiB 上限。`revision` 是导出时的 HEAD，`isDirty` 按 Git 工作区状态计算，包含暂存、未暂存和非忽略的未跟踪文件。文件 SHA-256 对应脱敏后实际共享的内容。`project_logs/` 保持排除，该目录存放历史验收和运维记录，代码快照的文档入口是 `PROJECT.md`、`GLOSSARY.md` 和允许的专项文档。

临时停用：Ctrl+C 停隧道。长期撤销：在 ChatGPT 移除连接，并在 Platform 禁用/删除隧道或撤销专用 runtime key。快照是本机副本，可按需删除 `.local`；这不能撤回已进入聊天的文本。

## 本轮验证与限制

2026-10-24：10 项本地隔离测试通过，覆盖真实 stdio 初始化/工具调用、未知方法/写入拒绝、路径穿越、junction/硬链接、脱敏、容量限制、源目录不变和 Node 权限拒绝。实际项目快照已成功导出。

2026-10-24 启动准备：官方 Windows amd64 客户端 **v0.0.18** 已安装到 `.local/tunnel-client-v0.0.18`，发布 ZIP 的 SHA-256 已核对为 `8d0da1ce79532d44ccc5ed5d8bd36cdfffba37dfd287c602d69635c8bb5db2b2`，`help quickstart` 和相关命令帮助执行成功。启动脚本自动回退使用该本地客户端，profile 保存在 `.local/profiles`，显式启用 `--mcp.stdio-send-initialized-notification`，管理端口仅监听本机随机端口并将地址写入 `.local/health.url`。

2026-10-24 启动修复：本机 PATH 同时存在多个 Node，PowerShell `Get-Command` 返回数组，旧脚本将其拼为 `System.Object[]`，导致客户端预检找不到程序。现对 Node/隧道客户端均按 PATH 顺序取第一项，保留路径引号，并将 `init` 预检放在密钥输入前。`test/launcher.test.ps1` 覆盖重复 PATH、空格路径、初始化参数和环境恢复；官方客户端使用隔离的合成隧道 ID 实际执行 `init` 已通过，测试未访问远端隧道。

2026-10-24 用户完成配置后，本机实际核验 tunnel-client 进程运行，`/healthz` 返回 HTTP 200 `live`，`/readyz` 返回 HTTP 200 `ready`。隧道客户端已就绪；尚无 ChatGPT 网页端工具调用成功证据，浏览器内容读取持续超时，不能将健康就绪视为网页端验收完成。保留启动窗口运行，再在 ChatGPT 添加/启用同一隧道并调用 `project_overview` 验证。失败退出会恢复原密钥环境，不保存新输入的 key，重试需在本机重新输入。服务实现 MCP 的 stdio 基础生命周期与工具子集，不提供 HTTP/SSE、资源订阅或 sampling。

2026-10-26 更正连接判断：重启后虽然 `live/ready` 为 200，详细健康状态却显示控制面 `network_error`、29 次连续失败、从未成功轮询，MCP 初始化尚未被观察到。无凭据网络探测直连 OpenAI 超时，经用户现有 Windows 代理 `127.0.0.1:7890` 收到预期 HTTP 401（未携带 key），证明代理路径可达，不代表凭据鉴权通过。启动脚本增加显式控制面代理参数，默认直连、参数透传和拒绝带凭据/路径的代理地址测试通过；用户输入 key 后，2026-10-26 10:03（北京时间）核验控制面 status=ok、state=polling，last_success 为 10:02:41、consecutive_failures=0，代理 healthy，成功轮询指标非零；启动期曾有一次 timeout，随后已恢复。MCP initialize/tools_list 仍为 not_observed，尚未收到网页端发现请求，网页端验收仍待完成。

2026-10-26 10:04（北京时间）网页设置请求已到达本机、三次响应投递被控制面接收，但 MCP 发现失败。官方客户端记录同一子进程收到新版 `server/discover` 和两次旧版初始化；旧实现不支持新版发现且拒绝重复初始化。本轮按 [MCP 发现协议](https://modelcontextprotocol.io/specification/2026-07-28/server/discover) 与双版本兼容契约修复。12 项安全／协议测试及启动脚本测试通过；通过官方客户端 v0.0.18 `dev proxy` 回环测试实际完成新版发现、四工具列表、`project_overview` 调用、两次旧版初始化与列表，健康状态 `ok/discovered`、工具目录完整。临时测试进程已停止，用户输入 key 后，10:17（北京时间）实际隧道已加载新进程并成功轮询控制面，连续失败为 0、代理 healthy；该新进程尚未收到网页端发现请求，ChatGPT 网页端最终验收仍待完成；快照未更新。

2026-10-27 用户重新输入 key 后，控制面 ok/polling、连续失败 0、代理 healthy；通过当前已接入的 bbmcp 插件实际调用 project_overview 与 read_file(PROJECT.md) 均成功，确认远端插件到本机只读服务的链路可用。返回快照 createdAt=2026-10-24T09:15:45.264Z、1274 个文件；本次未更新快照。
