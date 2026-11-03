# 快传实际反馈：地址、持续接收与配对边界复核

本轮最初为独立只读诊断，不读取真实素材库、不修改用户网卡或防火墙。随后根代理明确授权只实现 `src-tauri/src/quick_transfer/addresses.rs` 及同文件测试；其他功能、桥接和提交由根负责。

## 实测网络证据

- WLAN：`192.168.1.5/24`，网络类型 Public，IPv4 Internet；默认路由 `0.0.0.0/0` 经 WLAN 的 `192.168.1.1`，RouteMetric 0 / InterfaceMetric 35。
- WSL Hyper-V 虚拟网卡：`172.28.192.1/20`，InterfaceMetric 5000。Tailscale：`100.101.9.106/32`；其地址不属于 Rust `is_private()` 范围。其他断开的以太网/虚拟适配器只有 `169.254.*` 地址。
- 原代码对私网 IPv4 数值排序、客户端首选第一项，确定会把 WSL 地址置于 WLAN 之前。网页代理随后独立观察到 PID 55760 的 debug 客户端监听 `172.28.192.1:51172`；根代理记录用户确认所扫地址一致。因此错误网卡是已定位缺陷，不归因于未经验证的手机脚本或防火墙。
- 已有两条 Bowerbird 入站 Allow 规则分别对应 TCP/UDP，路径为 `apps/desktop/src-tauri/target/debug/bowerbird-desktop.exe`，Private/Public 均适用，端口和远端为 Any；不因 WLAN 为 Public 就断言被防火墙拦截。该证据不证明同网段手机请求实际穿透，也不覆盖路由器客户端隔离。
- 本子代理两次进程/端口快照恰无 Bowerbird 实例，不能据此前台状态推断客户端从未运行；上述实时监听证据来自网页代理的独立时点。本轮未重启客户端或修改防火墙。

## 地址推荐实现与红绿

复用现有 `if-addrs@0.15.0` 的接口名称、运行状态和点对点标记，不增加依赖，不在产品运行时调用 PowerShell。

使用 `UdpSocket::bind` + 数字地址 `connect` + `local_addr` 查询系统选路源 IPv4。没有 `send/recv`、DNS 或对互联网回复的依赖。候选只保留运行中的私网 IPv4；普通网卡优先，普通默认选路地址排首；已知虚拟/VPN 名称和点对点接口降级但保留手选，稳定去重。路由查询失败仍可从现有地址选取。

API 语义依据：[Rust 标准库 UdpSocket 文档](https://doc.rust-lang.org/std/net/struct.UdpSocket.html#method.connect)；网卡字段以本机锁定的 if-addrs 0.15.0 源码核对。

- 先用旧数字排序运行同文件 5 项测试，观察到 4 失败 / 1 通过：WLAN/WSL、两个普通网卡默认路由、VPN 默认路由、无路由 fallback 均复现错误。
- 修改排序后 5 项通过，另覆盖 Down/public/link-local/loopback/CGNAT 排除、重复地址和空列表。隔离 harness 在 `apps/desktop/.tmp/quick-transfer-address-review/`，只编译此生产模块和现有 if-addrs，不抢大 crate 的锁。
- 真实本机隔离探针结果：`[192.168.1.5, 172.28.192.1]`，WLAN 首选、WSL 仍保留。rustfmt 已完成。
- 名称只用于推荐，不能准确识别所有重命名的 VPN 或复杂策略路由；未知自定义虚拟适配器仍可能需手选。Mac/Linux 原生未实测，不声称手机端或所有网络已验收。

## 持续接收边界（本轮不擅自改动）

- 单次开启累计最多 500 文件 / 10 GiB，prepare 接受即占用，失败/取消不退还；只有关闭再开启重置。它是累计接收额度，不是并发额度。长期开启耗尽后继续拒收，不能宣传无限持续接收。
- `session_stops` 的批次取消 sender 在批次结束时未移除，直到 stop 才释放。500 文件上限约束单次会话内增长；若以后取消累计上限，应同步回收已结束批次。
- Indexed 收据 JSON 长期留存；再次打开目录会全部读取。它保护同上传 ID 的幂等身份，但跨多次开启的收据与内存会增长，没有时间/数量裁剪。本轮不删除回执或用户文件。
- 每条文件入库后沿现有连接扫描路径刷新目录；大量历史文件的目录可能增加索引时间。性能边界须按真实素材规模另测，不凭小样本声称可长期满负载运行。

## 无摄像头配对与安全边界

原始短地址不含 PIN 时返回带 401 状态的静态页面，手机脚本把缺 PIN 视为失效；只复制 `IP:port` 不足以鉴权。根本轮决定展示 8 位随机会话码，手工输入一次校验；二维码继续含完整会话 PIN，免手输。最终网页实现与实际红绿由网页代理记录。

现有 Host 严格限定绑定 `IP:port`、有 Origin 时必须同源，上传准备与取消要求 PIN，实际文件传输仍使用服务端返回的 session/file token；不能为手输地址入口关闭这些限制。HTTP 不加密，配对码是访问控制。

现有每 IP 三次错误后 429 没有时间窗；即使随后输入正确码也需电脑重开或等待 LRU 淘汰。短码更易出现误输，已明确告知根与网页代理，页面需停止自动验证并说明电脑重开，不能持续探测把用户锁住。根选择保留该限制，本轮没有擅自放宽。

## 官方质量工具与实际排序变异

沿用 `.tmp/ub-tools/` 已安装的官方 crapper/dryer/mutator，没有替换工具。冻结桌面与地址的首轮快照位于 `.tmp/quick-transfer-followup-review/quality-desktop/`：crapper `--no-coverage`、dryer `--threshold 0.8`、mutator `--scan --no-coverage` 全部实际执行且 exit 0。`QuickTransfer` CC 12、`QuickTransferNetwork` CC 14，其余桌面最大 8；地址 `route_source` 6、`order_addresses` 4、`is_virtual` 3。无重复候选。覆盖率与 CRAP 均 N/A，扫描候选数不计作实际变异执行。

`.tmp/quick-transfer-followup-review/run-address-mutation.py` 复制真实生产地址模块（含原 5 项行为测试）到独立 Cargo harness，以官方 `sites_in_file` 生成候选、`CommandRunner` 和 `_execute` 执行与恢复：

- 基线 5 项通过。
- 官方排序候选 `Some(*ip) != route` 改为 `==` 被“两普通网卡应选默认路由”断言杀死（4 通过 / 1 失败）。
- 补充语义变异 `*virtual_adapter` 改为 `!*virtual_adapter`，同官方引擎执行，被 WLAN/WSL、VPN 和离线 fallback 的三个断言杀死（2 通过 / 3 失败）；单独标注为补充，不计入官方候选评分。
- 两次均成功编译，失败来自排序行为断言，不把基础设施错误算 killed。正式源码 SHA256 `3f659e3c8226494e00d5b6a3789327da2e7cd678d83dc303fa0b499067eb71d5` 未改变，隔离副本已恢复。结果与每次输出保留在 `address-mutation/result.json`、`run-1/2/3.log`。
- 首次普通沙箱运行因官方 Rust grammar manifest 访问被拒而中止；在允许的相同隔离验证环境重跑成功，不将首次环境异常计为变异结果。

最终冻结全部本轮范围后复扫 16 个生产源文件（含手机 HTML 唯一脚本、默认目录命令、迁移侧写及 vendor 接收边界）：三项官方工具均 exit 0，哈希核对 0 mismatch；dryer 0.8 无重复，mutator 扫描 553 候选，实际仍仅执行上述 2 个排序变异。报告：`.tmp/quick-transfer-followup-review/quality-final/REPORT.md`。

最终关键指标：默认目录 `prepare_receive_directory` CC 9；8 位码校验 CC 5；手机配对 `pairComputer` / `pairingResponse` / `showPairing` 为 4 / 4 / 1，整个手机脚本最大 8。桌面两处展示函数仍为 14 / 12，其余最大 8。迁移/vendor 整文件包含原有高复杂度代码；用同一官方 crapper 对 HEAD 核验，`rewrite_sidecars` 9 → 10、`handle_request_inner` 32 → 33，各对应一个真实新分支，既有 `resume` 62 未变化。未把这些既有函数夹带重构，也未声称所有 CC 或 CRAP 达标。
