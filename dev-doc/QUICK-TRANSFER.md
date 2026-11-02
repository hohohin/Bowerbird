# LocalSend 局域网快传

当前产品决策统一见 [PROJECT.md](../PROJECT.md)。2026-11-03 用户选择 LocalSend，手机扫码打开浏览器，无需安装 App。当前为接收后端与独立界面候选，正式界面须先经网页确认；不代表已安装客户端或公开包具备此功能。

## 接收契约

- 桌面显式开启会话，选择已有真实收件目录与本机可用私有 IPv4；应用启动不监听局域网，不复用浏览器扩展的 loopback 服务。
- LocalSend v1.18.2，固定上游 `af0416be50770a97760f7070684bc667b759a15c`，Apache-2.0。核心源码随仓库固定，使用 Rust `http` 能力；不打包 Flutter、不调用公网信令/中继。
- 网页与接口同源，静态资源由本机提供；本次会话随机配对令牌进入二维码，关闭后失效。只开放接收所需网页和协议端点，限定 Host/Origin，关闭下载/目录浏览/其他协议入口；本机IPC独立控制开启、状态、重试入库和停止。
- HTTP 网页模式不加密；仅用于可信局域网。二维码令牌是访问控制。没有断点续传，手机须保持页面前台；中断后重新发送。
- 单活跃 LocalSend 批次，最多100个文件；单文件2 GiB，每次开启最多500文件/10 GiB。等待继续和流式接收有闲置超时。停止等待写入句柄关闭和监听释放，不把仍在写入的文件当成取消完成。

## 文件与状态

原件按 `Receiving → Ready → Saved → Indexed` 持久化：

1. 生成独立上传ID，校验文件名/类型/声明长度；manifest和暂存在收件目录 `.bowerbird-quick-transfer` 下，连接扫描跳过此区域。
2. 流式写入、长度/可选发送方哈希检查、刷盘关闭句柄；接收方再验证媒体内容与SHA-256，将Ready记录原子保存。只有这一事实持久化后，网络请求才可返回成功。
3. 无覆盖发布到收件目录，保存Saved记录，再沿现有连接式素材索引登记，成功保存Asset ID。窗口切换不改变目标目录。
4. 入库失败保留已收到文件，可重试登记；重启后再次在原目录开启接收，恢复Ready/Saved记录。半文件不会自动入库，清理范围只限本功能的暂存记录。

HEIC保留接收原件，PNG仅用于兼容验证/预览；不走旧 `ingest_new_file` 转换保存链路。不额外同步`.bowerbird`跨设备创作资料、画板或账号。来自手机的实际字节受手机文件选择器行为影响，不承诺自动取得Live Photo全部组成。

同名文件分配新名称，不覆盖已有文件；上传ID重复完成复用原路径/Asset ID。不同上传ID的相同内容不会自动视作同一传输。索引与目录移动/刷新使用现有连接GATE串行化。原件登记后的分类沿已有开关和门控，传输本身不调用云服务。

支持图片、视频、音频以及UTF-8 Markdown/TXT；具体格式单一清单在 `core/quick_transfer.rs`。文本最大2 MiB；媒体内容和解码限制沿现有本机能力，扩展名不能代替内容验证。

## 源码与验证入口

- `src-tauri/vendor/localsend-core/`：固定上游及最小接收边界修订，许可证与来源记录随目录分发；Tauri resources 将 LICENSE 与本地修改说明纳入 `licenses/localsend/`，安装包仍须在发版时核验。
- Rust版本声明为本轮已验证的1.90；旧1.85声明低于现有和新增锁定依赖要求，不据此承诺1.85兼容。
- `src-tauri/src/quick_transfer/transport.rs`：LocalSend接收、权限、限额、停止与超时。
- `src-tauri/src/core/quick_transfer.rs`：原件、持久记录与索引。
- `src-tauri/src/quick_transfer/mod.rs`、`commands/quick_transfer.rs`：单会话生命周期、IPC和状态事件。
- `scripts/fixtures/quick-transfer-preview/preview.html`：待确认电脑/手机独立示意，二维码和进度不连接真实服务。
- `cargo test --locked --offline --lib quick_transfer`：临时目录与SQLite、真实loopback HTTP专项。Windows测试EXE需要按既有验证流程在副本嵌入Common Controls v6清单。

详细行动、实际测试结果与未覆盖范围见 [本轮日志](../project_logs/2026-11-03-quick-transfer.md)。当前尚未进行真实手机扫码、Windows防火墙交互、Mac原生、安装包及真实用户库验收。
