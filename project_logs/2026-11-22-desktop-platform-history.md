# 桌面平台 README 历史记录

本页冻结整理前的 Windows 和 macOS 版本交接原文，链接及脚本路径按各平台 README 原位置解释。当前版本、通道、签名和发布回执从 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md) 查阅。

## Windows 旧版发布和交接

~~~~markdown
## Windows 26.11.1801 已发布（2026-11-18）

源码 57afb840，官网和自动更新已切换。H3 优化历史与重试、模型／推理选择、Agent 建卡参数、组图与表格连线、Markdown 拖入画板及维度入口随包发布。配套 Worker／chat-proxy 已核验。原生 1319 项、六组冻结界面及完整类型／生产构建通过；历史单项失败边界见 [验证与回滚](../dev-doc/DESKTOP-UPDATES.md#windows-26111801-已公开发布2026-11-18)。安装默认中文，可选 English。

[下载 Windows 安装包](https://cdn.bowerbird.cn/windows_package/Bowerbird_26.11.1801_x64-setup.exe)。

## Windows 26.11.1706 已发布（2026-11-17）

源码 ff14fda8。应用内更新说明：优化文件管理问题，提升使用体验；提高应用稳定性。本轮原件／分身回收即时反馈、缓存与失败恢复、关联分身补查及扫描校验优化随包发布；1316 项原生和九组冻结界面通过，旧批量菜单脚本未计通过。中文默认、English 可选，签名与 CDN 回读通过。[验证与回滚](../dev-doc/DESKTOP-UPDATES.md#windows-26111706-已公开发布2026-11-17)。

[下载 Windows 安装包](https://cdn.bowerbird.cn/windows_package/Bowerbird_26.11.1706_x64-setup.exe)。

## Windows 26.11.1705 已发布（2026-11-17）

源码 dc1b420e，已包含本轮最后补入的素材移动与目录导出修改。隐藏入门引导、画板删除分流与撤销、项目／文件夹移动及目录／ZIP 导出、视频／H3 布局、Cloud DSH 入口及支付提示同步更新。1309 项原生、十五组冻结界面、原签名与 CDN 回读通过。安装默认中文、English 可选。[验证与回滚](../dev-doc/DESKTOP-UPDATES.md#windows-26111705-已公开发布2026-11-17)。

[下载 Windows 安装包](https://cdn.bowerbird.cn/windows_package/Bowerbird_26.11.1705_x64-setup.exe)。

## Windows 26.11.1704 已发布（2026-11-17）

源码 88aca8a9。画板交互和批量建卡优化、模型收藏及 Seedream 子菜单、H3 首尾帧操作和图片提示词优化、本机 DSH 逐轮投递；配套云端视频规则已同步。原生 1301 项、九组冻结界面与图片菜单专项通过，中文默认／English、签名和 CDN 回读核验通过。完整边界与回滚见 [桌面更新](../dev-doc/DESKTOP-UPDATES.md#windows-26111704-已公开发布2026-11-17)。

[下载 Windows 安装包](https://cdn.bowerbird.cn/windows_package/Bowerbird_26.11.1704_x64-setup.exe)。

## Windows 26.11.1703 已发布（2026-11-17）

源码 a8c110fb。设置与订阅入口整理、DeepSeek 退出登录、后台更新检查、入库自动分析仅本地、通知与探索交互修正。1301 项原生与八组冻结界面通过，中文默认／English 可选、原签名及 CDN 完整下载验证通过。发布与回滚见 [桌面更新](../dev-doc/DESKTOP-UPDATES.md#windows-26111703-已公开发布2026-11-17)。

[下载 Windows 安装包](https://cdn.bowerbird.cn/windows_package/Bowerbird_26.11.1703_x64-setup.exe)。

## Windows 26.11.1702 已发布（2026-11-17）

源码 f6124a8a 已冻结推送，官网与自动更新已切换。包含运行中触发线编辑和不同目标并发、采集图片直接入当前项目画板及通知／探索交互修复。扩展 0.5.2，浏览器更新后需重新加载。1301 项原生通过、49 项跳过，四组冻结桌面专项、扩展 21 项逻辑与采集界面、2230 个输入和 80 个资源通过核验。安装器首次默认简体中文，可选 English。[完整证据与回滚](../dev-doc/DESKTOP-UPDATES.md#windows-26111702-已公开发布2026-11-17)。

[下载 Windows 安装包](https://cdn.bowerbird.cn/windows_package/Bowerbird_26.11.1702_x64-setup.exe)。

## Windows 26.11.1701 已发布（2026-11-17）

补齐最新画板缩放、拖动、悬停、连线跟随与避让、视口外绘制裁剪。冻结源码 44f6e491 已推送，官网与自动更新已切换。安装器首次默认简体中文，可选 English。类型、三组冻结界面、2229 个输入、80 个资源和 CDN 包签名验证通过。[验证范围与回滚](../dev-doc/DESKTOP-UPDATES.md#windows-26111701-已公开发布2026-11-17)。

[下载 Windows 安装包](https://cdn.bowerbird.cn/windows_package/Bowerbird_26.11.1701_x64-setup.exe)。

## Windows 26.11.1601 已发布（2026-11-17）

源码 32239f02 已推送并冻结。官网与自动更新已切换，安装器首次默认简体中文，可选 English。1299 项原生通过、49 项跳过，九组冻结界面、63 项逻辑、38 项官网、2227 个冻结输入及 80 个包资源核验通过。详见[发布范围、证据和回滚](../dev-doc/DESKTOP-UPDATES.md#windows-26111601-已公开发布2026-11-17)。

[下载 Windows 安装包](https://cdn.bowerbird.cn/windows_package/Bowerbird_26.11.1601_x64-setup.exe)。

## Windows 26.11.1001 已发布（2026-11-10）

最终源码 **b5302da2** 已存档推送并冻结签名，官网与自动更新已切换。包含角色声音、强化复刻、播放器／音轨、办公文档、统一 Agent、素材库与创作框，以及标注覆盖原图；修复索引影响原件恢复身份的问题。冻结 Rust 1207 passed／41 ignored、23 组界面、2104 输入及 76 资源、中文／English、原公钥验签与完整 CDN 下载通过。SQLite 0056；后续并行增量未纳入。

[下载 Windows 安装包](https://cdn.bowerbird.cn/windows_package/Bowerbird_26.11.1001_x64-setup.exe)。安装包哈希、云端配套核验、真实使用边界和保留现役网关的回滚步骤见 [桌面更新](../dev-doc/DESKTOP-UPDATES.md#windows-26111001-已发布2026-11-10)。

## Windows 26.11.602 已发布（2026-11-06）

Cloud 全通路网关与 Agent 原请求恢复已随签名包发布，源码 4b3c4b92；自动更新入口已切换。原签名、更新保留登录、冻结源码及完整 CDN 下载已验证；故障电脑实机升级／真实优化仍待验。证据、安装包哈希与保留新网关的回滚步骤见 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md#windows-2611602-已发布2026-11-06)。

## Windows 26.11.601 已发布（2026-11-06）

2026-11-06 14:05:58（北京时间）本机公网复核通过。源码 **4ae78ee6** 已与文档同次存档推送后冻结构建，发布素材库四级视图与投影控件、项目范围记忆、文本完整编辑／最近文档／本地自动保存、Codex 模型与推理选择、本机及应用托管 DSH 接入、快传原件发送、探索视频采集入口、同会话生成组图、连线与文本聚焦修复及 H3 独立提示词优化。SQLite **0053**，插件 **0.3.1**；Cloud 音频参考 0079／Edge／Worker／网关未部署，桌面在创建音频任务前检测服务端能力并拒绝不支持的请求；DeepSeek Cloud 未启用。Mac 保持 ARM 801／Intel 1501，现有视频及赠币服务和 Mock 支付保持。

TypeScript／Vite、Rust 1145 passed／34 ignored、18 组桌面专项、154 项前端测试及 30 项官网回归通过；1996 个冻结输入与 Git 核对、76 个资源（含 LocalSend 许可证与修改说明）、x64／双语安装器／更新登录保留钩子、原公钥验签及篡改拒绝、包内原生媒体／等待和生产 bundle 检查通过。Rust 测试仅向独立测试 EXE 副本嵌入 Common Controls v6 清单，正式构建未修改。未替用户安装／重启应用、迁移真实素材库或调用付费模型；用户库原生升级、真手机端到端、真实站点采集和 Mac 原生仍需各自验收。

安装包 `Bowerbird_26.11.601_x64-setup.exe`：**107520776 bytes**，SHA-256 `7ceff64504c8ab5939e2b4ca7237fbfe9bd9fd8ce1bb13eb1e571dacf62be514`。TOS／CDN 完整回读、Range 206、CDN 包原公钥验签通过后才切更新。候选／现役／公网三平台清单、签名、双首页下载、旧包、后台及账号／Cloud 网关拒绝边界通过。

现役 `/opt/bowerbird/website-releases/20261106-windows-26.11.601`，回滚 `/opt/bowerbird/website-releases/20261105-windows-26.11.502`；只改 Windows 下载与清单相关 5 个文件，82 个其他文件保持，后台、账号／Cloud 代理、Nginx、Mac 清单及旧包保留。

证据：本机 `.tmp/release-windows-26.11.601/`，VPS `/tmp/bowerbird-release-windows-26.11.601/`；`rollback.sh` 恢复 502 官网，不自动降级客户端或回退账本。

## Windows 26.11.502 已发布（2026-11-05）

2026-11-05 20:17:32（北京时间）本机公网复核通过。源码 **3f545a13** 已与文档同次存档推送后冻结构建，发布本机 Codex 对话内 HyperFrames 视频制作、预览、渲染与成片播放，续聊复用成功工程，旧对话工具升级及停止／中断保护；素材库生成任务提示所属项目并支持点击跳转。SQLite **0052**，插件 **0.3.1**；Cloud 音频参考 0079／Edge／Worker／网关未部署，桌面在创建音频任务前检测服务端能力并拒绝不支持的请求；DeepSeek Cloud 未启用。Mac 保持 ARM 801／Intel 1501，现有视频及赠币服务和 Mock 支付保持。

TypeScript／Vite、Rust 1115 passed／33 ignored、6 组桌面专项、94 项前端测试及 30 项官网回归通过；1723 个冻结输入与 Git 核对、76 个资源（含 LocalSend 许可证与修改说明）、x64／双语安装器／更新登录保留钩子、原公钥验签及篡改拒绝、包内原生媒体／等待和生产 bundle 检查通过。Rust 测试仅向独立测试 EXE 副本嵌入 Common Controls v6 清单，正式构建未修改。未替用户安装／重启应用、迁移真实素材库或调用付费模型；用户库原生升级、真手机端到端、真实站点采集和 Mac 原生仍需各自验收。

安装包 `Bowerbird_26.11.502_x64-setup.exe`：**87380290 bytes**，SHA-256 `f2ad357db8704d48993aa9c47ec3eb7312ad5880947dd08c87aff83b367ca839`。TOS／CDN 完整回读、Range 206、CDN 包原公钥验签通过后才切更新。候选／现役／公网三平台清单、签名、双首页下载、旧包、后台及账号／Cloud 网关拒绝边界通过。

现役 `/opt/bowerbird/website-releases/20261105-windows-26.11.502`，回滚 `/opt/bowerbird/website-releases/20261105-windows-26.11.501`；只改 Windows 下载与清单相关 5 个文件，82 个其他文件保持，后台、账号／Cloud 代理、Nginx、Mac 清单及旧包保留。

证据：本机 `.tmp/release-windows-26.11.502/`，VPS `/tmp/bowerbird-release-windows-26.11.502/`；`rollback.sh` 恢复 501 官网，不自动降级客户端或回退账本。

## Windows 26.11.501 已发布（2026-11-05）

2026-11-05 12:25:34（北京时间）本机公网复核通过。源码 **7b9d8626** 已与文档同次存档推送后冻结构建，发布投影 HUD 创作框与图片预览续聊、段落 Agent／Markdown 快捷编辑与两行文档预览、共用截图标注、Pinterest／小红书采集修复、失效原件清理与标签拖放、统一加号连线和四种工作流触发模式、本机 H3 三模式及 Codex HyperFrames 视频 Skill／独立 Studio。SQLite **0052**，插件 **0.3.1**；Cloud 音频参考 0079／Edge／Worker／网关未部署，桌面在创建音频任务前检测服务端能力并拒绝不支持的请求；DeepSeek Cloud 未启用。Mac 保持 ARM 801／Intel 1501，现有视频及赠币服务和 Mock 支付保持。

TypeScript／Vite、Rust 1112 passed／32 ignored、20 组桌面专项、94 项前端测试及 30 项官网回归通过；1719 个冻结输入与 Git 核对、76 个资源（含 LocalSend 许可证与修改说明）、x64／双语安装器／更新登录保留钩子、原公钥验签及篡改拒绝、包内原生媒体／等待和生产 bundle 检查通过。Rust 测试仅向独立测试 EXE 副本嵌入 Common Controls v6 清单，正式构建未修改。未替用户安装／重启应用、迁移真实素材库或调用付费模型；用户库原生升级、真手机端到端、真实站点采集和 Mac 原生仍需各自验收。

安装包 `Bowerbird_26.11.501_x64-setup.exe`：**87366978 bytes**，SHA-256 `6b1dc56d83ad418c013d4a972214e43dc8e50fdabf2aee088a559960eb432d47`。TOS／CDN 完整回读、Range 206、CDN 包原公钥验签通过后才切更新。候选／现役／公网三平台清单、签名、双首页下载、旧包、后台及账号／Cloud 网关拒绝边界通过。

现役 `/opt/bowerbird/website-releases/20261105-windows-26.11.501`，回滚 `/opt/bowerbird/website-releases/20261103-windows-26.11.301`；只改 Windows 下载与清单相关 5 个文件，82 个其他文件保持，后台、账号／Cloud 代理、Nginx、Mac 清单及旧包保留。

证据：本机 `.tmp/release-windows-26.11.501/`，VPS `/tmp/bowerbird-release-windows-26.11.501/`；`rollback.sh` 恢复 301 官网，不自动降级客户端或回退账本。

## Windows 26.11.301 已发布（2026-11-03）

2026-11-03 10:43:55（北京时间）本机公网复核通过。源码 **510e0cdd** 已与文档同次存档推送后冻结构建，发布LocalSend 局域网快传、素材库直接创作、Plate 放大文本工作区与画板文档卡、创作框 HUD 标签／开放框体／收起贴底、独立图片会话预览、任务铃铛与悬浮滚动条、探索视频流采集及历史、集合改名／断联删除、积分明细、视频自动模式及自有 CLI 音频参考、新建项目卡片。SQLite **0050**，插件 **0.3.1**；Cloud 音频参考 0079／Edge／Worker／网关未部署，桌面在创建音频任务前检测服务端能力并拒绝不支持的请求；DeepSeek Cloud 未启用。Mac 保持 ARM 801／Intel 1501，现有视频及赠币服务和 Mock 支付保持。

TypeScript／Vite、Rust 1047 passed／29 ignored、23 组桌面专项、72 项前端测试及 29 项官网回归通过；1600 个冻结输入与 Git 核对、76 个资源（含 LocalSend 许可证与修改说明）、x64／双语安装器／更新登录保留钩子、原公钥验签及篡改拒绝、包内原生媒体／等待和生产 bundle 检查通过。Rust 测试仅向独立测试 EXE 副本嵌入 Common Controls v6 清单，正式构建未修改。未替用户安装／重启应用、迁移真实素材库或调用付费模型；用户库原生升级、真手机端到端、真实站点采集和 Mac 原生仍需各自验收。

安装包 `Bowerbird_26.11.301_x64-setup.exe`：**87237827 bytes**，SHA-256 `a7668088080d5e35e043d1f0a90aab927cfdc87fe82ac88f1477d4a3f8d132b4`。TOS／CDN 完整回读、Range 206、CDN 包原公钥验签通过后才切更新。候选／现役／公网三平台清单、签名、双首页下载、旧包、后台及账号／Cloud 网关拒绝边界通过。

现役 `/opt/bowerbird/website-releases/20261103-windows-26.11.301`，回滚 `/opt/bowerbird/website-releases/20261102-windows-26.11.202`；只改 Windows 下载与清单相关 5 个文件，82 个其他文件保持，后台、账号／Cloud 代理、Nginx、Mac 清单及旧包保留。

证据：本机 `.tmp/release-windows-26.11.301/`，VPS `/tmp/bowerbird-release-windows-26.11.301/`；`rollback.sh` 恢复 202 官网，不自动降级客户端或回退账本。

构建期间的后续 HUD 样式及关闭控件改动已另行提交为 `71604393` 并随源码推送，未进入此包。安装包的 1600 个冻结输入逐文件匹配 `510e0cdd`；不能把当前 dev 的后续提交视为本版产物。

## Windows 26.11.202 已发布（2026-11-02）

2026-11-02 19:18:08（北京时间）本机公网复核通过。源码 **50dfa646** 已与文档同次存档推送后冻结构建，完整发布工业主题与素材库／项目平级导航、连接式素材库与真实目录集合／分身／原件回收、文本 Plate 编辑与音频试听、统一视频播放／采集、截图历史与共用标注、跨应用拖出与 Pinterest 搜图、画布性能／建卡／文字编辑定位，保留 201 的注册／Pro 赠币展示及回执。SQLite **0050**，插件 **0.3.1**；DeepSeek Cloud 不部署不开启，Mac 保持 ARM 801／Intel 1501。现有 Cloud 视频及赠币服务开关不变，真实支付仍 Mock。

TypeScript／Vite、Rust 967 passed／28 ignored、12 组桌面 Chromium 和官网网关回归通过；1366 个冻结输入与 Git 核对、74 个资源、x64／双语安装器／更新保留登录钩子、原公钥验签及篡改拒绝、包内原生媒体／等待和生产 bundle 检查通过。未替用户安装／重启应用或迁移真实素材库；用户库原生升级、跨应用／跨 WebView 真机体验、Mac 和真实模型质量仍待各自实机验收。

安装包 `Bowerbird_26.11.202_x64-setup.exe`：**86336574 bytes**，SHA-256 `81ac0c3fd3d5b56e8b5157474b0c6ca52d529fec3c53481fed10a83d61f4c2f1`。TOS／CDN 完整回读、Range 206、CDN 包原公钥验签后才切换更新。候选／现役／公网三平台清单、签名、双首页下载、旧包、后台及账号／Cloud 网关拒绝边界通过。

现役 `/opt/bowerbird/website-releases/20261102-windows-26.11.202`，回滚 `/opt/bowerbird/website-releases/20261102-bcoin-gifts-windows-26.11.201`；只改 Windows 下载与清单相关 5 个文件，82 个其他文件保持，赠币后台、账号／Cloud 代理、Nginx、Mac 清单及旧包保留。本轮没有部署迁移、Edge 或 Worker，没有创建真实模型任务。

证据：本机 `.tmp/release-windows-26.11.202/`，VPS `/tmp/bowerbird-release-windows-26.11.202/`；`rollback.sh` 恢复 201 官网，不自动降级客户端或回退账本。

## Windows 26.11.201 已发布（2026-11-02）

09:36:15（北京时间）公网验收通过。以公开 2801 的 `be4a3f11` 为基线，仅叠加本次赠币 Plan／积分明细／兑换即时与未来安排、原生回执兼容及版本／测试，SQLite 保持 **0047**。Cloud 注册 200／Pro 每订阅月 800 已配套上线，旧用户不补发，真实支付仍 Mock；没有发布当前 dev 的其他后续功能。

1064 冻结输入、精确补丁重放、Rust 权益 12 项、3 组 UI、TypeScript／Vite／签名构建、70 包资源、原公钥验签与篡改拒绝通过。安装包 `Bowerbird_26.11.201_x64-setup.exe`：84,934,286 bytes，SHA-256 `6d4cd50dba44c6bf4143e3d24e3d16ab51c8cdf1a05e380776d9076f14f30fa0`。TOS／CDN 完整下载与 Range 核验后，官网及 Windows 更新清单已切换；Mac 保持。

本轮隔离产物在 `.tmp/bcoin-gifts-desktop-20261102/artifacts/`，没有覆盖正式工作区版本文件或替用户安装／重启。后续 Windows 发版需使用高于 26.11.201 的版本。完整现役／回滚、来源及未验收边界见 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md#windows-2611201-已发布2026-11-02)。

## Windows 26.10.2801 已发布（2026-10-28）

2026-10-28 15:29:20（北京时间）完成公网验收。源码 **be4a3f11** 已存档推送 dev 后冻结构建，包含素材库分栏／Tactical 样式与多选、浏览器插件 0.2.0 与采集、连续瀑布流、本机图文对话／历史及受控建卡、常用素材／手动固定、HEIC／HEIF 导入、按区域拖放／粘贴、账号展示与微信回跳，以及 Cloud 生成／签名文件官网网关的 10054 修复。SQLite **0047**；独立复刻 Demo／只读 MCP 仅源码存档，不打入桌面包。Mac ARM 801／Intel 1501 保持，未部署 Edge／Worker、启用 Cloud 视频／价格或真实支付。

完整 TypeScript／Vite、Rust **762 passed / 26 ignored**、五组桌面 Chromium、27 项官网网关／更新及微信回跳界面通过。1062 个冻结输入逐一核对 Git 提交，70 个包内资源、x64／版本／NSIS 中文与 English 选择器及登录保留钩子、原 updater 公钥验签和篡改拒绝通过；包内原生等待、生产 bundle 与原生媒体回归通过。 对话测试在模式恢复后等待浏览器光标同步，未修改产品行为；原生升级与真实服务验收仍按下述边界处理。

安装包 `Bowerbird_26.10.2801_x64-setup.exe`：**84936180 bytes**，SHA-256 `9bba56655b3191e23db9dcd4e61a323fa203aacdc0c7f11a0bc36962facb6364`。先完成 TOS／CDN 全量下载哈希、Range 206 与 CDN 包原公钥验签，再切 Windows 更新通道及双首页下载。

现役 `/opt/bowerbird/website-releases/20261028-windows-26.10.2801`；回滚 `/opt/bowerbird/website-releases/20261028-cloud-gateway`。候选复制最新生成网关目录，仅更新 Windows 发布文件和已确认静态页面；48 个其余文件保持，`cloud-proxy.mjs`、账号模块、原配置、后台昵称、Mac 清单、旧包与 Nginx `/api/cloud/` 路由保留。候选／现役／公网完成三平台更新入口、签名、36 个静态文件哈希、账号／生成鉴权拒绝及签名上传下载拒绝检查。未创建真实模型任务。

证据在本机 `.tmp/release-windows-26.10.2801/`，服务器 `/tmp/bowerbird-release-windows-26.10.2801/`；`rollback.sh` 恢复网关基线且保留旧包，不自动降级客户端。不能回滚到无生成网关的官网。未替用户安装／重启应用；故障电脑完整生成与账单、真实用户库升级、跨 WebView 拖放／剪贴板、HDR HEIC 和 Mac 原生仍待实机验收。

## 2026-10-24 Windows 26.10.2401 已发布

源码 fd948497 已存档推送，视频导入、创作框 H3 首尾帧／环境安装与驱动指引、项目管理／删除预检与剩余结果处理、右键取消连线、视频复刻多来源及普通文本／语音转写、分类内部英文规则、Bcoin 账号／试用与工作流门控、设置精简及中文错误提示、中文／English 安装语言选择已签名上线。TypeScript／Vite、Rust **700 passed / 24 ignored**、18 组桌面 Chromium、前端逻辑／Bcoin 与分类 PGlite、24 项 Deno、32 项 Worker、官网错误提示／网关／更新和构建通过。双语 NSIS 与更新登录保留、冻结输入、资源、签名及 CDN 完整下载通过。SQLite 0045；Cloud 0075／jev-proxy v10 先行部署，Mac 保持。安装包 `Windows/dist/Bowerbird_26.10.2401_x64-setup.exe`；完整证据与回滚见 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)。

## 2026-10-23 Windows 26.10.2301 已发布

源码 4156e8e0 已存档推送；视频复刻任务管理与四步工作流交付、Pro/Studio H3 权限及入口修复、魔搭优先／TOS 回退安装与自动比例、原生视频封面及元数据读取、项目管理、生成卡片布局／视频卡样式、画布筛选及积分展示已签名发布。TypeScript／Vite、Rust **669 passed / 22 ignored**、H3 合成上传／自动尺寸／恢复 1 项、13 组桌面 Chromium、8 项前端逻辑、11 项官网网关、8 项 Deno 权限协议、两个 Edge 入口类型及后台 PGlite／界面回归通过；冻结输入、资源、签名／篡改拒绝、包内媒体／等待及 CDN 全量下载通过。安装包 `Windows/dist/Bowerbird_26.10.2301_x64-setup.exe`；SQLite 0044，应用内更新保留登录，Mac 保持。证据和回滚见 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)。

## 2026-10-22 Windows 26.10.2202 已发布

源码 d6bad0c3 已存档推送，素材分页、分类来源与规则继承、统一模型菜单／视频底栏、登录提示与引导修正已签名上线，SQLite 至 0044。TypeScript/Vite、Rust 652 passed / 21 ignored、50 项逻辑、14 组界面及 13 项云协议通过；929 个构建输入、67 个资源、原公钥验签／篡改拒绝、包内等待及完整公网下载核对通过。云端 v6 兼容新旧门槛，GPT 与 Mac 保持。安装包 `Windows/dist/Bowerbird_26.10.2202_x64-setup.exe`；真实原生升级及原机微信故障待验，发布和回滚见 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)。

## 2026-10-22 Windows 26.10.2201 已发布

源码 f98283ec 已存档推送，全部图片视图、新素材自动分类与停止恢复修正、轻动效及 1001 后文件工作区／画板／Agent／视频增量已签名发布，SQLite 至 0042。TypeScript/Vite、Rust 643 passed / 20 ignored、50 项逻辑、13 组界面回归、生产条件 Agent、私有 CLI 与实际 NSIS 钩子通过；909 个构建输入、67 个资源、包内等待和完整公网下载／验签通过。应用内更新保留登录，Mac 两通道保持；真实旧版安装升级仍待实机验收。产物 `Windows/dist/Bowerbird_26.10.2201_x64-setup.exe`，发布与回滚见 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)。

## 2026-10-16 同步 Mac 最新源码

`dev` 合入 `mac@300124d`：本机文件浏览/外部图片引用（SQLite 0034）、分类管道、截图独立页面、素材缩放与布局、工作流行列输入/撤销/分享 v4、Agent 详情与及时会话交付；保留 Windows 视频截帧/完整诊断、私有 CLI 和 NSIS 更新规则。版本仍为 26.10.1001，本轮未打包发布。差异与 Windows 验证见 [同步记录](MAC-SYNC-2026-10-16.md)。运行中的开发 EXE 未关闭，新原生命令需开发程序重启后使用。

## 2026-10-15 源码存档与 Mac 同步清单

相对上次完整 Mac 基线 `d6027fb` 的按版本增量见 [Windows 端更新内容 — 26.10.1001](Windows端更新内容-26.10.1001.md)。当前公开版本仍为 1001；之后的二维表格、Agent 会话生图、视频播放器/截帧与即梦完整错误查询属于未发版源码。本次源码与交接文档一起存档，版本不变，Mac 合入后需独立验证。

## 2026-10-10 Windows 26.10.1001 已发布

修复多张画板结果作为普通引用时被要求选择父结果、无法发送的问题；全部引用及精确节点保持，明确继续/重试仍接回原结果。源码 3d46e3a，70 项逻辑、3 组画板合成 IPC、TypeScript/Vite/正式构建、666 个输入与 67 个资源、包内等待 6 项及签名/完整公网下载通过。沿用 904 的更新保留登录规则，Mac 保持 26.10.801；真实安装升级待验。产物 `Windows/dist/Bowerbird_26.10.1001_x64-setup.exe`，发布和回滚见 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)。

## 2026-10-09 Windows 26.10.904 已发布

应用内更新现在保留 Bowerbird 账号、权益缓存及 Codex/Dreamina 私有登录；普通手动安装/重装仍重置。实际 NSIS 隔离夹具、新包/资源/签名与完整公网下载验证通过，官网及自动更新已切换。旧客户端通过应用内更新到本版即可保留正常登录；真实账号升级仍待实机验收。产物在 `Windows/dist/Bowerbird_26.10.904_x64-setup.exe`，详见 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)。

## 2026-10-09 Windows 26.10.903 已发布

当前 Windows 改动已签名发布至官网与自动更新：生成卡片可选视频，即梦/方舟参数独立保存，结果沿现有连线交付；视频查询临时超时续查原任务，不重复提交生成。Rust 465 passed / 10 ignored、49 项前端逻辑及相关 UI、构建/资源/签名与完整公网下载核验通过。包在 `Windows/dist/Bowerbird_26.10.903_x64-setup.exe`；发布与回滚证据见 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)。Mac 保持 26.10.801，真实安装升级及付费生成未在本轮验收。

## 2026-10-09 Windows 26.10.902 正式版修正

用户已授权正式版隐藏技能/模板库入口、开放 Agent 图文输出与 Codex CLI。UI、端口、输入及运行时解除 DEV 限制；工作流后端保留 BYO 权益检查，旧聊天/编排保持开发限制。生产请求改存 `%APPDATA%/com.bowerbird.desktop/.agent-z/`，不再引用打包机源码路径。26.10.902 已构建、签名并替换官网和自动更新中的 26.10.901，保留旧包与回滚目录。安装包位于 `Windows/dist/Bowerbird_26.10.902_x64-setup.exe`，完整公网下载验签、67 个资源及原生等待 6 项检查通过；发布证据见 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)。

## 2026-10-09 重新核对 Mac 共享源码

补合 `origin/mac@d6027fb` 中先前遗漏的 Codex CLI Agent、循环起点/恢复、数据包交换、Codex 退出登录与入口开关，保留 Windows 封装/v3 布局。逐项源码与验证见 [Mac 增量审计](MAC-SYNC-AUDIT-2026-10-09.md)。本次补合阶段公共安装包为 26.10.901；随后用户明确授权，Mac 原有 DEV/debug 限制与正式请求目录问题已按上节范围修正，并随 Windows 26.10.902 发布。

## 2026-10-09 Windows 26.10.901 已发布

源码 dev@45d5652，包含 10 月 7 日同步的 Mac 增量与模板封装、预览和布局复用。完整 Rust 457 passed / 10 ignored、前端逻辑 153/153、模板 34 项、封装/更新 UI、隔离 CLI 和实际 NSIS 登录重置钩子通过；离线视频单测在临时 APPDATA 补齐正常启动生成的本版 launcher 后通过。安装包构建、旧公钥签名/篡改拒绝、x64/版本/资源/安装钩子及完整公网下载哈希核对通过，官网 Windows 更新清单、双首页和下载配置已切换。真实用户环境升级、登录重置与素材保留仍待专项验收；发布值、证据和回滚入口见 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)。

## 2026-10-07 同步 Mac 源码

`dev` 从 `f196d6c` 快进合入 `origin/mac@d537a66`。完整功能与平台边界见 [Mac → Windows 交接](../macOS/WINDOWS-SYNC-2026-10-07.md)，当前项目状态见 [PROJECT.md](../PROJECT.md)。本地既有模板封装改动已恢复并保持未提交；以下验证针对包含该增量的 Windows 工作区。共享源码版本为 26.9.2002，Windows 最近记录的已发布版本仍为 26.9.1803；本轮未打包、发布或部署云服务。

- 工作流循环、稳定输入管道、主输入追加/单格覆盖、内容交付恢复、本机 Agent 图文/表格、默认生图 provider、截图/贴图、会话组图、官方视频模型/积分与静态封面已同步。SQLite 0031–0033 沿原迁移链，不重复编号；循环等字段继续由 JSON 保存，无新增 SQL。
- Mac 原生标题栏、WKWebView、AVFoundation、debug 钥匙串辅助程序和签名 runner 保留平台条件；Windows 封面提取仍使用 FFmpeg，凭据隔离及 NSIS 安装清登录钩子保留。
- Windows 原生 examples 链接 Tauri 已生成的 Common Controls v6 资源，解决截图隔离夹具启动时报 `0xc0000139`。视频 UI 测试使用独立 Vite 配置，避免已有开发服务端口冲突。
- 验证通过：Rust 库 **457 passed / 10 ignored**、全部目标编译检查、前端逻辑 **153/153**、模板 **34 项**及 **21 组 Chromium 合成 IPC**（含封装）；canonical 与 `Windows/.work` TypeScript/Vite 构建、隐藏 WebView2 快捷键/贴图窗口、真实 FFmpeg 合成短视频入库及封面通过。视频 UI 首轮端口失败已修复并单独复跑通过；原生窗口关闭时有 WebView2 类注销 1412 日志，夹具断言通过且退出码为 0。
- 追加主程序 debug 构建在替换 `target/debug/bowerbird-desktop.exe` 时因现有开发实例占用失败；未终止用户应用，也不将这次构建记为通过。需要退出该实例后才能覆盖这个输出路径；源码同步与上述隔离验证已完成。
- 仍待验收：真实 F1/F3 屏幕与剪贴板操作、混合 DPI/多显示器、素材库升级副本及安装包、真实登录/付费任务恢复。当前隔离测试不操作用户库或模型，不等于这些项目已通过。证据在本机 `.tmp/mac-sync-20261007/`；同步前源码另有逐文件备份与保留的 stash。

原生及媒体复核命令（使用临时设置/测试库，不初始化生产应用）：

```powershell
cargo check --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets
cargo run --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --example screenshot_smoke
cargo test --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --lib generated_video_ingest_probes_short_clip_and_real_poster -- --ignored
```
~~~~

## macOS 旧版发布和交接

~~~~markdown
## 2026-10-15 Apple Silicon 26.10.1502 已发包

源码 `5fecb7c` 已存档推送，固定快照构建的 ARM64 DMG 与签名更新归档已上传 R2，完整公网哈希及原 Mac 公钥验签通过。包含下节同步增量及循环/视觉规范卡分享 v4；SQLite 0034。安装包 [R2 下载](https://pub-5e4c00c218cd4682b622cbab5e58563e.r2.dev/mac_package/Bowerbird_26.10.1502_aarch64-updater-installer.dmg)，打开后拖到 Applications。使用本地代码签名，未做 Apple 公证；未替换本机安装或操作正式库。官网更新通道仍 26.10.801，待 SSH 发布；完整证据与接续见 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)。

## 2026-10-15 Apple Silicon 接收远端 Mac 与工作流增量存档

本机 `4cc1faf` 后的工作流/Agent 增量已存档并与 `origin/mac@2392ebc` 组合，接收 Intel 分支的文件外部引用、分类、截图及布局更新；代码版本沿远端 26.10.1501、SQLite 至 0034。保留 Apple Silicon 原生与签名配置，ARM64 debug 二进制已编译验证，未启动新进程或发布安装包。现成 Intel 1501 包仍对应原 ef6b6f0，不包含本次新增工作流功能。完整范围、验证及其他端接收见 [跨端同步说明](CROSS-PLATFORM-SYNC-2026-10-15.md)。

## 2026-10-15 原 Mac 签名机接续（Intel 官网待切换）

在隔离工作树同步 `origin/mac@c718c0b`，保留开发机分叉历史及未提交增量。复用 Intel `ef6b6f0` 现成归档，以本机原 updater 私钥补签并生成有效 `darwin-x86_64-26.10.1501.json`；新增 `.sig`/清单已上传 R2，公网原包哈希与主/可信备注验签、文件一致性均通过。没有重新构建或改动原 tar/DMG。官网 Intel 仍为 404，候选入口已准备，缺签名机的 VPS SSH 登录凭据；Windows 26.10.1001 与 M 系列 26.10.801 保持。完整产物哈希、证据与发布边界见 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)。

## 2026-10-15 Intel 26.10.1501 发版交接

本轮按用户要求存档推送全部当前桌面增量，再构建 Intel 手动安装 DMG 与待签名 `.app.tar.gz` 并上传 R2，由另一台机器沿原 Mac updater 私钥签名。本机只在构建参数关闭 updater 产物自动签名，仓库更新公钥/入口/正式签名要求保持。包含 SQLite 0034；不部署云服务，不切官网更新清单。内容、测试、产物哈希和上传状态统一记录于 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md#intel-26101501-存档与-r2-交接2026-10-15)。本轮只读公网复核 M 系列已为 26.10.801、Intel 仍为 404。


**本轮结果：** 源码 `ef6b6f00a12e8d535a02e6733857f3c3b623936d` 已推送 `origin/mac`；Intel 26.10.1501 DMG、待签名更新归档与签名交接 ZIP 已构建并校验。R2 **已上传并公网核验**：使用用户补充的目标桶 S3 凭据上传更新归档、DMG、签名交接 ZIP 及各自 `.sha256`，共六件；远端大小/哈希元数据及公网完整下载 SHA-256 全部与本地一致。此前登录阻塞已解决，未申请 Workers 管理权限。官网清单未改。构建使用该提交隔离快照；构建期间新出现的 Jev score / 三维标签等并行修改保留在原工作区，不包含在本包。

## 2026-10-14 Intel 同步远端 mac（源码已验证）

通过 7890 代理获取远端 `mac`，本地快进至 `d6027fb`（26.10.801）。同步截图/贴图与全局快捷键、会话组图、Mac Cmd+Delete、静态视频封面及原生 MP4/AVFoundation、稳定签名/开发钥匙串辅助程序、工作流数据包与 SQLite 0031–0033；技能、工作流助手和模板库入口遵循远端关闭的 feature flags。

合并保留本机未提交的分类固定元组/系统代理、Intel 向量安装编译期保护及更新验签工具，同时保留远端向量包卸载、正确模型 revision 与新版功能。删除被编译期保护替代的 Intel 空运行库占位常量。发布脚本保留 `x64` DMG / `x86_64` 通道区分，融合远端 COS 与稳定签名流程；对应回归切换为 COS 环境变量。合并前补丁及原 tracked 修改保存在 `/private/tmp/bowerbird-sync-20261014/` 与命名 stash，未跟踪模型缓存未纳入 stash。

本机 Intel x86_64 验证：Rust 全量 **462 passed / 0 failed / 9 ignored**；画板纯逻辑 **133/133**；五组 Chrome 合成 IPC（截图、双平台删除快捷键、会话组图、分类、更新器）；TypeScript/Vite production build；Intel/ARM64 发布工具路径与签名/篡改检查通过。测试截图已保存到证据目录，并恢复仓库原有跟踪截图。保留既有 Rust 警告与 Vite 大 chunk 提示。架构说明索引中的 `dev-doc/Bowerbird开发计划.md` 当前工作树缺失，本轮依据 PROJECT.md、平台 README 与专项文档核对。

本次为源码同步与 Intel 原生编译/测试验证，未重新构建 release 安装包、安装到 Applications、调用真实付费模型、修改用户素材库或发布线上服务；截图真实屏幕授权/混合 DPI、正式升级与钥匙串交互仍需独立实机验收。当前本地源码版本为 26.10.801，不代表本机已安装应用已升级。证据：`macOS/dist/verification/sync-mac-20261014-intel/`。

## Intel 更新文件交接（2026-09-20）

同步远端 `mac` 至 `9c6158c`（26.9.2001），保留本机未提交的分类/代理修改。Intel 与 Apple Silicon 共用启动检查、设置内更新和原 Mac 更新公钥；Intel 的 channel 固定为 `darwin-x86_64`。`release.sh` 已区分 Tauri 的 Intel DMG 文件名 `x64` 与更新清单/归档的 `x86_64`，并拒绝非 Mac host。清单生成器现在先核验包的 minisign 主签名与可信备注签名，错误签名或其他密钥不会生成正式清单。

补齐远端向量下载器的编译条件：此前运行时 `vector_supported()` 检查无法阻止 Rust 在 Intel 上解析未定义的 ARM64/Windows 运行库常量，导致编译失败。现在只在有固定运行库的平台编译安装路径，Intel 明确返回原有不支持提示、不下载或创建向量目录，继续沿用 VLM 判断；没有新增或替换模型。并修复恢复本地测试时与新 `Label` 字段/分类方法参数的接缝。

本机没有原 Mac updater 私钥；用户自行上传 R2，无需提供 R2 凭据。交付目录提供手动 DMG、待签名的 Intel `.app.tar.gz`、SHA-256、清单模板、原公钥、补齐清单工具及说明。待签名包可送到已有私钥的原 Mac 签名机签署，无需重新编译 Intel 应用；将生成的 `.sig` 返回交付目录后，执行附带脚本验签并生成正式 `darwin-x86_64.json`。模板不可直接发布，不重新生成密钥，不复用 ARM64 签名。

2026-09-20 公网核对：Intel 入口返回 307，目标清单仍为 404。R2 上传后还须由发布侧将官网 `downloads/updates/darwin-x86_64.json` 替换为有效清单，或把 `BOWERBIRD_DARWIN_X86_64_UPDATE_MANIFEST_URL` 指向 R2 上的正式清单；仅上传安装包不会消除检查错误。当前不修改线上服务。

发布工具回归：`node macOS/update-release.test.mjs`（Intel/ARM64 路径、原始 minisign 测试向量、篡改拒绝、缺签名及非 Mac host）；官网路由回归：`node website/scripts/app-updater.test.mjs`。

本轮 Intel 验证：Rust **383 passed / 8 ignored**（无过滤）、前端契约 **141/141**、更新器/分类/引导三组 Chrome 合成 IPC 界面、发布工具与路由回归、TypeScript/Vite 和 release 构建通过。DMG `Bowerbird_26.9.2001_x86_64-updater-installer.dmg`，**86,892,417 bytes**，SHA-256 `52f75db9a10a7359c37c49b89cbb22d238c6dad679ae943da537fd734e7162fa`；镜像完整性、只读挂载后应用逐文件一致、Applications 链接、背景及 `.DS_Store` 通过。核对 **421 个构建输入、68 个内置资源**、26.9.2001/x86_64 与原公钥保持。旧镜像仍挂载，重包仅将固定脚本的挂载位置换为独立临时目录，不影响布局。

合集：`macOS/dist/Bowerbird_26.9.2001_Intel_Update_Files.zip`（附 SHA-256）；更新归档、哈希、清单模板、验签/清单工具及相关源码在其中。证据：`macOS/dist/verification/intel-update-20260920/`。未运行真实模型质量测试、真实应用内升级、账号登录或用户库迁移；未做 Developer ID 签名及 Apple 公证，未上传或部署。

## 2026-09-20 Mac 26.9.2001 更新包（本机构建待上传）

## 2026-10-13 接收 Windows dev 后续更新

已从 `1775a81` 合入 `origin/dev@55f4d93`（合并 `c413250`），同步多结果引用、二维表格、循环轮次、Agent 普通会话生图和画板交互修复。保留 Mac 26.10.801、原生配置及本机未提交的撤销/定向输出/比例透传/起始项预览；「生成任务」与分类图片出口共同保留，新生图异步交给普通会话。

组合工作区通过 TypeScript/Vite、前端逻辑 149/149、Rust 全量 463 passed / 7 ignored、release 专项 6/6、17 组合成 IPC、五组实际 production Agent、三组隔离系统 WKWebView 和 Intel 编译检查。原始备份/stash 与未提交状态保留，本轮未发布新包。完整范围、冲突处理和原生验收边界见 [10 月 13 日接收记录](DEV-SYNC-2026-10-13.md)。

## 2026-10-15 Intel 26.10.1501 已上线

Intel 新包已完整下载核对哈希与旧公钥签名，官网 Intel DMG 按钮与 darwin-x86_64 自动更新通道已开放。Windows 26.10.1001 / M 系列 26.10.801 保持。使用 R2 版本化清单 darwin-x86_64-26.10.1501.json，固定 R2 清单仍旧，不可误用；Intel URL 被编译为分段写入，整串搜索失败不等于缺失。真实 Intel 安装、升级迁移与 Apple 公证未验收。详见 [桌面更新发布记录](../dev-doc/DESKTOP-UPDATES.md)。

## 2026-10-15 接收 Windows 最新源码

最新交接见 [Windows 端更新内容 — 26.10.1001](../Windows/Windows端更新内容-26.10.1001.md)：相对 Mac `d6027fb`，覆盖 901–1001 发布变更及其后二维表格、Agent 生图投普通会话、视频截帧与错误诊断。后四项仅源码存档，尚未包含在 Windows 1001 包；Mac 公开版本仍为 801。接收时核对文档对应提交，保留 Mac 配置与签名，按交接清单验证 WKWebView 与 release 行为。

## 2026-10-10 接收 Windows dev 更新

`mac` 已从 `d6027fb` 快进接收 `origin/dev@cf6d43d`，包括容器/v3 布局、正式版图文/Codex Agent、视频生成卡与查询超时恢复。Cargo/Tauri/锁文件保持 Mac **26.10.801**，Mac updater 公钥、稳定签名、标题栏/WKWebView/钥匙串/媒体实现与三个暂隐开关保持。容器测试撤销改按平台使用 Cmd/Ctrl+Z；Windows NSIS 登录保留钩子仅由 Windows 执行。

验证：TypeScript/Vite、画板逻辑 133/133、Rust 全量 462 passed / 0 failed / 7 ignored、Rust release 专项 5/5、8 组工作流专项、三组 DEV=false/实际 production bundle Agent、三组系统 WKWebView production 图文交付/恢复及 Intel cargo check 通过。测试采用临时数据库、合成素材、假 CLI/模拟 IPC 和非持久化 WebView；日志在本机 `macOS/dist/verification/sync-dev-20261010/`。本机已有开发进程因源码合入自动重编，本轮未操作其界面或正式素材库。

本轮未封装/发布新包，也未改官网或云端；现役 Mac 801 的旧行为仍由旧安装包决定。正式安装后的 BYO/私有 CLI/DSH 登录与会话、原生对话框、真实数据升级、视频任务及安装更新重启另行验收。完整范围和接收记录见 [Windows → Mac 更新交接](DEV-SYNC-2026-10-10.md)。

## 2026-10-08 Mac 26.10.801 已同步 VPS

构建交接来自 origin/mac@d6027fb（源码 08ada63），Apple Silicon 新包及版本化清单已完整下载、哈希和旧公钥验签通过。官网 Mac 更新清单与双首页现为 26.10.801；Windows 保持 26.9.1803，Intel 通道未发布。Mac 侧“缺 SSH、官网待切换”状态已解除。本轮只发布已有产物，不合并该分支源码；真实安装/重启、升级数据与 Apple 公证仍待验收。详细产物、发布/回滚目录见 [DESKTOP-UPDATES.md](../dev-doc/DESKTOP-UPDATES.md)「Mac 26.10.801 VPS 发布」。

## 2026-10-07 源码存档与 Windows 同步

自上次 mac 推送 `e63841a` 以来的完整增量、共享代码与 Mac 专属实现、迁移及 Windows 验收清单见 [Windows 同步说明](WINDOWS-SYNC-2026-10-07.md)。本轮仍为源码交接，未生成或发布新版安装包；项目当前状态以 `PROJECT.md` 为准。

## 2026-09-24 同步 dev 工作流与模板（源码未发布）

`mac` 从 `e63841a` 合入 `origin/dev@f196d6c`：画板工作流、内容卡、模板库与 `.bbworkflow.json` 分享、planning-v2 编排、并行调度及 SQLite `0031`–`0033` 均使用正典实现。保留 Mac `26.9.2002` 版本与 updater 公钥、原生标题栏/WKWebView、稳定签名配置、refresh token 缓存、原生 MP4 探针及 Intel 向量模型回退。版本号未提升，本轮没有生成或发布新版安装包。

Mac 接缝修正：Agent DS 比较会话 cwd 时两侧均解析符号链接和 `..`；Unix 不再错误套用 Windows 小写/反斜杠归一化。隔离目录回归先复现旧逻辑失败，再确认修复；Windows 路径用例继续通过。工作流框选/剪贴板测试按平台使用 Command 或 Control，旧画板抽取式测试补齐工作流和生成状态夹具。

本机构建环境：Apple Silicon，Rust 1.97.1，Node 22.22.1；使用仓库现有依赖和锁文件。验证：

- TypeScript 与 Vite production build 通过，保留既有大 chunk 提示。
- 画板/工作流/生成恢复/路由纯逻辑 **150/150**。
- **12 组 Chrome 合成 IPC 回归**：工作流 UI、运行/调度、模板库（34 项）、编排协议（50 项）、助手（48 项）、来源引用、初始化、Command 混合框选/复制/粘贴/撤销、标注添加画板、双平台标题栏。
- Rust 全量 **417 passed / 0 failed / 6 ignored**；Agent DS 专项 11/11（包含在全量内），既有依赖真实模型/外部工具的 ignored 测试未启用。
- `cargo build --offline --locked --release` 通过，输出为 arm64；这是编译检查，没有封装 `.app`/DMG。
- `cargo check --offline --locked --target x86_64-apple-darwin` 通过。
- 隐藏原生 AppKit 窗口验证红黄绿按钮、装饰与浅深主题通过。

保留既有 Rust 警告。相对 `origin/dev` 的增量 diff 空白检查通过；全合并检查中的 `logo1.ai` 空白与 profile 测试末尾空行已核对和 dev 完全同字节，未改写上游素材。日志证据保存在本机 `macOS/dist/verification/sync-dev-20260924/`。测试使用临时数据库和模拟 IPC；未启动生产应用、改写真实素材库或账号、调用付费模型、执行真实 DSH 投递、构建安装包或部署。完整 WKWebView 工作流、原生文件对话框、Intel 实机及更新安装仍未验收。开发版 Agent DS/工作流助手保持 debug/dev 门控，release 隐藏入口。

## 2026-09-21 Mac 26.9.2002 已发布

发布侧核验 R2 上现成 26.9.2002 更新包及 DMG 后，已同步官网 Mac 清单与两份首页入口。完整下载哈希、旧公钥签名/篡改拒绝、ARM64/包内版本及公网链路通过；Windows 保持 26.9.1803。2002 接替 2001 历史构建，不再按旧交接发布 2001。产物、回滚及验收边界见 [DESKTOP-UPDATES.md](../dev-doc/DESKTOP-UPDATES.md)「Mac 26.9.2002 发布记录」。原生更新/重启及 Apple 公证仍待验收。

## 2026-09-20 Mac 26.9.2002 双架构更新包（双架构构建与上传记录）

收录 9 月 19/20 全部工作：本地分类向量精确匹配判官（jina-clip-v2 int8，可选安装/面板卸载、未装回退 VLM）与可选云端最终校验 Jev、画板新卡锚定当前可视区左上角、视频卡独立样式与 ▶ 徽标、文本卡表格增强（标题编辑/整表复制 CSV/行高列宽拖拽）、创作模式空白框选、视频创作免本地 FFmpeg（原生 MP4 探针）、mac「打开所在文件夹」Finder 选中与对话框方向键乱码修复、钥匙串弹窗根治（refresh token 内存缓存 + 稳定本地签名身份）。**26.9.2001（20 日第 1 包）在本机核验后、上传前被同日第 2 包取代**：工作区随后新增钥匙串修复等改动且分发迁移 COS，为使发布包包含这些修复并统一双架构版本，按同日序号规范升为 **26.9.2002**（> 线上 26.9.1901，护栏通过）；2001 产物从未上传任何存储，本地产物与发布说明已删除，勿再使用 `/tmp/bowerbird-release-26.9.2001/` 的交接脚本。构建前验证：Rust 全量 **384 passed / 6 ignored**、画板纯逻辑 **127/127**、local-classification UI 回归与 `tsc --noEmit` 通过。

双架构构建（产物在 `macOS/dist/`，不入 Git）：aarch64 用 `COS_SKIP_UPLOAD=1 bash macOS/release.sh macOS/dist/release-notes-26.9.2002.txt`（自动检测并使用钥匙串内 `Bowerbird Local Code Signing` 稳定签名身份）；Intel 在同一台 Apple Silicon 本机交叉编译——`rustup target add x86_64-apple-darwin` 后以 `APPLE_SIGNING_IDENTITY="Bowerbird Local Code Signing" pnpm tauri build --target x86_64-apple-darwin --bundles app,dmg` 构建，再按 release.sh 同样步骤归档/校验/生成清单（交叉编译首个坑见 PROJECT.md 踩坑：vector.rs 平台常量在未支持目标缺失导致编译失败，已补占位定义，install 入口护栏保证占位值不可达）。

- **aarch64（M 系列）** 更新包：`Bowerbird_26.9.2002_aarch64.app.tar.gz`，**86,394,528 bytes**，SHA-256 `03ef60428b9118efe7812ea8d3c57dcb255723ae63422c7e9f70dcc8c7b32ee3`；手动 DMG `Bowerbird_26.9.2002_aarch64-updater-installer.dmg`，**86,875,629 bytes**，`5fd72b14205ba8600cd0f8f43470d70377c360de96ec7b8ab07ab1ae5b4354df`；清单 `darwin-aarch64.json`（SHA-256 `2c6b61588a1d7254ade6a4fe4e4f9a6f55ab090ae41fd4867daf87817adba13a`）。
- **x86_64（Intel）** 更新包：`Bowerbird_26.9.2002_x86_64.app.tar.gz`，**86,851,474 bytes**，SHA-256 `80f4c2f023e745f4315189f61407b5b9ef987e15143432e0aba46492fd592e9d`；手动 DMG `Bowerbird_26.9.2002_x86_64-updater-installer.dmg`，**87,370,482 bytes**，`725073a0ef04691155cafe78dcfd599aae1c9a33d6347f6b25fcfa2e5ca5b621`；清单 `darwin-x86_64.json`（SHA-256 `16f35772060bb0c124bac84ce74838035a2f665f612e293cab65cd34dfeea7b7`）。两份清单 URL 均指向 R2 r2.dev `mac_package/` 直下——COS+CDN 未就绪，按用户决策应急回指 R2；此前的 cdn 版清单哈希（`490acc94…`/`32b57b50…`）作废，COS 就绪后需用 cdn URL 重新生成清单再切换。DMG 未 Developer ID 公证；Intel 的向量精确匹配包暂不可用（onnxruntime 1.28.0 无 macOS x86_64 资产），面板显示不支持并回退 VLM 判断。

双架构本机核验均通过：`CFBundleShortVersionString` = 26.9.2002、Mach-O 架构分别为 arm64/x86_64、二进制内嵌 Mac 公钥与 `tauri.macos.conf.json` 及已发布 26.9.1802/1901 逐字节一致（key id `0b5a2efc4865664f`）、`codesign -dvv` Authority = `Bowerbird Local Code Signing` 且 `--verify --deep` 通过（首个带稳定签名身份的发布包）、DMG `hdiutil verify`、minisign 主签名与全局签名（`minisign-verify` 0.2.5 同构造）、篡改字节拒绝、清单 signature 与 `.sig` 逐字节一致。Intel 包未在真实 Intel 机器运行验收（本机为 Apple Silicon），属发布后待补项。

**发布进度（2026-09-21，应急走 R2；上传与公网核验已完成）：** 原计划自本版起迁移腾讯 COS + CDN（`cdn.bowerbird.cn`），但控制台前置（建桶/CDN 域名/证书/CNAME）尚未完成、`cdn.bowerbird.cn` 不可达，按用户决策 26.9.2002 **先走 R2 应急首发**：两份清单包 URL 回指 r2.dev 直下。**2026-09-21 01:31–01:45 已上传并核验**：`upload-r2.sh`（`macOS/.signing/r2.env` 四行凭据）上传双架构 12 件，本地哈希断言、公网完整下载哈希、minisign 主/全局签名、双清单公网哈希、四个大文件 HEAD 大小、26.9.18/1802/1901 历史包仍在全部通过；当晚 r2.dev 下载速度波动大（一次 300 秒仅 66MB、一次中断后续传完成），慢路由用户可能触发客户端 300 秒下载超时需重试——印证迁 COS 的必要性。历史交接步骤（aarch64 与首页已由上节发布记录确认完成，Intel 仍待上线）：①服务器 106.55.44.143 依次跑 `swap-manifest-aarch64.sh`（备份 26.9.1901 清单 → 哈希断言 `2c6b6158…` → 原子替换 → 公网复核）与 `swap-manifest-x86_64.sh`（Intel 通道首次上线：核验 `16f35772…` 后新建清单，回滚即删文件）；②首页 Mac DMG 按钮（仓库两份首页已指向 R2 的 26.9.2002 DMG）随候选→原子切换发布。COS 就绪后的迁移不变：届时用 cdn URL 重新生成双架构清单、镜像历史包再各自切换一次。本轮未运行真实应用内更新。

## 2026-09-19 Mac 26.9.1901 更新包（已发布）

合并远端 dev `3f089bf`（Windows 26.9.1803 源码：启动静默检查更新与可跳过提醒 `StartupUpdateDialog`、仅开放设计师路线、账号升级直达权益/兑换面板、官网快照对齐）并纳入 mac 侧本地分类误标根治后出包。版本按同日 patch 序号规范定为 **26.9.1901**（9 月 19 日第 1 包；因前日已用 26.9.1802/1803 四位序号，19 日首个包需用 1901 才能高于线上 darwin-aarch64 26.9.1802，护栏通过）。合并后验证：Rust 全量 **371 passed / 5 ignored**、TypeScript `tsc --noEmit`、app-updater/引导/本地分类三组 UI 回归通过（随包 Vite production build 在 tauri build 内完成）。

用 `R2_SKIP_UPLOAD=1 bash macOS/release.sh macOS/dist/release-notes-26.9.1901.txt` 完成签名构建与归档（本轮仅本地产出，未上传 R2）：arm64 二进制内嵌 Mac 公钥、`CFBundleShortVersionString` = 26.9.1901、DMG `hdiutil verify` 通过。产物在 `macOS/dist/`（不入 Git）：

- 更新器安装包：`Bowerbird_26.9.1901_aarch64.app.tar.gz`，**85,893,526 bytes**，SHA-256 `af077004a66804fe9f16c79ecf35828b3acdfd5b00df48c64090b29b5c3ec06f`；同名 `.sig`/`.sha256` 附带。
- 手动安装 DMG：`Bowerbird_26.9.1901_aarch64-updater-installer.dmg`，**86,439,465 bytes**，SHA-256 `f1d59df9ed63c6c9ff7a7eb15fb922a037e960103e863cf178247cc3af2035bf`；未签名/未公证。
- 更新清单：`darwin-aarch64.json`（version 26.9.1901，notes 为本地分类防误标与启动检查更新说明，URL 指向 R2 直下 `mac_package/Bowerbird_26.9.1901_aarch64.app.tar.gz`）。

**已发布（2026-09-19/20 交接确认）：** 上述 26.9.1901 产物已经发布侧执行清单原子替换上线，2026-09-20 公网复核线上 darwin-aarch64 清单为 26.9.1901；26.9.1802 客户端经设置手动检查升级，启动静默检查自本版本起在 Mac 生效。后续 26.9.2002 见上节。

## 2026-09-18 Mac 26.9.1802 引导更新包（已发布）

合并 dev `56699d3`（官网更新修复 + 设计师引导文案与 7.1 步骤）后，按 [DESKTOP-UPDATES.md](../dev-doc/DESKTOP-UPDATES.md) 流程构建同日第二包：版本采用同日 patch 序号规范 **26.9.1802**（tauri.conf.json + Cargo.toml，> 已发布 26.9.18，updater 识别为升级），签名 release 构建通过；合并后引导契约 **14/14**、三身份引导 UI 与 v0917 包界面回归通过。arm64 二进制内嵌 Mac 公钥，`CFBundleShortVersionString` = 26.9.1802，DMG `hdiutil verify` 通过。产物在 `macOS/dist/`（不入 Git）：

- 更新器安装包：`Bowerbird_26.9.1802_aarch64.app.tar.gz`，**85,891,597 bytes**，SHA-256 `70696d89fbdc9a2794038ebb68c739c4eb142e62f89253830b45ab6846d40be5`；同名 `.sig`/`.sha256` 附带。
- 手动安装 DMG：`Bowerbird_26.9.1802_aarch64-updater-installer.dmg`，**86,425,875 bytes**，SHA-256 `3ba05d84f3d523ee526b831b149e79e22ebeaf4777bbbbffa784fd0d4d2b70d3`；未签名/未公证。
- 更新清单：`darwin-aarch64.json`（version 26.9.1802，notes 为设计师引导更新说明，URL 暂指官网镜像 `https://bowerbird.cn/downloads/Bowerbird_26.9.1802_aarch64.app.tar.gz`；若沿用 R2 直下，发布前用实际 URL 重新生成清单）。

**已发布（同日）：** 上述 26.9.1802 产物已经双端发布流程核验上线，`darwin-aarch64` 清单现指向 R2 直下包；发布证据与验收边界以 [DESKTOP-UPDATES.md](../dev-doc/DESKTOP-UPDATES.md) 为准。（曾短暂构建过 26.9.19 版本号，不符合同日序号规范，产物未发布已删除。）

## 2026-09-18 Intel 安装包（26.9.18，本地交付）

经 7890 代理同步远端：`dev` 为 `a7d5dae`，`mac` 快进至 `add14dd`，已包含该 dev 更新及 Mac darwin 更新通道配置。本机原有分类批量固定元组和系统代理修复恢复到工作区，继续保持未提交；保留远端 GPU/CPU 路径、标签先于证据的输出顺序和重复/遗漏后的逐项重判。原修改保存在同步前 stash，未跟踪截图与远端新增跟踪文件的冲突副本保存在 `.tmp/sync-20260918/untracked-before-sync/`。

验证：Intel Rust 库 **371 passed / 7 ignored**（无过滤），核心契约 **150/150**，**8 组 Chrome 合成 IPC**（分类、更新器、禁用提示、引导快照/流程、标题栏、探索、创作框），TypeScript/Vite 和 release/app 构建通过。标准 DMG 命令成功但只读检查发现缺少 `.DS_Store`，因此复用同一应用，按固定 `package-dmg.sh` 重新封装，未重复编译。引导首次导航两次超过 10 秒，页面已正常渲染；将导航等待与现有快照测试统一为 60 秒后通过，操作断言仍为 10 秒。真实 Tauri/AppKit 隐藏窗口验证标准关闭、最小化、缩放按钮及主题通过。未运行真实模型质量验收、用户库迁移或真实 OAuth；既有误分类边界保留。

本机缺少既有 Mac updater 私钥，因此仅本次以构建参数 `bundle.createUpdaterArtifacts=false` 生成手动安装包；仓库 updater 配置、公钥与应用内更新入口保持。本次**没有生成签名自动更新归档/清单**，没有新建或替换签名密钥，也未上传或部署官网通道。需要可发布的自动更新包时，须使用与现有 Mac 公钥匹配的私钥，按本文签名流程另行生成。

- 手动安装：`macOS/dist/Bowerbird_26.9.18_x64-installer.dmg`，**86,543,066 bytes**。
- SHA-256：`047700d7a8a1623b2b93bdb9590691bd248b524721add6ca7bd377053f97d98b`，同目录附 `.sha256`；旧安装包保留。
- 版本 **26.9.18**、架构 **Intel x86_64**、bowerbird 协议、原生采集桥接及 Mac 更新公钥核验通过；**68 个资源文件**与源码匹配。
- 构建开始记录 **535 个输入**；其中仅引导测试导航等待在构建期间修改并单独复跑，其余输入不变。最终指纹全部匹配。
- DMG 完整性、只读挂载的应用逐文件一致性、`Applications -> /Applications`、固定背景及 `.DS_Store` 均通过，挂载已推出。打开镜像后将 Bowerbird 拖到 Applications。
- 证据：`macOS/dist/verification/sync-dev-20260918-intel/`；未经 Developer ID 签名/公证，未替换 `/Applications` 的现有应用，未做截图/录屏验收。

## 2026-09-18 Intel 更新检查排障

公网已部署 Mac 路由，Apple Silicon 的 26.9.18 清单当前返回 200；Intel 路由重定向到尚不存在的 `darwin-x86_64.json`（404），因此客户端提示无有效 release JSON。下方此前“Mac 服务端待部署”的记录为当时状态。需要补发 Intel 签名更新归档及清单，无需重装当前手动安装包；不以 204 掩盖缺失发布。

已准备 `macOS/dist/pending-intel-updater/Bowerbird_26.9.18_x86_64.app.tar.gz`（85,860,731 bytes，附 SHA-256），71 个应用文件及执行权限与已验证应用一致。该文件尚未签名/发布，等待与当前 Mac 公钥匹配的原私钥；不得当作正式自动更新产物使用。未修改官网或客户端代码。

## 2026-09-18 R2 上传交付包

用户要求自行上传 R2、不提供私钥，已整理 `macOS/dist/Bowerbird_26.9.18_Intel_R2.zip`（附 SHA-256）。解压后 `upload/` 包含 Intel DMG、更新 tar.gz 及两个校验文件；另有上传说明、文件清单与 `templates/darwin-x86_64.json.template`。模板包含待填签名/URL，不能直接作为正式清单发布。ZIP CRC 与两份产物 SHA-256 均校验通过；不含私钥、不修改客户端验签。R2 文件托管完成后，自动更新仍需对应签名及官网清单路由配置，本轮未上传或部署。

## Mac 应用内更新（darwin 通道，2026-09-18 配置）

Mac 与 Windows 共用 Tauri 官方 updater 及同一入口 `https://bowerbird.cn/api/desktop-update/{{target}}-{{arch}}`；官网端点现接受 `darwin-aarch64` 与 `darwin-x86_64`，307 跳转到 `https://bowerbird.cn/downloads/updates/darwin-<arch>.json`（可用 `BOWERBIRD_DARWIN_AARCH64_UPDATE_MANIFEST_URL` / `BOWERBIRD_DARWIN_X86_64_UPDATE_MANIFEST_URL` 覆盖），其他平台仍返回 204。

Mac 使用**独立签名密钥**，与 Windows 通道互不影响：私钥在本机被 Git 忽略的 `macOS/.signing/updater.key`（当前为空口令，首个 Mac 更新版本发布前可换为带口令密钥并同步更新 pubkey——一旦有带更新入口的 Mac 版本发布，密钥不可再换），公钥覆盖在 `apps/desktop/src-tauri/tauri.macos.conf.json` 的 `plugins.updater.pubkey`。共享 `tauri.conf.json` 已开启 `createUpdaterArtifacts`，因此**每次 mac 构建都必须提供私钥**，否则打包在签名一步失败：

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat macOS/.signing/updater.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
pnpm tauri build --bundles app,dmg
```

（密钥文件是空口令的 minisign 加密容器；不显式给 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""` 时 CLI 会尝试交互式询问口令，无终端的打包脚本直接失败。）

构建产出 `apps/desktop/src-tauri/target/release/bundle/macos/Bowerbird.app.tar.gz` 与同名 `.sig`（updater 安装包及 minisign 签名）。发布流程沿用 Windows 约定：

1. 版本高于已发布版本；按本机 `rustc -vV` 架构选 `aarch64` 或 `x86_64`。
2. 上传前把 `Bowerbird.app.tar.gz` 重命名为 `Bowerbird_<版本>_<架构>.app.tar.gz`，连同 `.sig` 上传官网 downloads；核对下载内容与本地哈希一致。
3. 生成本平台清单（signature 填 `.sig` 文件内容，不是地址）：

   ```bash
   node macOS/update-manifest.mjs \
     apps/desktop/src-tauri/target/release/bundle/macos/Bowerbird.app.tar.gz \
     <aarch64|x86_64> \
     https://bowerbird.cn/downloads/Bowerbird_<版本>_<架构>.app.tar.gz \
     darwin-<架构>.json [release-notes.txt]
   ```

4. 原子替换官网 `downloads/updates/darwin-<架构>.json`；官网 server 部署含新端点的 `website/server.mjs` 后通道生效。
5. 更新器在 Mac 上的行为：下载 `.app.tar.gz`、内置公钥验签通过后替换正在运行的 `.app` 并重启（`appUpdater.ts` 的 install 后 relaunch 路径）；素材、项目与 Keychain 登录状态保留，没有 Windows 的清登录钩子。

边界：updater 签名只保证更新包完整性，与 Developer ID 签名/公证无关；当前 DMG 仍为未签名本地测试包，公开分发前仍需完成签名公证。老版本 Mac 安装包没有更新入口，需先手动安装一次带更新入口的版本。官网服务端改动需另行部署后通道才实际可用；本轮只完成本机配置与验证，未上传任何产物。

## 2026-09-18 首个 Mac 更新包（26.9.18 aarch64，本机构建待上传）

按上节流程完成首个 darwin 更新包：签名 release 构建（`--bundles app,dmg`）通过，二进制为 arm64、内嵌 Mac 公钥（Windows 公钥为 0）。标准 Tauri DMG 阶段本机首次直接通过，`hdiutil verify` 校验有效，挂载检查含 `Applications -> /Applications` 快捷方式、`.background` 背景与图标布局。产物在 `macOS/dist/`（不入 Git）：

- 更新器安装包：`Bowerbird_26.9.18_aarch64.app.tar.gz`，**85,891,464 bytes**，SHA-256 `e7d51d75be739a3ff121a51694350b2b807056c33439b1e2bf23a7da9f7c3d91`；同名 `.sig` 与 `.sha256` 附带。
- 手动安装 DMG：`Bowerbird_26.9.18_aarch64-updater-installer.dmg`，**86,425,997 bytes**，SHA-256 `1504d411b2f3fe48a85c3e74057bf6696f57d64d04773a2166b0b84b13f35f3d`；未签名/未公证，仅本地测试。
- 更新清单：`darwin-aarch64.json`（version 26.9.18，signature 为 `.sig` 内容，URL 指向 `https://bowerbird.cn/downloads/Bowerbird_26.9.18_aarch64.app.tar.gz`）。

**后续（同日）：** 上述产物经用户 R2 中转由 Windows 侧核验后已正式发布：`darwin-aarch64` 清单上线（实际下载走 R2，官网留镜像），入口/清单/包与双端公钥验签通过，官网现役目录 `20260918-mac-updater-published`。本节「尚未上传/未部署」的表述自此作废；发布证据、复测命令与验收边界统一见 [DESKTOP-UPDATES.md](../dev-doc/DESKTOP-UPDATES.md)。仍未完成：x86_64（Intel）通道、Developer ID 签名/公证、旧版 → 新版实机替换重启验收。

## 2026-09-18 同步 dev 26.9.18

`mac` 合入远端 dev `a7d5dae`（26.9.18 更新器发布与桌面改进归档）。新增内容：Windows 应用内更新与官网更新通道源码（`AppUpdateCard`、`appUpdater`、`tauri.conf.json` updater 公钥/端点、`tauri-plugin-updater/process`、官网 `desktop-update` 接口与 `update-manifest.mjs`，版本升至 26.9.18）、本地分类 NVIDIA CUDA GPU 加速与重复标签逐项重判、下载错误带系统代理提示，以及文档索引整理（CLAUDE.md 收敛为指向 AGENTS.md 的入口）。

冲突融合：本地分类 runtime 在 mac 跨平台 RuntimePack（macOS 13.3+ Intel / Apple Silicon、`sw_vers` 版本门控、`/usr/bin/tar` 解压、可执行位校验）之上并入 dev 的 CUDA 路径——`extract_runtime` 统一为「归档名 + 目标目录 + server 路径 + 取消」签名，`Server::start` 先试 GPU 再回退 CPU 并回报实际后端；mac 上 `nvidia_available`/`gpu_installed` 自然为 false，保持 CPU 推理。分类面板同时显示 GPU 加速状态与 macOS 支持范围文案。保留 WKWebView 原生取图、系统标题栏、Finder 路径探测、微信 `RunEvent::Opened` 回流、`tauri.macos.conf.json` 与 DMG 固定交付规范。

修一个本机既有缺口：`explorer_smoke` example 通过 `#[path]` 直接编译 `source_browser_network.rs` 且不引用库 crate，cargo 不向 example 传递 build.rs 的 `-l static=bowerbird_browser_capture`，原生 arm64 全量 `cargo test` 因此链接失败（此前记录来自 Intel 环境产物）。在 macOS extern 块补 `#[link(name = "bowerbird_browser_capture", kind = "static")]`，任何编译该模块的目标都自带链接指令；example 及全套测试恢复链接。

本机（Apple Silicon、rustc 1.97.1）验证：Rust 全量 **368 passed / 0 failed / 5 ignored**（无过滤，首次在此机器跑通含 examples 的全套）；画板/生成契约 **125/125**、引导 **14/14**；`local-classification-ui`、`app-updater-ui`、`composer-disabled-tooltip-ui`、`onboarding-pack-ui`、`onboarding-ui` 五组 Chrome 合成 IPC 回归、TypeScript `tsc --noEmit` 与 Vite production build 全部通过，保留既有 Rust 警告与大 chunk 提示。文档同批更新：PROJECT.md 新增同步里程碑并按「只保留 3 条」将旧条目移入进展归档，LOCAL-CLASSIFICATION/ONBOARDING 融合双平台记录。

本轮仅本地合并与测试：未打包 DMG、未运行真实模型下载/GPU 推理（Mac 无 CUDA 路径）、未操作真实账号或素材库、未推送分支或部署服务。Mac 更新通道在同日另行配置（见上节）；官网服务端与清单未部署前，Mac 检查更新仍表现为无更新或失败，不代表自动更新已可用。

## 2026-09-17 本地分类批量匹配与下载修复

匹配输出使用固定顺序的标签元组，每个位置绑定一个名称，修复模型重复选择同一标签、导致整张图片无法保存的问题；面板区分“已尝试 / 成功 / 未完成”。同包纳入 Mac 系统代理下载和底层网络错误提示。已有模型无需重下，退出旧应用并覆盖安装后，可用“识别未处理素材”重试失败图片；本轮未替换 `/Applications` 中正在使用的应用。

分类回归 **16 passed / 3 ignored**、分类 Chrome 合成 IPC、TypeScript/Vite 通过。真实生产分类函数在隔离库对 **3 张示例、每张 9 个已有标签全部完成保存**（147.80 秒）；原有质量 smoke 的产品图误命中“野生动物”仍导致断言失败，保留该已知问题，不能宣称准确率验收通过。系统代理真实下载探针沿用本次此前已通过的结果；完整说明见 `dev-doc/LOCAL-CLASSIFICATION.md`。

标准 Tauri release/app/DMG 构建通过；**520 个构建输入未变化**，**68 个包内资源文件（含图标）**与上一份会话修复包一致。26.9.17、x86_64、协议注册、新匹配提示词与代理诊断标记核验通过；DMG 完整性、只读挂载的应用逐文件一致性、Applications 目标、背景资源及 `.DS_Store` 均通过，挂载已推出。保留既有编译警告，未做截图/录屏或 Apple Silicon 真机验收。

本地未签名/未公证 x64 测试包：`macOS/dist/Bowerbird_26.9.17_x64-classification-fix-installer.dmg`，**86,349,468 bytes**；SHA-256 `2c00985884e1d5438d34d4d44b6d00cb2b5df1404ee583def2ec0c4c6a67dfac`，同目录附 `.sha256`，旧包保留。日志、构建指纹和检查结果位于 `.tmp/local-classification-batch-fix/`。未提交或推送代码，未部署服务端。

## 2026-09-17 引导快照会话与创作提示存档重包

引导卡片从本地画板快照恢复多轮会话，复用普通生成详情和 Lightbox；提示词复用保留引用图、节点、历史别名与画幅。引导右箭头仅在当前步骤完成后推进；创作按钮通过悬停或键盘焦点显示禁用原因。同步保存画板标题与操作提示调整。

本轮验证：画板/生成逻辑 **125/125**、引导逻辑 **14/14**，三身份引导、真实引导快照、禁用原因提示、普通会话续聊 **4 组 Chrome 合成 IPC 回归**通过；TypeScript/Vite 与 Rust release 构建通过。界面测试首次因沙箱禁止绑定本机端口失败，放行后全部通过。260 个原生输入在构建开始时与上一轮验证版本一致，沿用上一轮 Rust **363 passed / 2 ignored**，本轮未重复执行 Rust 测试。保留既有编译警告。

标准 DMG 阶段失败后，使用固定 `package-dmg.sh` 封装本轮 `.app`，应用逐文件一致性、Applications 目标、背景与布局文件、镜像完整性通过。67 个包内资源匹配，版本 26.9.17、Intel x86_64 与 bowerbird 协议注册核验通过。

产物：`macOS/dist/Bowerbird_26.9.17_x64-conversation-installer.dmg`，**86,321,098 bytes**；SHA-256 `038572c9b16551c2d775b90fcf0337c609c1fdc0d98a60c1d674fb17a36278c5`，同目录附 `.sha256`，旧包保留。仅供本地测试，未签名/未公证；打开镜像后将 Bowerbird 拖到 Applications。

证据位于 `macOS/dist/verification/archive-20260917-conversation/`。构建开始保存 415 个输入指纹；等待期间另一任务修改 Cargo.toml、Cargo.lock 和本地分类 runtime.rs，其余 412 项保持一致。本轮存档不纳入这组并行修改；已保留构建输入清单和独立应用副本，二进制不含并行 runtime 新增的系统代理提示。其后新增分类文档也继续留在工作区。未执行真实 OAuth、生成服务、用户库写入或 Apple Silicon 验收，未推送或部署。

## 2026-09-17 引导入口统一存档重包

本轮统一设置重开引导与首次进入：重置身份进度和完成标记，从身份选择、第一步开始；原项目及素材保留，暂停后继续仍恢复当前步骤，不再显示回看提示。同时存档本地分类 Mac 运行时、微信登录回流及固定 DMG 安装布局。

验证：引导契约 **14/14**、三身份引导及本地分类两组 Chrome 合成 IPC 界面回归、TypeScript/Vite 通过；Rust 全量首次 **362 passed / 1 failed / 2 ignored**，唯一失败为沙箱禁止测试绑定本机端口，放行后该项 **1/1** 通过，合计 **363 passed / 2 ignored**。未执行真实 OAuth、真实用户库操作或 Apple Silicon 验收；保留既有编译警告。

产物：`macOS/dist/Bowerbird_26.9.17_x64-onboarding-installer.dmg`，**86,320,119 bytes**，SHA-256 `5e3af307002edc5ef49a9aa0a86e4ecacc5f48b1d1256fc3013a1f4401d6dcc5`；同目录附 `.sha256`，旧包保留。release 构建、67 个包内资源逐文件匹配、413 个构建输入指纹、26.9.17 版本/x86_64 架构/协议注册核验通过。DMG 脚本已检查应用逐文件一致性、Applications 目标、背景和布局文件，镜像完整性通过。

构建与测试证据保存在 `macOS/dist/verification/archive-20260917-onboarding/`。本轮只交付本地 Intel 未签名/未公证测试包，不推送或部署服务端，不替换 `/Applications` 中现有应用。

## 2026-09-17 微信登录回流修复

安装布局补包：上一份基础 `hdiutil` 镜像遗漏 Applications 快捷方式及安装提示。现提供 `macOS/dist/Bowerbird_26.9.17_x64-wechat-fix-installer.dmg`（86,320,030 bytes；SHA-256 `fa3ed530dafe4ada9eb2dcfb881885ba9e094c0939d3ca57788c1b1cb58fe304`），应用与上一份修复版逐文件一致，增加 `/Applications` 快捷方式、左右图标布局和中文拖动提示背景。HFS+ 镜像完整性、重新挂载后的图标位置与大小、快捷方式及应用内容检查通过；当前环境不能截图，Finder 背景属性读取失败，因此未将背景实际显示标记为视觉验收通过。`tauri.macos.conf.json` 已配置相同背景与布局；标准打包不可用时可运行 `bash macOS/installer/package-dmg.sh <已构建.app> <新输出.dmg>`，脚本需访问磁盘镜像服务与 Finder，拒绝覆盖已有输出。

主事件循环补接 macOS `RunEvent::Opened`，将系统投递的微信/邮箱登录链接交给既有 Rust 账号处理。此前仅处理启动参数与 single-instance 回调，Mac 扫码后无法进入验证。回调 state 校验、服务端换码、Keychain 持久化和前端通知沿用现有实现。

登录专项 Rust **19/19** 通过，包含 Opened 批量 URL/编码参数保留、非 URL 事件忽略及现有微信/邮箱安全校验。真实微信扫码仍需安装修复版后重新发起验证；测试未读写真实账号或素材库。证据保存在本地 `macOS/dist/verification/wechat-login-20260917/`。

TypeScript/Vite 与 Rust release 构建通过。Tauri DMG 脚本在沙箱中失败后，使用系统 `hdiutil` 从完整 `.app` 目录生成独立未签名 Intel 包 `macOS/dist/Bowerbird_26.9.17_x64-wechat-fix.dmg`（88,339,538 bytes；SHA-256 `5096cfb322990dcdf00d2c7dc3afd27e5b76b42cfb7ce1c2f66ec54d978f39e3`）。完整性校验、只读挂载后应用逐文件对比、x86_64 架构及 `bowerbird` 协议注册检查通过。原 26.9.17 DMG 保留；未替换 `/Applications` 中的应用，未执行真实 OAuth。

## 2026-09-17 同步 dev 26.9.17

本地 `dev` 已经 7890 代理快进到远端 `8bef9d2`；`mac` 合入该版本，保留 WKWebView 原生取图、系统标题栏、Finder CLI 路径探测和 FFmpeg 适配。新版画板交互、0030 素材库可见性与 v0917 引导资源均已同步；引导保持先画布提示、后完成/登录弹窗，维度环或滑出侧栏出现时原生网页临时隐藏。

本次在 Intel Mac 验证：Rust **361 passed / 2 ignored**（无过滤）、前端契约 **151/151**、**14 组 Chrome 合成 IPC 界面回归**、TypeScript/Vite 和 release 构建通过。界面覆盖引导流程/完整快照、双平台标题栏、探索/侧栏、素材库隐藏与恢复、建组/展开、层级、分区缩放、吸附、透明图、创作框及本地分类。真实 WKWebView 取图夹具通过 Cookie/跨域/重定向/分块/错误/超时清理及页面状态保持；真实 Tauri/AppKit 隐藏窗口验证三个标准按钮与主题切换通过。保留已有 Rust 警告和 Vite 大 chunk 提示。

- Intel x86_64 测试包：`macOS/dist/Bowerbird_26.9.17_x64.dmg`，**86,325,439 bytes**；未经 Developer ID 签名/公证。
- SHA-256：`25b1a2a3674153a8f388f4f2ab8933e4b98a94f1d7d3502a9a31a8da15d613fc`，同目录附 `.sha256`；`hdiutil verify` 通过，旧 26.9.15 DMG 保留。
- 应用：`apps/desktop/src-tauri/target/release/bundle/macos/Bowerbird.app`；版本、架构、原生取图桥接、Mac 主题权限、**67 个资源文件**（含 43 个 v0917 文件）及 **418 个构建输入指纹**核对通过。
- 证据：本地 `macOS/dist/verification/sync-dev-20260917/`，包含测试/构建日志、引导截图、源码指纹和产物校验。

合并前七个文件的本地分类适配修改已完整恢复，继续保持未提交，并保留 stash 备份；本次应用按恢复后的工作区构建，因此包含这组适配。该功能的真实模型分类质量仍有已记录的误判，不能将安装/推理和界面回归通过视作准确率验收；详见 `dev-doc/LOCAL-CLASSIFICATION.md`。未操作真实素材库/账号或付费生成，未推送分支或部署服务；完整应用中的真实站点拖放、全屏空间切换及 Apple Silicon 构建未在本轮验收。

## 2026-09-15 原生 Mac 标题栏

Mac 使用系统原生标题栏：左上角红色关闭、黄色最小化、绿色缩放/全屏，标题由系统居中显示，悬停和失焦外观交给 AppKit。现有 `applyTheme` 同步 Tauri 应用主题；`capabilities/macos-titlebar.json` 仅为 Mac 的 main WebView 授予 `core:app:allow-set-app-theme`，原生标题栏跟随应用浅色/深色设置。前端 Mac 不再渲染自绘标题栏，因此没有右侧重复按钮或多余空白；Windows 保持原来的自绘标题栏。

`tauri.macos.conf.json` 仅覆盖主窗口配置，尺寸、最小尺寸和网页拖放设置与公共配置一致；使用 `decorations: true` 与 `titleBarStyle: Visible`。原生标题栏位于网页内容之外，加载或应用弹窗不会挡住按钮。配置机制见 [Tauri 平台配置](https://v2.tauri.app/reference/config/)。

验证命令：在桌面目录运行 `node scripts/window-titlebar-ui.test.mjs`；原生隔离验证运行 `cargo run --offline --manifest-path src-tauri/Cargo.toml --example mac_titlebar_smoke`。后者仅创建隐藏的非持久窗口，核验三个 AppKit 标准按钮存在、未隐藏、启用以及原生装饰与主题，不运行生产初始化或读取用户素材库。

本次通过 Windows/Mac Chrome 合成 IPC 标题栏回归（含 900px 布局、无重复控件/空白、主题同步）、TypeScript/Vite 构建，以及上述真实 Tauri/AppKit 隐藏窗口验证。证据保存在本地 `macOS/dist/verification/native-titlebar/`；未操作生产窗口或用户数据，未自动演练真实窗口的全屏空间切换。

## 2026-09-15 引导遮挡与结束顺序修复

维度环出现时暂时隐藏原生网页，关闭维度环后恢复同一网页，避免第九步「反推提示词」被 WKWebView 覆盖。设计师第十步先显示全画布提示，第十一步才显示最终完成/微信登录弹窗；全画布提示使用「下一步」，只在最终弹窗完成一次。旧会话迁移保留项目及已完成状态。

14 项进度契约、三身份 Chrome 合成 IPC 界面回归与 TypeScript/Vite 构建通过，截图及日志位于本地 `macOS/dist/verification/onboarding-order/`。此轮未执行真实站点、账号或用户素材库操作。

## 2026-09-15 内置浏览器采集修复

Mac 取图此前直接进入“不支持”分支。现在通过当前 WKWebView 的原生 WKDownload 获取图片，沿用浏览器登录态，复用现有去重、来源记录与目标项目入库流程。需要 macOS 11.3+，单图上限 50 MiB、超时 45 秒，采集不刷新原网页。

隔离原生测试使用真实 WKWebView 与生产桥接，验证带 HttpOnly Cookie 的跨域图片、重定向、分块响应、HTTP/HTML/大小/断网/超时错误、临时文件清理与网页状态保持；Rust 浏览器相关 7 项、前端探索契约 7 项及 TypeScript/Vite 构建通过。命令及验收边界见 `dev-doc/EMBEDDED-BROWSER.md`。未操作真实站点账号或生产素材库，物理拖放仍需使用新版实机确认。

构建接缝：Tauri 的较低部署目标会让 Objective-C `@available` 生成 Clang 运行库调用，而 Rust 的 `-nodefaultlibs` 不会自动补入该库。`build.rs` 从实际编译器查询并链接 `libclang_rt.osx.a`；独立 Rust/Objective-C 链接及回调验证通过。

## 2026-09-15 同步

`mac` 从远端 `0fcde4d` 合入 `dev` 的 `01e8372`（26.9.15），包含项目画板、编辑工具、生成恢复、视觉规范与随包引导项目。保留 Finder 启动时的 Homebrew/用户 bin 探测和子进程 PATH；Codex 调用及终端会话回看统一使用 Bowerbird 私有 `cli-profiles/codex`。终端命令通过 AppleScript 参数传递，路径、参数和环境变量逐项进行 shell 转义；同时修复即梦登录入口的 macOS 条件编译错误。

视频工具使用同一绝对路径解析器，Mac 额外探测 `/opt/homebrew/bin`、`/usr/local/bin` 与 `~/.local/bin` 下的 FFmpeg/ffprobe，不修改系统 PATH。

前后端同时识别 `/var/folders/.../T/` 与 `/private/var/folders/.../T/` 中的采集临时来源，禁止把它们作为“移出园丁鸟”的恢复位置；普通用户文件夹仍可恢复。

本次自动化验证：

- Rust 库测试：353 passed / 2 ignored，无过滤；其中真实视频测试另行运行并通过，余下本地分类模型测试未执行。
- 真实视频测试将子进程 PATH 限制为 `/usr/bin:/bin`，清除 FFmpeg 路径覆盖，通过公共解析器找到本机工具，验证临时视频入库、时长/尺寸与 JPEG 海报。
- 画板/生成恢复/引导/探索/路由 136 项、资产移出规则 4 项通过。
- 标题栏与随包引导项目两组 Chrome 合成 IPC 界面回归通过；截图位于本地 `macOS/dist/verification/`。
- TypeScript/Vite production build 通过；保留 dev 既有 Rust 警告与 Vite 大 chunk 提示。

本次交付为 **Intel x86_64**（本机 Node 26.4.0、Rust 1.96.0），不是 arm64/Universal 构建：

- 应用：`apps/desktop/src-tauri/target/release/bundle/macos/Bowerbird.app`。
- 未经 Developer ID 签名/公证的测试包：`macOS/dist/Bowerbird_26.9.15_x64.dmg`，74,555,790 bytes。
- SHA-256：`efa87f439b5f6b2f354776e7a4a04ae855404f044471aa44bf7463e42cce948c`；同目录附 `.sha256`，`hdiutil verify` 完整性检查通过。
- 本次原生标题栏重包已核对版本、Mach-O 架构、原生取图桥接保留、Mac 主窗口主题权限、49 个包内资源文件与 233 个构建源码/配置文件指纹；结果见本地 `macOS/dist/verification/native-titlebar/`。此前引导和取图验证分别见 `onboarding-order/`、`browser-capture/`，同步验证（包含公开 Cloud 配置构建注入）见父目录记录。上一个引导修复包备份在 `macOS/dist/archive/20260915-before-native-titlebar/`，更早的包仍保留。

平台边界：

- 本地分类源码已于 2026-09-16 支持 macOS 13.3+（Intel / Apple Silicon），尚未纳入此处 26.9.15 安装包；固定包及验证边界见 `dev-doc/LOCAL-CLASSIFICATION.md`。原生 Adobe Illustrator AI 导出仍限 Windows，Mac 可用图片导入与 PSD 导出。
- Dreamina 在 Mac 上沿用官方 CLI 的凭据存储；Windows 注册表隔离与 NSIS 安装清登录钩子不适用于 Mac，不能宣称 Mac Dreamina 凭据已隔离。
- 本次不改写真实素材库，不执行付费生成或真实 OAuth。Chrome 合成 IPC 回归不等同于 WKWebView/Finder 真机验收。

> **codex CLI 隐形**：首启若 codex 未就绪，引导页可在 app 内一键安装（优先免 Node 直装独立版，直装失败且本机有 npm 时回退 `npm install -g @openai/codex`，进度流式）+ 一键 OAuth 登录（`codex login` 自动开浏览器），用户全程不碰终端。macOS 上 npm/codex 检测除当前 PATH 外还会查 `/opt/homebrew/bin`、`/usr/local/bin` 与用户 bin，Finder 双击启动 `.app` 也能找到。

> **浏览器扩展随包内嵌 + 心跳状态 + 通用网页采集**：release 构建会把 `apps/extension/` 内嵌进 `.app`（`extension/` 资源），首启引导复制路径让你粘到 Chrome「加载已解压扩展」加载；扩展每 15s 心跳，app 据此显示连接状态（30s 无心跳自动判离线）。通用网页采集由扩展 background 在浏览器登录态/系统代理环境内读取图片字节、经 `save_blob` 上传，桌面端免二次下载（Pinterest 等需登录站必需）；小红书等公开图床仍走 `save_batch`。
~~~~


## macOS 原发布脚本与钥匙串交接

~~~~markdown
## 一键发布到现役火山 TOS 和 CDN

`macOS/release.sh` 把发布串成一条命令（协议见 [DESKTOP-UPDATES.md](../dev-doc/DESKTOP-UPDATES.md)）：

```bash
bash macOS/release.sh <release-notes.txt>            # 完整：护栏→签名构建→归档校验→版本清单→上传→公网核对
BOWERBIRD_MAC_CHANNEL=local COS_SKIP_BUILD=1 COS_SKIP_UPLOAD=1 bash macOS/release.sh   # 本地测试渠道，复用产物
```

脚本在构建前及上传前读取指定架构的官网清单。网络故障、清单错误、同版及降版都停止。首次启用全新通道须单独确认初始权威基线，两个现役 Mac 通道均已有基线。正式构建通过公证后冻结六个文件。上传按版本命名，逐件使用 TOS 服务端禁止覆盖的 PUT，并从源站读回完整字节核对 SHA-256。已有同名文件仅可在哈希相同的情况下复用。最后一个对象为 `darwin-<arch>-<version>.json`，随后从 CDN 完整读取更新归档与 DMG，比对两份 SHA-256。官网切换前另行完成签名与实机验收。

一次性准备：

1. 在发布用 Python 虚拟环境执行 `python3 -m pip install tos==2.9.3`。桶必须从未开启版本控制。发布凭据需要读取桶版本状态、读取对象及发布对象的权限。开启或暂停版本控制、或无法判定时，脚本都会在第一件上传前停止。见火山引擎 [PutObject](https://docs.volcengine.com/docs/torch-object-storage/put-object) 和 [GetBucketVersioning](https://docs.volcengine.com/docs/torch-object-storage/get-bucket-versioning)。
2. 沿用根目录私有 `.env.tos` 或发布机环境中的 TOS_ACCESS_KEY_ID、TOS_SECRET_ACCESS_KEY、TOS_BUCKET、TOS_REGION、TOS_ENDPOINT。CDN 默认 `https://cdn.bowerbird.cn`。
3. 更新器私钥沿用 `macOS/.signing/updater.key`。

上传中断时，保留原冻结目录，使用同一 TOS 配置执行 `python3 macOS/upload_immutable.py upload <arch> <version> <冻结目录>`。它会重验线上版本、本地文件和已存在对象，再补齐缺件。渠道由官网发布侧核验后原子切换。离线 SDK 演练命令为 `python3 macOS/test_upload_immutable.py`。

2026-11-11 在 Windows 上通过实际 TOS Python SDK 2.9.3 和隔离 HTTP 传输演练并发抢占、同内容续传、既存签名/镜像保护、版本状态异常及官网基线失败。对现役桶只读查询版本状态返回 HTTP 403 AccessDenied，这套本机凭据仍需取得该桶的只读版本状态权限，或用已有此权限的发布身份完成检查。两条已发布 Mac 渠道均从 `cdn.bowerbird.cn` 取包。Developer ID、公证、安装及升级结果须在对应 Mac 上补齐。[离线 SDK 演练](../.tmp/release-gates-20261111/tos-sdk.log) · [双架构脚本夹具](../.tmp/release-gates-20261111/mac-script.log)。

## 钥匙串授权弹窗与本地稳定签名（2026-09-25 更正）

**当前结论：稳定自签名不足以解决跨构建授权。** 9 月 25 日 securityd 日志确认用户已多次点“始终允许”，但下一次构建仍出现 `ACL partition mismatch: client cdhash:…`。macOS 除 designated requirement 外，还校验钥匙串 partition；本地自签名没有 Apple 验证的 Team ID，分区按 CDHash 划分。两份同证书、同标识程序的真实钥匙串隔离实验已复现第二份读取失败（`-25293`）。下文 9 月 20/24 日措施只稳定了签名身份，不能作为“根治”证据；发布包同样不能靠自签名承诺跨版本免授权。

**开发版当前修复：** `macOS/run-signed.sh` 在桌面可执行文件旁准备 `bowerbird-dev-keychain`，只在辅助程序源码、证书或架构变化时重建；业务代码重编译保留它的字节与 CDHash。macOS debug 构建通过 `cloud/dev_keychain.rs` 调用该程序，release/其他平台继续使用原生 keyring 后端。辅助程序只操作既有 `com.bowerbird.desktop` / `supabase-refresh-token` 条目，通过 Security API 校验实时父进程必须为同证书签名的 Bowerbird；桌面发送 token 前也核验辅助程序签名与标识。token 仅走匿名管道和系统钥匙串，不进入 argv、环境变量或文件；辅助程序失败不会回退到反复触发授权的直接访问。旧条目首次改由辅助程序访问可能需一次“始终允许”，以后普通业务重编译不改变此授权主体；辅助程序本身更新、证书变化或钥匙串策略变化仍可能再次要求授权。

验证：`bash macOS/test-dev-keychain.sh` 使用实际 Rust 凭据后端与辅助程序、随机测试条目和假 token，禁用所有系统授权交互，两次不同 CDHash 的主程序之间读取、轮换写回、删除/不存在映射通过；未授权父进程和被替换的辅助程序均拒绝。`bash macOS/test-dev-signing.sh` 验证 Cargo 启动、参数、测试透传与两次主程序重编译后辅助程序哈希不变。测试不读取真实登录 token。首次旧条目授权与实际开发应用体验仍需用户侧确认。

**现象**：使用应用时系统反复弹「bowerbird-desktop 想要使用你储存在钥匙串中的 com.bowerbird.desktop 中的机密信息」，输密码后还会再弹 2-3 次。

**根因**：登录 refresh token 存在钥匙串（`cloud/auth.rs`，keyring 服务名 `com.bowerbird.desktop`）。钥匙串条目的“始终允许”按**签名身份**记录信任；此前包是 ad-hoc 签名，每次发版二进制指纹（CDHash）都变，信任每次更新即失效。且 token 每小时轮换，一次刷新 = 读 + 写回共两次钥匙串操作，未受信时各弹一次。

**修复（三层）**：

1. `cloud/auth.rs`：内存缓存最近一次 refresh token，缓存命中时不再读钥匙串（轮换后的写回保留，否则旧 token 失效会掉登录态）。
2. `macOS/setup-codesign-cert.sh`：一次性生成自签名 codeSigning 证书 `Bowerbird Local Code Signing`（10 年有效期，保存在 Git 忽略的 `macOS/.signing/codesign.crt` / `codesign.key`）并导入 login 钥匙串。已在本机完成导入；证书/私钥请像 `updater.key` 一样保管，换机构建机需带走这两个文件并重跑脚本。
3. `macOS/release.sh`：检测到该身份时导出 `APPLE_SIGNING_IDENTITY`，Tauri 自动以它签名 `.app`（与 DMG），签名身份跨版本稳定。同时 `tauri.macos.conf.json` 显式设 `hardenedRuntime: false`——Tauri 默认 true，但 hardened runtime 会让无 Apple Events 授权的 AppleScript（Dreamina 登录拉 Terminal）被系统拒绝；本地自签名不做公证，无需 hardened runtime。

**开发版遗漏补齐（2026-09-24）**：上述 9 月 20 日签名仅接入 `release.sh`，`pnpm tauri dev` / `cargo run` 仍运行 linker ad-hoc 签名的二进制，每次 Rust 重编译后 CDHash 和默认标识变化，内存 token 缓存也随重启清空，所以开发期间仍反复授权。仓库 `.cargo/config.toml` 现为 macOS 配置 `macOS/run-signed.sh`：Cargo 每次运行桌面二进制前，用已有证书与固定 `com.bowerbird.desktop` 标识签名并验证，再 `exec` 原程序、原样传参；证书缺失或签名失败直接报错，不降级临时签名。测试/示例程序直接运行，Windows/Linux 不受影响。`cargo build` 后手工直接执行二进制会绕过 runner，开发启动应使用上述两种入口。现有进程需下次重启才生效。

隔离回归：`bash macOS/test-dev-signing.sh`（需本机已有证书），两次构建不同内容的小程序，分别从仓库根目录与 `src-tauri` 启动，验证 CDHash 不同但 designated requirement 完全一致、签名有效、带空格参数与普通 Cargo 测试通过；不访问真实登录 token/素材库。系统钥匙串弹窗仍需开发版首次切换后实机确认。

**用户侧效果（以 9 月 25 日修复为准）**：开发版首次出现 `bowerbird-dev-keychain` 访问旧条目的提示时，可能需输入密码并点一次**「始终允许」**。只有辅助程序保持不变时，业务代码重编译才不再更换钥匙串分区；单纯保持自签名证书和应用标识一致并不足够。

**边界与坑**：本地自签名只稳定代码签名 requirement，不能稳定钥匙串 CDHash 分区，也不等于 Developer ID 签名/公证；Gatekeeper 首次打开仍需右键打开。updater 完整性仍由 minisign 签名保证，与代码签名互不影响。首次用该身份签名（或跑 setup 脚本试签）时系统可能弹「codesign 想要使用私钥」，点“始终允许”一次即可。macOS 自带 LibreSSL 生成的 pkcs12 会被 `security import` 报 MAC 校验失败，脚本因此直接导入 PEM 私钥与证书；自签名证书不出现在 `security find-identity -v` 输出属正常，脚本用试签验证。
~~~~
