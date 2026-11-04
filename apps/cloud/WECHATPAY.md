# 微信支付直连

2026-11-04：普通商户、Native 扫码、API v3、微信支付公钥验签及桌面购买入口已实现并完成隔离验证。**尚未部署、未发起真实交易**；商户配置、真实 echo、公网通知和小额收退款待验。此处是协议与验证记录，产品状态以 [PROJECT.md](../../PROJECT.md) 为准。

## 填写商户资料

本机填写 `apps/cloud/.env.wechatpay.local`；可分发模板为 [.env.wechatpay.example](.env.wechatpay.example)。不要把密钥正文发到聊天。

| 内容 | 获取位置或处理方式 |
|---|---|
| 商户号 `WECHAT_PAY_MCH_ID` | 商户平台 → 账户中心 → 商户信息 |
| 支付 AppID `WECHAT_PAY_APP_ID` | 与收款商户号已绑定的支付应用；网站微信登录 AppID 不自动具备支付资格 |
| `apiclient_cert.pem`、`apiclient_key.pem` | 商户平台 → API 安全 → 商户 API 证书；文件默认放在仓库根 `.secrets/wechatpay/` |
| 商户证书序列号 | 可以留空，由核验脚本从证书读取；不是微信支付公钥 ID |
| APIv3 密钥 | 商户平台 → API 安全；填写已设置的 32 位字母数字密钥，不是 AppSecret |
| `pub_key.pem`、公钥 ID | 商户平台 → API 安全 → 微信支付公钥 → 管理公钥；下载文件并填写同页 `PUB_KEY_ID_…` |
| 三项平台状态 | Native 已开通、AppID 已绑定、已使用纯公钥模式；确认后将对应字段改为 `true` |
| 支付及退款通知 URL | 已预填 `https://bowerbird.cn/api/pay/wechat/notify` 和 `/api/pay/wechat/refund-notify`，部署后才生效 |

路径可以使用绝对路径，或相对于配置文件的路径。私有配置和 `.secrets/` 均已加入 Git 忽略；不打包进桌面和官网。不需要提供微信账号密码、AppSecret、APIv2 密钥或银行卡信息。

公钥灰度按商户号进行，旧商户灰度期间可能仍收到平台证书签名通知。本实现只验证指定微信支付公钥；必须确认已经完成公钥切换后再开放收款。请求统一携带 `Wechatpay-Serial`；echo 通过不能证明通知已完成切换。若该商户号还用于其他项目，切换前需确认那些项目也支持公钥。[官方公钥说明](https://pay.wechatpay.cn/doc/v3/merchant/4013038816)

## 核验与真实联调

先运行本地核验，无网络请求：

```sh
node apps/cloud/scripts/wechatpay-config.mjs
```

核验包含证书有效期、证书 CN 与商户号、RSA 2048 位、证书与私钥匹配、公钥 ID、密钥长度和回调路径。只输出字段名和固定诊断；`credentials_ok` 表示本地凭据检查通过，`ok` 还要求人工确认的平台状态。两者均不能替代微信接口结果。

隔离 echo 程序在本机 `.tmp/wechatpay-integration/echo.mjs`，不进入部署包。使用 Deno 运行以保持与 Cloud 相同的 Web Request 行为；禁用工作区自动发现，避免修改 pnpm 配置：

```powershell
$env:DENO_NO_PACKAGE_JSON='1'
deno run --no-config --allow-env --allow-read --allow-net=api.mch.weixin.qq.com .tmp/wechatpay-integration/echo.mjs --run
```

没有 `--run` 只检查配置。实际请求仅为微信官方 `/v3/security/echo`，复用项目 `WechatPayClient`、`wechatAuthorization` 和 `verifyWechatSignature`；比较回显并在本机篡改应答副本验证拒绝。只发非敏感随机测试串，不收款、不建订单，不传业务通知 URL。[官方 echo 接口](https://pay.wechatpay.cn/doc/v3/merchant/4014551946)

当前 Native 不使用敏感字段 RSA 加解密，因此 echo 不声称覆盖此项。未提供隔离公网接收端，真实回调接收、AES 解密及应答均仍未实测；相关能力只有合成报文验证。后续真实支付验收需以独立账号完成扫码、到账一次、查单恢复及退款；不得把 Mock、手工 RPC 或 echo 计作真实收款成功。

## 实现与复用

- 桌面：`AccountBilling` 复用 `ModalShell`、现有 `qrcode` 和 Rust 账号网关。`useCheckout` 保存同一购买意图的幂等键、恢复待付订单；恢复失败只允许重新查询。二维码到期隐藏，但不会凭客户端时钟判定未付款。付款后的权益刷新固定原账号，切号期间不会写入另一账号缓存。
- 官网：`account-proxy.mjs` 只放行指定鉴权购买／查单路由；`payment-proxy.mjs` 原样转发两个固定通知路径、签名头及原始字节，不传用户凭据，不解析重序列化、不重试、不跟随跳转。
- Cloud：`_shared/wechatpay.ts` 是依据官方 APIv3 和 Java 工具示例维护的 Web Crypto 实现，非官方 SDK；所有成功应答先验签，通知先验签再 AES-GCM 解密。`_shared/wechatpay-service.ts` 处理商户／订单／金额绑定与恢复，`_shared/wechatpay-bill.ts` 处理官方账单。
- 数据库：`0080_wechatpay.sql` 增加服务端专用记录和 RPC，沿用 `apply_bcoin_order`、`refund_bcoin_order` 与 0078 赠币计划。RLS／ACL 限定服务端调用。通知先持久记录，再原子落账；业务失败保留事件供补偿。

原 Pro 价格、注册及每订阅月赠币、年付分期、30 天赠币有效期、兑换码兼容及历史快照均保持。充值仍为 ¥1 = 20 Bcoin、永久有效；增加缺少的 ¥10／¥500 服务端商品，保留全部既定选项。自定义为整数元、最小 1；21474836 元是整数金额字段的技术上界，不是推荐充值档位，原有 1234 等自定义金额仍可用。

| 接口 | 权限与用途 |
|---|---|
| `GET create-checkout` | 用户 JWT；查询是否开放购买 |
| `POST create-checkout` | 用户 JWT；服务端商品报价、原意图幂等键、可选整数自定义金额 |
| `POST checkout-status` | 用户 JWT；仅查本人订单；省略订单号恢复最近待付订单 |
| `POST payment-webhook` | 不要求用户 JWT；强制微信原文签名及通知解密；旧 Mock 只在 Mock 开关下兼容 |
| `POST payment-admin` | 用户 JWT + 既有管理员权限 + SQL 再校验；显式发起全额退款 |
| `POST payment-reconcile` | 独立高熵维护令牌；查单、重试已申请退款和失败事件；带 `bill_date` 核对日账 |

创建订单保存完整 Native 请求；重试使用同一订单号和冻结请求，包含原金额、描述、通知地址和到期时间。一次付款只能入账一次。无签名成功、未知结果、到期或 `ORDER_NOT_EXIST` 均不直接视为收款／关单成功；后续查询或明确签名关单应答决定终态。

退款仅在尚未使用的该订单余额／赠币及权益版本允许时自动受理；申请后冻结本单待回收内容，其他余额仍可用。微信确认退款成功后才执行原有回收；明确退款关闭则解冻，未知、处理中、异常均保留恢复记录。不是新增用户生成任务的“预留/退差额”体验。已消费、已预留或后续权益变更需要人工处理，不通过改账强行退款。

日账使用已验签下载信息、固定官方下载域名及 SHA1 校验；下载文件自身按官方规则无签名。金额按十进制定点转换，检查订单总额、微信交易／退款号、到账状态与漏单；不使用 CSV 自动增减余额。退款账单反映申请受理，不代替实际退款终态。[账单字段](https://pay.wechatpay.cn/doc/v3/merchant/4013071246)、[下载规则](https://pay.wechatpay.cn/doc/v3/merchant/4013071238)

## 验证记录

截至 2026-11-04，本地隔离结果：

| 范围 | 证据 |
|---|---|
| 签名、通知、状态恢复、订单绑定及账单 | 33 项 Deno 测试通过；五个 Edge 入口类型检查通过 |
| 财务与兼容 | `scripts/wechatpay-db.test.mjs` 13 组通过；原赠币 16 组及 Bcoin 回归通过；没有改写原财务函数 |
| 官网通知与账号代理 | 17 项 Node 测试通过，使用本机 HTTP 和模拟上游 |
| 配置／维护任务 | 配置 2 项、维护 4 项 Node 测试通过；临时证书和模拟响应，无真实凭据 |
| echo 程序 | 1 项 Deno 离线模拟通过；真实 echo 受商户资料缺失阻塞 |
| 桌面 | checkout 专项、TypeScript、隔离 Vite 构建通过；Rust Cloud 53 项通过。扫码、恢复、防双击、切号、深浅色和窄屏截图已验证 |

Rust 本机测试使用已有 Windows manifest 修补流程处理隔离测试 EXE。旧 `account-billing-ui` 大型 onboarding 夹具后段因无关 Canvas `null.revision` 崩溃；新专项使用最小夹具验证真实账号面板通过，没有把旧套件标为全通过。

独立复审修复了查询事件 ID 冲突、查询错单、业务失败误计成功、退款配置不匹配先冻结、公钥请求头遗漏，以及账单缺官方时间误报一致。仍未验证真实 PostgreSQL 多连接并发（PGlite 单连接不能替代）、真实微信收退款、线上回调时延、生产定时器、Linux systemd 和 Mac 原生购买。

可复跑命令：

```sh
node --test apps/cloud/scripts/wechatpay-config.test.mjs apps/cloud/scripts/wechatpay-maintenance.test.mjs
node apps/cloud/scripts/wechatpay-db.test.mjs .tmp/adaptive-harness-20260905/node_modules/@electric-sql/pglite/dist/index.js
node --test website/scripts/account-proxy.test.mjs website/scripts/payment-proxy.test.mjs
deno test --allow-env apps/cloud/supabase/functions/_shared/wechatpay_test.ts apps/cloud/supabase/functions/_shared/wechatpay-service_test.ts apps/cloud/supabase/functions/_shared/wechatpay-bill_test.ts
```

## 部署与回退边界

1. 核验商户私有资料、AppID 绑定和纯公钥模式；先跑真实 echo。备份现役函数、官网、财务 schema／ACL／快照，在目标 PostgreSQL 回滚事务内演练 0080 与并发入账／退款。
2. **定向部署 0080**，不要因为编号较新顺带应用尚未上线的 0079／其他专项迁移。发布五个支付 Edge 入口及共享依赖；`create-checkout`、`checkout-status`、`payment-admin` 保持 JWT 校验，通知和维护入口使用各自认证。
3. 商户私钥、APIv3 密钥、公钥和商户参数仅写 Cloud secrets；维护令牌部署时随机生成。官网只部署固定代理；VPS 维护环境只保存 Cloud URL 和维护令牌，不放商户私钥或 service role。通知网关、请求头转发、HTTPS 和原文字节需实测。
4. 安装 [维护定时器](ops/WECHATPAY-MAINTENANCE.md)，每分钟补偿、北京每日 10:30 对账；验证真实定时执行和告警。当前没有历史日账队列，停机多日需逐日补账；长期未知订单不自动放弃，需监控处理。
5. 默认 `BOWERBIRD_PAYMENT_MOCK=true`、`BOWERBIRD_WECHAT_PAY_ENABLED=false`。只有两者分别为 `false`／`true` 且配置有效时桌面才允许新购。开放前先完成真实小额扫码、通知、到账、补偿、退款及日账验收，再发布配套桌面包。
6. 回退先把 `BOWERBIRD_WECHAT_PAY_ENABLED=false`，停止新订单；保留通知、查单、退款、定时器和新表，继续处理已创建／已收款订单。不能删除已发生的支付／退款／账本记录，也不能退回只认 Mock 的回调代码丢失真实通知。

定时器样例尚未部署，操作不是执行记录。仅一次真实 echo 通过不能打开销售开关；尚未填齐资料的当前版本不具备真实支付验收证据。
