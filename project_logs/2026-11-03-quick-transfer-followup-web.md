# 快传网页与局域网接入跟进（2026-11-03）

范围：用户反馈手机扫码持续加载/空白。按 ub-mode 先核查实际监听和网页，再建立红测；不更改防火墙，不访问用户资料库、不提交。

1. 读取当前 transport、手机 HTML、测试及上轮记录。仅 loopback 浏览器测试不足以证明真实手机可达，不将 UA 模拟称为真机验收。
2. 只读本机实际网络证据：当前 bowerbird-desktop（PID 55760，target/debug 可执行文件）的快传监听为 `172.28.192.1:51172`；该地址属于 WSL Hyper-V 虚拟网卡，没有默认网关。真实 WLAN 地址 `192.168.1.5`，唯一 IPv4 默认路由经 WLAN 到 `192.168.1.1`。现有私有 IPv4 数字排序会把 WSL 放在 WLAN 前，前端默认首项，因此定位到错误默认网卡这一具体缺陷；尚不能据此宣称已捕获手机的失败请求或已完成真机修复。
3. WLAN 为 Public，但现有两条 Bowerbird 入站 Allow 对应实际 target/debug 程序，TCP/UDP Any，涵盖 Private/Public。没有修改规则；这些证据也不能排除路由器隔离或其他过滤规则。不把 Public 标签当作阻断根因。
4. 根任务分工：另一 agent 处理默认路由网卡推荐，根处理桌面选择/默认目录/runtime。根批准短地址与随机 8 位配对码：我负责兼容 8 位纯数字或旧 32–128 字符 token，未提供 PIN 的根网页仅显示配对表单；准备/上传/取消继续鉴权。手输表单单字段可粘贴，不自动尝试，429 明确提示电脑重新开启。
5. 实际红测：`accepts_eight_digit_pairing_codes_and_rejects_other_short_secrets` 因旧最短 32 位限制失败；短地址 GET / 测试因原 401 不符新 200 配对入口失败；真实 Chrome 因缺少 `#pairing-code` 超时。随后添加纯 secret 校验，8 位必须全为 ASCII 数字，仍接受旧长 token；空/7位/9位/字母/全角/空格 secret 均拒绝。
6. 正式手机页加入单字段配对码表单，保留前导零并接受分组空格粘贴；使用现有 GET /?pin 验证，成功才导航带 PIN 的上传页。缺少 PIN 的 GET / 仅返回无凭据的静态入口，不改变 prepare/upload/cancel 权限。显式错误或空 PIN 仍为失效态。表单不运行自动探测，401 原地核对，429 禁用输入/连接并提示电脑重开。原有 3 次错误/IP 直到会话重启的限制保留，未擅改安全策略。
7. 拓展隔离 harness：可由 BOWERBIRD_TEST_BIND_IP 选择实际本机私网地址，同时编译正式 addresses 模块。2026-11-03 绑定 WLAN `192.168.1.5`，最终 **18/18 通过**（5 地址、12 传输、1 Chrome 入口含 13 组行为）。包含真实 3 次错误后连正确码也 429、无 PIN 配对页不授予上传权、前导零/分组粘贴、手动错误/成功、429 无自动探测、原有所有传输/取消/断网/丢失回执/旧码回归。page errors 0、外网请求 0。
8. Safari 与微信 iPhone UA/触屏窄视口均在真实 WLAN listener 完成网页读取与上传；HTTP Content-Type=`text/html; charset=utf-8`，no-store、no-referrer、X-Frame-Options=DENY、同源 CSP 均符合契约。没有发现 UA 导致脚本/页面空白的证据。引擎仍是 Chromium，不将其称作真实 Safari/WebKit 或另一台手机的入站验证。
9. 实际查看 `apps/desktop/.tmp/quick-transfer-mobile/pairing-390.png`；单输入框/连接操作符合既有深色稿。报告同目录 report.json；旧报告生成器的“loopback”固定描述已改为实测 hostname，当前报告也仅更正这一范围元数据，未更改测试结果。
10. 生产 HTML/transport/vendor 源码冻结后通知 integration_audit 跑统一主 crate，通知 browser_constraints 做官方质量扫描；父任务负责整体存档与用户真机接续。未修改防火墙或当前用户运行实例，不保证手机此前页面会自行切换地址；需关闭旧接收后用新推荐地址开启。

仍需用户设备验收：同一 Wi-Fi 的手机扫码、微信/系统浏览器实际引擎与本地网络权限、路由器设备隔离及入站过滤。已有证据能确认错误默认网卡并验证修正后的本机 LAN 服务，不能声称已验证全部跨设备路径。
