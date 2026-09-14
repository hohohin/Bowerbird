# Pro 兑换码

产品规则以根目录 `PROJECT.md`「Pro 兑换码」为权威。本文件记录实现、发码和验收方式。

## 实现

- `0059_pro_redemption_codes.sql`：哈希码表、一次性兑换回执、账号尝试计数和 `redeem_pro_code` 服务端 RPC。`0060_pro_code_admin.sql` 增加管理批次、加密取码、管理员审计及 RPC。客户端无表访问/函数执行权限；Edge 从 Auth 验证后的用户身份取 user_id，不接受客户端的 tier、积分数或有效期。
- 兑换、订阅更新、`grant_subscription_credits` 的批次/流水/余额均在同一事务。码行锁防止两人争抢；账号锁序列化多个码的续期。同码同账号重试返回原回执，不重新延长会员或积分有效期。不同账号无法读取原兑换人。
- 每账号 15 分钟最多 10 次格式有效的兑换尝试，失败计数也会提交。128 位随机码只存 SHA-256；不记录明文请求。格式错误在 Edge 拒绝，真实流式请求体最多 1024 字节。
- Pro 时长按上海时区一个自然月计算，月末截到下一月最后一天；积分每次立即发 1100 分，30 天有效。有效 Pro 保留原 provider/订阅标识/计费周期，不影响现有的已发积分；每次回执记录独立积分到期日。
- Rust 使用现有 AuthClient JWT 刷新与重试，随后获取现有 entitlement 签名快照。兑换已成功而刷新失败时，界面显示成功及「刷新权益」提示；未收到兑换结果可使用同一码重试确认。

## 部署顺序

2026-09-14 经用户明确授权，数据库、两个 Edge 接口及官网管理后台已上线，24 项真实线上验收通过。正式部署沿用 `DEPLOY.md` 的凭据与核验流程：

1. 检查远端迁移与本地一致，依次新增 `0059_pro_redemption_codes.sql`、`0060_pro_code_admin.sql`（不要用独立生产 SQL 跳过迁移记录）。
2. 部署 `redeem-code` 和 `code-admin`，两者保持 `verify_jwt=true`。复用现有 Auth/服务端密钥与 CORS 配置；`code-admin` 另外需要下述发码加密密钥，不需要更改 Worker 或支付开关。
3. 用临时测试账号和仅测试码验证：未登录 401、兑换 Pro + 1100、同码重放不重复、另账号拒绝、entitlement 签名刷新、清理/停用测试码。保留计费审计回执，不删除已发生的账本。
4. 重建桌面应用才会出现新入口。发放正式兑换码前完成线上验证。

## 可视化管理后台

页面源码在 `website/admin/`，随现有官网 build 输出到 `dist/admin/`。官网路径 `/admin/`（`/admin` 自动跳转）支持邮箱 Magic Link 登录；管理员可以生成每批 1–1000 个码、填写批次备注及兑换截止时间、查看总数与状态、分页/筛选/搜索批次或尾号或领取账号、按码查看/复制、按批次导出仍可使用的码，以及确认后停用未使用码。**已于 2026-09-14 发布至 https://bowerbird.cn/admin/；正式管理员为 `admin@bowerbird.cn`。**

### 管理员授权

2026-09-14 已核验 `admin@bowerbird.cn` 为已验证邮箱的现有账号，并通过 Auth 管理 API 合并添加 `bowerbird_admin=true`；随后重新读取账号，确认权限生效、其他 app metadata 保持。仅变更这一账号标记，未发送登录邮件或修改密码、订阅与积分。部署后未登录调用两个接口均返回 401，官网后台返回 200；正式管理员标记已再次回读确认。无密钥的验证回执保留在本地 `.tmp/code-admin-account-verified.json`。

仅认证成功且 **Auth `raw_app_meta_data.bowerbird_admin` 为 JSON 布尔值 true** 的账号可操作。`user_metadata`、测试账号标记、Pro 等级或客户端提交的管理员字段均不授予权限。Edge 每次调用 Auth 校验，所有管理 RPC 还会重新读取 Auth 表核验标记，撤销后旧 JWT 也不能继续操作。

部署时先让指定管理员拥有一个现有 Bowerbird 账号，核对其邮箱与用户 ID，再由有权限的部署者通过 Supabase Auth 管理 API 或 SQL Editor 合并设置标记；保留该账号其他 app metadata。此权限不可通过本后台自行提升。示例（将占位 UUID 替换为已核验 ID）：

```sql
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"bowerbird_admin":true}'::jsonb
where id = '<已核验的管理员 Auth UUID>'::uuid;
```

撤销时仅移除 `bowerbird_admin` 键。任何人都可以打开公开的登录页面，但只有上述账号能读取数据、发码或取码。界面收到 401/403 或退出时会清空已展示码单；管理响应 `Cache-Control: no-store`。

### 加密密钥与登录配置

- 新增 Edge Secret `PRO_CODE_ENCRYPTION_KEY`：随机 32 字节的 base64。可使用 Node `crypto.randomBytes(32)` 生成并直接写入权限受控、gitignored 的私有 env 文件，再由 Supabase CLI `secrets set --env-file <私有文件>` 上传。**不要打印密钥或写到官网环境、前端资源、桌面配置、Worker。**
- 管理后台生成的码使用 AES-256-GCM 加密保存，随机 12 字节 nonce，记录 ID 作为认证附加数据；数据库仍使用原 SHA-256 哈希核销。密钥须妥善备份；丢失后既有码仍可兑换，但后台无法恢复明文；轮换前必须先用旧密钥重加密数据，不能直接覆盖。
- 官网只需要公开 `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY`。后台通过已有 `/api/image-config` 读取这两项；官网不持发码密钥或 Supabase secret。
- Supabase Auth Redirect URLs 加入正式 `https://<官网域名>/admin/`；本地开发按实际端口添加相应回调。既有正式同源 `/**` 规则已覆盖则无需重复。后台沿用现有邮箱登录 SDK，独立登录存储名为 `bowerbird.admin.auth`，退出仅退出当前浏览器会话。
- `ALLOWED_ORIGINS` 须包含官网 origin。不要为后台开放任意来源或关闭 JWT 检验。

### 管理行为与兼容性

- 批次 UUID 是发码幂等键；UI 在请求前保存请求信息到当前标签页 sessionStorage，未知网络结果可以使用同一请求重试。服务端只提交一批，参数不一致会拒绝。密文、哈希和批次一次性提交，部分失败整批回滚。
- 表格只显示码尾八位。主动查看/导出时才解密，只有仍可用且有密文的码会返回。码单关闭或退出即清空内存，CSV 对批次备注做公式前缀转义。后台不自动发送邮件或消息给用户，由管理员自行发放。
- 旧版离线脚本生成的码没有密文或批次，仍可兑换、查询与停用；后台提示使用原始码单，不能凭哈希还原明文。
- 单码停用采用与用户兑换相同的码行锁。已兑换码拒绝停用且保持已发权益；未兑换码停用后不能兑换。本版不提供撤销已发生的兑换、恢复停用码或改写到期时间。
- `pro_code_admin_events` 记录发码、停用、查看及导出请求的操作人/批次/码 ID，不记录明文。查看批次不代表已发放，导出的未兑换码也可能已交给用户，分发名单由发放者管理。

本地验证：

```powershell
node apps/cloud/scripts/pro-code-admin-db.test.mjs <本机 PGlite 模块路径>
deno test apps/cloud/supabase/functions/_shared/pro-code-admin_test.ts
deno check apps/cloud/supabase/functions/code-admin/index.ts
pnpm --filter @bowerbird/website build
node website/scripts/admin-ui.test.mjs website/dist
```

管理数据库测试覆盖原子批次、重复请求、权限/撤权、分页/筛选、密文不进入列表、导出过滤、停用/兑换两种先后顺序、审计及失败回滚；PGlite 单连接，不宣称已完成线上多连接竞争测试。UI 在隔离 Auth/API 替身下覆盖真实构建页面的发码断网重试、CSV、筛选、停用取消/Esc、响应式布局及权限失效清空，未接触真实账户或发放正式权益。

## 2026-09-14 线上验收与回滚

- Supabase 项目 wpupyuurwmaeozyvkyuo 仅新增迁移 0059、0060；redeem-code v1、code-admin v1 均 ACTIVE 且 verify_jwt=true。加密密钥已上传，私有备份在权限受控且 gitignored 的 apps/cloud/.env.code-admin；后续部署不得重新生成覆盖。
- Auth 仅 PATCH uri_allow_list，保留桌面 bowerbird://auth/callback** 并追加 https://bowerbird.cn/admin/。使用临时账号生成链接确认实际 redirect_to 为该后台地址，没有发送邮件；线上默认 Site URL 保持原值。第一次 PATCH 回读出现其他响应字段差异但未保留字段名，随后两次 GET 稳定一致；未提交 SMTP 或其他 Auth 字段。
- VPS 官网使用 /opt/bowerbird/website -> /opt/bowerbird/website-releases/20260914-code-admin，服务 bowerbird-website.service。部署前 server.mjs 与 Git 基线一致，只新增后台 3 个文件和已审查路由改动；原有 dist 资源逐文件比较一致。旧版本保留于 /opt/bowerbird/website-releases/20260828150000；回滚切回该符号链接并重启官网服务即可，已发会员和账本应保留。
- 24 项真实线上检查覆盖未登录/普通用户拒绝、生产 CORS、登录回调、加密发码/幂等/查询/导出/查看、1 自然月 Pro + 1100、30 天积分到期、签名权益刷新、同码重放无重复、异账号拒绝、停用与导出过滤、两个账号并发仅一次成功、真实浏览器登录/退出及撤权后旧 JWT 拒绝。测试未调用生成模型、未操作真实用户权益。
- 两轮完整链路共生成 6 个测试码，均已兑换或停用；临时 Auth 账号全部删除，4 条兑换回执与积分账本保留审计。后台可见“部署验收（测试码已清理）”批次，不能作为正式码发放。最终证据 .tmp/pro-code-production-smoke.json（24 项通过），截图 .tmp/pro-code-admin-production.png。
- 从 canonical 源码执行 pnpm tauri build --bundles nsis，TypeScript/Vite、Rust release、NSIS 均通过。新 Windows 26.9.14 包 53,630,686 bytes，SHA-256 `5be358fe4837c659090d7f47834716e3c3ac588bec0ebde9d0bbee1233914fb7`；本地 Windows/dist/Bowerbird_26.9.14_x64-setup.exe 已更新，同日旧包在 Windows/dist/archive/20260914-before-pro-codes。未运行安装程序或操作用户素材库。
- 官网下载按钮通过 BOWERBIRD_WINDOWS_DOWNLOAD_URL 指向 https://bowerbird.cn/downloads/Bowerbird_26.9.14-pro-codes_x64-setup.exe，同路径追加 .sha256 可取校验文件。仅更新这一环境变量，原环境备份为新发布目录的 .env.production.before-pro-code-download；回退官网下载只需恢复该备份并重启网站，或随官网整版回退。下载包在独立 downloads 目录，旧官网资源未覆盖。公网校验记录 .tmp/pro-code-published.json。

## 生成与启用兑换码

发码脚本只在本地生成文件，不调用数据库，不把明文码输出到终端。使用未纳入 Git 的私有目录（示例 `.tmp`），并限制文件访问。不要将兑换码 JSON 或完整文件内容贴进日志/聊天或提交仓库。

```powershell
node apps/cloud/scripts/create-pro-codes.mjs 10 2026-12-31T15:59:59Z .tmp/pro-code-issuance
```

时间参数是**兑换截止时间**，不是会员到期时间。生成的两个文件使用随机批次名称，避免覆盖：

- `pro-codes-<batch>.json`：私有明文码、ID、哈希及发放内容，供发放者安全保存。
- `pro-codes-<batch>.sql`：仅含 ID、哈希及兑换截止时间。由管理员在目标数据库执行后才能兑换，重复执行不重置码状态。

展示格式为四组八位十六进制字符；用户粘贴时允许大小写、空格和短横线。停用未使用码时，管理员按 ID 设置 `pro_redemption_codes.disabled_at=now()`。停用不撤回已发权益；撤销已发生的兑换需另行审计处理。

## 本地验证

```powershell
node apps/cloud/scripts/pro-redemption-db.test.mjs <本机已安装的 @electric-sql/pglite/dist/index.js>
deno test apps/cloud/supabase/functions/_shared/redemption_test.ts
deno check apps/cloud/supabase/functions/redeem-code/index.ts
pnpm --filter @bowerbird/desktop test:redemption
pnpm --filter @bowerbird/desktop build
```

数据库测试加载真实计费迁移，在独立内存库覆盖发放、原始回执重放、跨用户拒绝、续期/月末闰年、有效期/停用、Studio 保护、积分错误整笔回滚、持久限流及客户端越权拒绝。PGlite 在单连接上序列化排队请求；不能以此宣称已完成真实多连接并发压力验收。

UI 测试用真实设置组件、store 和 IPC API，替身仅在 Tauri 边界，覆盖空输入、失败保留、提交锁、成功等级/余额/默认引擎刷新、回执重放、刷新待办与未登录门控。截图在 `apps/desktop/.tmp/redemption-settings.png`，不触及真实素材库或用户账号。
