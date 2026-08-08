4. 架构调整清单（为收费服务）
      #
      调整
      说明
      工作量
      1
      账号系统
      Supabase Auth（免费 50K MAU，自带 PG + RLS）；国内叠加微信扫码。用户系统从「无」升级为「邮箱/微信登录 + 订阅态 + 积分余额」
      中
      2
      托管 provider「Bowerbird Cloud」
      复用官网已验证的服务端代理模式：图 → 火山方舟 Seedream/即梦 API（¥0.2/张）；视频 → Seedance API；反推 → 豆包 vision API（¥0.01–0.05/次）。桌面端 GenProvider trait 已可插拔，加第三个 provider
      中
      3
      BYO 通道保留
      codex CLI / dreamina CLI 不动，Pro 以上生成不扣积分；现有 onboarding（一键安装/OAuth）原样复用
      零（已有）
      4
      积分服务
      最小实现 2 张表（user_credits 余额表 + credit_transactions 流水表）+ 幂等键 + 预授权扣费（预估→预扣→成功确认/失败回滚）。生成失败/审核不过不扣分
      中
      5
      订阅与支付
      国内 superun 支付（个人无执照可用，微信+支付宝全托管）；海外 Paddle（MoR 代缴全球税）。Webhook 自动开通订阅态
      低
      6
      功能门控改造
      本地 license 思路废弃，改为账号订阅态（app 启动/定期联网同步订阅与余额，离线宽限 7 天）；免费/Pro/Studio 门控点：创作板、生成入口、高清导出、并行数、BYO 开关
      低
      7
      官网试用接账号
      现有每 IP 限流改为登录送 30 分体验分，自然导入积分体系
      低
与现行架构的兼容性：Local-First 素材库哲学完全保留（素材、提示词、库数据 100% 本地）；云只承载「账号 + 积分 + 托管算力」三件事。BYO 用户理论上可以断网用（除首次订阅校验外）。