# LocalSend 局域网快传

当前产品决策统一见 [PROJECT.md](../PROJECT.md)。2026-11-03 用户选择 LocalSend，并确认桌面／手机示意可以接入；手机扫码打开浏览器，无需安装 App。本轮正式界面源码与验证见 [接入记录](../project_logs/2026-11-03-quick-transfer-ui-integration.md)，不代表已安装客户端或公开包具备此功能。

## 接收契约

- 桌面显式开启会话，默认由 `FileWorkspace` 当前根解析 `BowerbirdLibrary/快传`；只读展示不建目录，开启时才创建，尊重已迁移根、离线不回退，拒绝同名普通文件或指向外部的链接。无需选择收件目录；应用启动不监听局域网，不复用浏览器扩展的 loopback 服务。
- 本机私有IPv4优先推荐正常联网网卡，默认路由帮助选择，虚拟／VPN网卡降级但保留备选；UDP connect仅查询OS选路，不发送包或依赖外网响应。用户本机WLAN为192.168.1.5，旧排序默认选WSL 172.28.192.1造成手机扫码空白；本轮真实监听与用户扫码地址已交叉确认。自定义未知VPN名称等仍可能需要手动选择。
- LocalSend v1.18.2，固定上游 `af0416be50770a97760f7070684bc667b759a15c`，Apache-2.0。核心源码随仓库固定，使用 Rust `http` 能力；不打包 Flutter、不调用公网信令/中继。
- 网页与接口同源，静态资源由本机提供；本次会话随机8位数字配对码进入二维码，关闭后轮换。电脑可手输短地址，在页面填写配对码；复制完整链接仍可免输入。无配对码根页面只展示配对表单，不授予上传权限。现有LocalSend限制每IP三次错误，之后返回429直至本次接收重开；不添加云中继、账号或额外发现服务。限定 Host/Origin，关闭下载/目录浏览/其他协议入口；本机IPC独立控制开启、状态、重试入库和停止。
- 带配对码的根上传网页校验当前会话；手机在前台每10秒和恢复可见时探测原同源页面，配对表单不循环探测。离线提示重新连接，旧码失效提示重新扫码，429明确提示重开接收。关闭页面尝试取消当前批次，但后台／系统中断不保证通知送达，最终仍由服务端超时回收。
- HTTP 网页模式不加密；仅用于可信局域网。二维码令牌是访问控制。没有断点续传，手机须保持页面前台；中断后重新发送。
- 单活跃 LocalSend 批次，最多100个文件；单文件2 GiB，每次开启最多500文件/10 GiB，额度按prepare占用、失败不返还，到达后需关闭再开启。无空闲会话自动关闭；等待继续和流式接收有闲置超时。停止等待写入句柄关闭和监听释放，不把仍在写入的文件当成取消完成。应用退出、休眠或网络切换会影响接收。当前每个上传的持久JSON收据会保留，重开会读取历史收据；不承诺无限历史的恒定资源占用。

## 文件与状态

原件按 `Receiving → Ready → Saved → Indexed` 持久化：

1. 生成独立上传ID，校验文件名/类型/声明长度；manifest和暂存在收件目录 `.bowerbird-quick-transfer` 下，连接扫描跳过此区域。
2. 流式写入、长度/可选发送方哈希检查、刷盘关闭句柄；接收方再验证媒体内容与SHA-256，将Ready记录原子保存。只有这一事实持久化后，网络请求才可返回成功。
3. 无覆盖发布到收件目录，保存Saved记录，再沿现有连接式素材索引登记，成功保存Asset ID。窗口切换不改变目标目录。
4. 入库失败保留已收到文件，可重试登记；重启后再次在原目录开启接收，恢复Ready/Saved记录。BowerbirdLibrary迁移对`.bowerbird-quick-transfer`中的JSON绝对路径沿现有规则重写，已确认收件随新根恢复；迁移仍在下次启动、接收服务启动前执行。半文件不会自动入库，清理范围只限本功能的暂存记录。

HEIC保留接收原件，PNG仅用于兼容验证/预览；不走旧 `ingest_new_file` 转换保存链路。不额外同步`.bowerbird`跨设备创作资料、画板或账号。来自手机的实际字节受手机文件选择器行为影响，不承诺自动取得Live Photo全部组成。

同名文件分配新名称，不覆盖已有文件；上传ID重复完成复用原路径/Asset ID。不同上传ID的相同内容不会自动视作同一传输。索引与目录移动/刷新使用现有连接GATE串行化。原件登记后的分类沿已有开关和门控，传输本身不调用云服务。

桌面快照在进程内具有单调 `revision`，开启新会话不重置；初始查询、命令返回与状态事件共用同一版本比较，旧通知不能覆盖较新的进度或关闭状态。手机按批次顺序上传，仅在持久收件HTTP回执后标为已发送；连接丢失且回执不明时提示先在电脑核对，不自动重发。用户重试只发送本批尚未确认的文件，明确重新选择同一文件仍视作新传输。

支持图片、视频、音频以及UTF-8 Markdown/TXT；具体格式单一清单在 `core/quick_transfer.rs`。文本最大2 MiB；媒体内容和解码限制沿现有本机能力，扩展名不能代替内容验证。

手机网页提供“相册”和“文件”两个入口：相册使用独立`accept="image/*,video/*" multiple`输入且不加capture，向Android Chrome请求媒体选择器；文件入口保留音频、文本等类型。二者共用发送队列，取消选择保留当前队列，发送中和失连均禁用。`accept`是浏览器选择界面的类型提示，不能强制任意厂商相册App，服务端素材校验不变。

桌面“本次接收”根据已入库assetId批量读取素材，复用现有本机文件预览生成图片缩略图／视频封面。连接式入库完成时thumb_path可能为空，不能直接以该字段是否存在判定没有预览；HEIC沿既有兼容预览路径保留原件。音频、文本、尚未入库或预览失败保留类型图标，预览失败不撤销收件/入库成功。该能力只使用本机IPC，不增加局域网文件读取接口。实现与边界见[相册与缩略图日志](../project_logs/2026-11-03-quick-transfer-media.md)。

## 源码与验证入口

### 本机发送（2026-11-06，源码待发布）

- 快传新增接收／发送页签；发送使用系统文件选择器，多选普通文件，开启前可移除。发送原文件，不导入、不转码、不修改资料库，不附带创作资料或自动遍历目录；更换文件需先关闭发送。
- 复用 LocalSend `WebSendConfig`／`PrepareDownload`／`FileDownload`；独立端口、二维码和8位配对码，不需要先开启接收或创建快传目录。收发可同时开启，各自停止；收起、切页不停止。共用已有 snapshot revision。
- 手机扫码，电脑输入短地址和配对码。通过 PIN 后才返回文件名、大小和随机文件 ID，不暴露本机路径；资源均来自本机。逐文件点击下载，进度／保存位置由浏览器管理；页面不声称点击后已保存到目标设备。
- 最多100项选择，规范路径去重；单文件2 GiB，合计10 GiB。最多4条文件流，每条256 KiB块、2块队列，读／写等待60秒回收；大小限额针对所选文件集合，不是累计下载流量。不同设备可重复下载，无加密或断点续传承诺。
- 发送模式仅开放根页面／i18n／prepare-download／download；原接收模式仍关闭下载。Host／Origin／no-store／no-referrer／CSP沿用，PIN每IP三次错误封禁到重开。下载ticket为随机UUID且绑定IP，重新配对撤销该IP旧ticket，最多200客户端；探活不携带PIN重新配对，避免同IP多页互相自动撤销。关闭发送中止监听与连接，新开生成新PIN和文件ID。
- 下载前核对规范路径、普通文件、大小、修改时间；文件消失或变化时下载失败，需要重新选择。原件不创建冻结副本，发送期间应避免编辑。UTF-8 filename*保留中文文件名。
- 新入口 `quick_transfer/send.rs`、IPC `quick_transfer_send_start/stop`、桌面 `QuickTransferSend`、终端 `download.html`；复用 `QuickTransferConnection`，原 `upload.html` 不变。验证见[行动记录](../project_logs/2026-11-06-quick-transfer-send.md)。未发布安装包、替换运行中客户端或操作用户资料库；Android／iOS真机下载和Mac原生待验。

### 接收入口

- `src-tauri/vendor/localsend-core/`：固定上游及最小接收边界修订，许可证与来源记录随目录分发；Tauri resources 将 LICENSE 与本地修改说明纳入 `licenses/localsend/`，安装包仍须在发版时核验。
- Rust版本声明为本轮已验证的1.90；旧1.85声明低于现有和新增锁定依赖要求，不据此承诺1.85兼容。
- `src-tauri/src/quick_transfer/transport.rs`：LocalSend接收、权限、限额、停止与超时。
- `src-tauri/src/quick_transfer/addresses.rs`：本机LAN网卡推荐与纯排序回归。
- `src-tauri/src/core/quick_transfer.rs`：原件、持久记录与索引。
- `src-tauri/src/quick_transfer/mod.rs`、`commands/quick_transfer.rs`：单会话生命周期、IPC和状态事件。
- `src/components/QuickTransferPanel.tsx`、`src/lib/useQuickTransfer.ts`：正式桌面入口、收件面板和会话状态客户端；Toolbar 持续挂载，通过 `showTrigger={showLibraryActions}` 在项目管理页隐藏按钮，不卸载接收状态。收起或切页不中止接收，只有显式关闭才停止。入口范围回归见 [2026-11-04 记录](../project_logs/2026-11-04-project-quick-transfer.md)。
- `src-tauri/src/quick_transfer/upload.html`：手机同源接收页面，进度由真实上传驱动，网络成功表示已传到电脑；入库完成以桌面状态为准。
- `scripts/fixtures/quick-transfer-preview/preview.html`：已确认并冻结的电脑/手机独立示意，二维码和进度不连接真实服务。正式App隔离验证入口为 `scripts/fixtures/quick-transfer-live/preview.html`。
- `cargo test --locked --offline --lib quick_transfer`：临时目录与SQLite、真实loopback HTTP专项。Windows测试EXE需要按既有验证流程在副本嵌入Common Controls v6清单。

初次后端见[日志](../project_logs/2026-11-03-quick-transfer.md)，本轮实际使用修复、LAN地址证据与验证见[反馈日志](../project_logs/2026-11-03-quick-transfer-followup.md)。Windows防火墙本轮只读核对现有规则，没有修改。仍未完成真实手机端到端、Mac原生、安装包及真实用户库验收。
