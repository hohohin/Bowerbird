# 支付宝个人 Pro 订阅：申请与配置

2026-11-10：用户选择先接个人 Pro，团队方案另行确定。本轮仅准备申请指引与本地配置，未接入支付代码、开通产品、创建商品或部署通知接口。以下 `ALIPAY_*` 是 Bowerbird 拟用的配置名称，不是支付宝控制台字段或已实现的运行时契约。

## 先填哪个文件

直接填写本机 `apps/cloud/.env.alipay.local`，不要把真实值填到 `.env.alipay.example`。本机文件和 `.secrets/` 已由 Git 忽略。配置可以分批填写，尚未取得的项目留空；不需要把密钥发到聊天。

推荐密钥文件放在 `D:/H/Project/Bowerbird/.secrets/alipay/sandbox/`，正式环境另用 `production/`；配置填绝对路径。目录供本机准备使用，后续部署时凭据注入服务器私有配置，不进入桌面包、官网资源或仓库。

## 尚无正式密钥：先准备沙箱

1. 登录[开放平台沙箱应用](https://open.alipay.com/develop/sandbox/app)，选择网页/移动应用，取得沙箱 APPID 和商户 PID，分别填 `ALIPAY_APP_ID`、`ALIPAY_MERCHANT_PID`。
2. 在沙箱应用“开发信息 → 接口加签方式”选择公钥模式。使用该页面提供的官方密钥工具在本地生成 RSA2 密钥对；推荐 RSA 2048、PKCS#8 PEM。若已有密钥，核对配对即可，不覆盖现有配置。
3. 上传**应用公钥**到该应用。**应用私钥**只保存在本机文件，填 `ALIPAY_APP_PRIVATE_KEY_PATH`；从该应用配置取得**支付宝公钥**另存文件，填 `ALIPAY_PUBLIC_KEY_PATH`。应用公钥与支付宝公钥是两把不同的公钥。
4. 保持模板中的 sandbox 环境和沙箱网关。按周期订阅沙箱工作台当前入口完成接口调用授权；工作台入口及授权见技能随包 `sandbox-integration.md`、`sandbox-cli.md`。完成后标记 `ALIPAY_SANDBOX_CALL_AUTHORIZED=true`，不以此代替正式授权。
5. 先留空商品与价格 ID；有既有沙箱资源才填，后续接入时创建月费 3900 分、周期 MONTH/1 的资源并保存 ID。

以上只是准备凭据，不代表沙箱交易闭环已通过。后续还需首次购买、通知验签与权益到账、续费一次、期末取消验证。

## 正式应用及密钥如何取得

1. 用收款主体的支付宝企业账号进入[支付宝开放平台](https://open.alipay.com/)。按当前 AI 订阅解决方案申请要求核对账号与经营类目；准备营业执照、应用/网站服务说明、订阅价格与扣款周期、退款规则及取消路径，具体材料以申请页面为准。当前随包资料列出的准入类目包含软件开发服务、互联网数据服务、在线工具等；不自行改填不符实际经营的类目。
2. 创建或选用自有**网页应用**，用于 Bowerbird 的电脑浏览器支付/签约流程，记录 APPID。桌面应用不因此自动等同于支付宝“移动应用”。
3. 申请 AI 周期订阅所需的商家扣款能力及[电脑网站支付](https://b.alipay.com/page/product-workspace/product-detail/I1080300001000041203/newProductList?)，在[签约管理](https://b.alipay.com/page/products-sign/dynlink/productSign/signManage.htm)核对审核结果。产品、应用和接口权限是不同准备项。
4. 按[新商户代调用授权指南](https://opendocs.alipay.com/pre-open/0jt7es)的当前有效入口操作，以收款商户对应账号登录，选择实际调用应用及所需产品权限。默认自有应用接入，不要求提供服务商的 `app_auth_token`。确认成功后记录 `ALIPAY_PRODUCTION_CALL_AUTHORIZED=true`。
5. 在该正式应用“开发设置 → 接口加签方式”使用官方工具生成并上传应用公钥，保管应用私钥，取得支付宝公钥。操作同沙箱，但必须使用独立的正式应用及匹配密钥。已有证书模式的应用保留原模式，填写三个证书路径，后续实现按实际模式核验。
6. 按控制台要求完成应用审核/上线；在配置中记录已核实的平台状态。切正式时将环境、网关改为 `production`、`https://openapi.alipay.com/gateway.do`，并成套替换 APPID、PID、密钥和商品/价格 ID。不得只改网关。

官方参考：[AI 订阅方案](https://aipay.alipay.com/docs/subscribe/introduce.html)、[接入准备](https://opendocs.alipay.com/solution/repo-046zj4?ref=api)、[接口加签说明](https://opendocs.alipay.com/common/02kipl)。本次部分官方文档正文无法经网页工具抓取，操作说明依据已安装技能随包资料整理，最终权限、页面路径及规则以登录后控制台和正式接入资料为准。

## 需要填写的内容

| 参数 | 从哪里取得 / 何时填写 |
|---|---|
| `ALIPAY_APP_ID` | 目标环境的应用详情 APPID |
| `ALIPAY_MERCHANT_PID` | 同环境收款商户编号；沙箱用沙箱商户 PID |
| `ALIPAY_APP_PRIVATE_KEY_PATH` | 本地生成的应用私钥文件路径 |
| `ALIPAY_PUBLIC_KEY_PATH` | 同应用配置中的支付宝公钥文件路径；公钥模式必填 |
| `ALIPAY_KEY_MODE` | 默认 `public_key`；已有证书模式填 `certificate` |
| `ALIPAY_APP_CERT_PATH` | 证书模式：该应用的应用公钥证书文件路径 |
| `ALIPAY_PUBLIC_CERT_PATH` | 证书模式：支付宝公钥证书文件路径 |
| `ALIPAY_ROOT_CERT_PATH` | 证书模式：支付宝根证书文件路径 |
| `ALIPAY_PRO_MONTHLY_PRODUCT_ID` / `ALIPAY_PRO_MONTHLY_PRICE_ID` | 已有对应环境资源才填；没有则留空，由后续接入创建 |
| `*_APPROVED` / `*_ONLINE` / `*_AUTHORIZED` | 只在相应平台操作确认成功后改为 `true` |

其余预填项暂时保持。通知 URL 是**规划值**，还没有服务端接收接口，先不要在控制台启用该地址。后续部署并验证后，再把对应 URL 配为“应用网关”，在消息服务订阅 `alipay.trade.subscription.changed`；它不是用户授权回调地址。只有验签、幂等与可靠落库成功后才返回 HTTP 200 和文本 `success`。

## 本期范围与复用决定

- 个人 Pro 先准备 ¥39/月，支付宝托管 `SUBSCRIBE_DEDUCT`。按现有规则每订阅月赠 800 Bcoin、到账后 30 天有效；接入时复用既有商品快照、账号权益和赠币事务，不另建账本。
- 技能随包资料注明默认最长扣款周期为 3 个月／93 天，因此本期不创建 ¥359/年的自动续费价格；年付需核对商户实际能力后再定，不把年付改成月付或改变现有其他渠道价格。
- 团队订阅、额外试用、优惠与宽限期不纳入本期。
- 接入候选：`supabase/functions/create-checkout`、`_shared/wechatpay-service.ts`（参考渠道结构）、现有 `apply_bcoin_order`／0078 赠币计划、`website/payment-proxy.mjs` 及桌面 `AccountBilling`／`useCheckout`。支付宝签名、订阅生命周期和周期续费事件需单独适配，不复用微信验签或把自动续费当作同一已付款订单重放。
- 本配置暂不被代码读取，`ALIPAY_SUBSCRIPTION_ENABLED=false` 保持。收款代码、隔离测试及部署包准备完成后，按 PROJECT.md 的云端交付规范单独请求具体部署确认。
