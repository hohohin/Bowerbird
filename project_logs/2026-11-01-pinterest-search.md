# Pinterest 以图搜图开发记录

## 需求与执行记录

- 用户确认详情页与素材右键菜单提供「Pinterest 以图搜图」，搜索结果在现有探索页内呈现，保留项目上下文及拖拽采集链路；随后明确按 `ub-mode` 开发。
- 开工核对 PROJECT、开发计划、内置浏览器、文件工作区、错误展示和 UI 规范。现有「发现更多」只打开来源页面，独立保留。
- 工作区基线为 dev / 93b60337。存在无关测试、配置和大量临时产物改动；本次仅暂存明确的功能文件，不清理未知归属的 worktree 或文件。
- 并行核对前端入口、原生隔离接缝及 Pinterest 公开实现。自动传图协议需先验证，不以打开首页充当搜索完成。
- 当前工具目录中未提供 crapper、dryer、mutator；记录这一限制，使用行为测试、类型检查和独立审查验证本次改动，不伪称执行了这些工具。
- 读取官方 Lens 帮助及公开网页依赖。初查把 `/upload-lens-image/` 暂理解为页面，沿官方调用继续追踪后确认它是 POST 接口，立即修正为主页 Lens 按钮；没有将错误路径作为最终入口。官方 FileUpload 使用精确 `lens-file-upload` 标记，change 后自动处理与跳转；不重写私有 API。
- 先写普通菜单红测（缺少入口），再接入详情、普通／画布共用右键和连接集合。多选仅发送命中图的素材 ID，项目／路由冻结，连接分身使用底层身份。完整 App／StrictMode 红测发现监听 effect 清理误取消请求，修复后通过。
- 图片适配器先复现登录等待缺失与 File/change 未交付，再实现顶层精确站点检查、登录续办、单次 Lens 点击、受控输入交接与有界等待。只交付本次内存图片；普通创建 Pin 输入永不使用。
- 原生先用 stub 得到三项预期失败，再实现素材身份解析、50 MiB 原件上限、方向校正／有界缩小重编码、单待办、main-only 命令与私有通知。近期 128 个请求 ID 加活动请求保护拒绝取消先于 start、终态和旧请求重放；相关测试先红后绿。
- 独立审查发现三个问题并修复：准备 Promise 占浏览器队列（新增 hide／导航红测后异步化）；站外登录丢失待办（跨站不注入但保留待办）；官方上传中以闭包忽略 change 而不禁用 input（每次新文档导航并以 timeOrigin 门槛拒绝旧文档）。旧请求、旧通知和取消均以 requestId 判定。
- 图片准备／上传提示使用中性主题色，错误沿现有中文展示边界；包含品牌名的通用兜底曾被二次过滤，改为明确中文兜底。正式组件截图已检查深浅色与 1000px 窄窗。
- Vite 首次沙箱执行遇到既有依赖 realpath 权限限制；相同命令获准在沙箱外输出到独立临时目录后通过。没有修改依赖或停止用户应用。
- 定向故障注入：移除旧文档门槛、令取消为空操作都触发测试失败；单独删 tick 的 stopped 检查仍被 clearInterval 保护，属于冗余保护下的存活变体，未伪称全量变异测试通过。首次测试注入器的 Playwright 相对路径错误已修正，工具启动失败不算行为验证。

## 验证

- 完整 TypeScript：`node node_modules/typescript/bin/tsc --noEmit` 通过。
- 独立 Vite 生产构建：`pnpm exec vite build --outDir .tmp/pinterest-search-build` 通过，仅有既有大包提示。
- `scripts/pinterest-search-ui.test.mjs`：详情／普通／多选／连接分身、真实 App／StrictMode、保留项目／选区／画板／相机、登录／错误、连续请求、终态与迟到事件、关闭／导航／路由取消、慢准备不阻塞 hide／导航以及深浅色／窄窗通过。
- `scripts/pinterest-adapter.test.mjs` 六组通过：登录等待、真实 File/change 字节与去重、SPA 登录＋异步 Lens 控件、取消／替换、旧忙碌文档拒绝、精确 origin／顶层／非 Lens 输入拒绝。
- `scripts/explorer.test.mjs` 和 `scripts/source-discovery.test.mjs` 共 8 项通过；既有 `asset-multi-menu-ui.test.mjs` 通过。
- Rust 定向：`cargo test --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --lib -- commands::pinterest_search::tests commands::source_browser::tests`，13／13 通过（搜图 7 项、原浏览器 6 项），保留既有无关编译警告。
- 旧原生探索：`node --experimental-strip-types scripts/verify-native-explorer.mjs src-tauri/target/debug/examples/explorer_smoke.exe` 通过；覆盖遮罩恢复／重载、跨视图图片与视频拖放、跨域 Cookie 图片、视频部分响应拒绝、Cookie 跨重启、表单／滚动保留及远程 IPC 拒绝。
- 新原生入口：`cargo build --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --example pinterest_search_smoke`，再于桌面目录执行 `node scripts/pinterest-search-native.test.mjs`；最终增强版 PASS／exit 0。覆盖真实命令、临时登记原件、登录续办、新文档交付、File/change、先取消后启动、防重放、替换、错误令牌、非 main 命令拒绝、临时隐藏恢复及跨站认证返回。
- 原生权限测试最初误拦截 Tauri 自身 `ipc.localhost`，测试驱动随后仅放行该精确内部端点，让真实 main-only 守卫执行拒绝；其他未被合成的外部网络全部阻断。修正后通过，不将驱动拦截失败冒充产品权限验收。
- 既有 `asset-detail-return-ui.test.mjs` 在初始 `detail-44` 素材定位超时，未进入本次动作，未修改旧脚本、不计通过。本次专项使用真实 App 独立覆盖详情返回和画板保持。

## 一手依据与剩余边界

- [Pinterest Lens 官方帮助](https://help.pinterest.com/en/article/pinterest-lens)。公开搜索控件脚本 [60329-466c563d30b4c62c.js](https://s.pinimg.com/webapp/60329-466c563d30b4c62c.js)，SHA256 `3698414d94fa70afb1470ef3621e48b2137eb000e455344a7692bb302deabf52`；FileUpload [48228-4acf6afe41899d7a.js](https://s.pinimg.com/webapp/48228-4acf6afe41899d7a.js)，SHA256 `5e844647b9bef8ab11981701eb7c56104fda524b4f50264dfff1096e5af21d61`。
- 网站收到 File 后仍自行上传／报错／展示结果；`submitted` 不宣称实际搜索成功。官方会保留 Lens 上传历史，此流程不发布 Pin。
- 浏览器和原生测试使用合成图片、临时库及独立浏览器资料，Pinterest 响应被测试拦截。未使用真实账号上传，地区／账号／中文控件名称以及 Mac WKWebView 仍待实测；不宣称跨平台或真实服务验收完成。
- 新文档门槛依赖系统时钟与浏览器 timeOrigin，运行中大幅校时尚未模拟。没有版本升级、数据库迁移、付费模型调用或安装包发布；开发后端需与新前端配套重建。
- 临时证据分别在 `.tmp/pinterest-search/` 和 `apps/desktop/.tmp/pinterest-search/`。未删除或提交既有无关改动，也未清理无法确认占用归属的 worktree。
- 收尾核对最终 diff、里程碑原样迁移及文件清单；本次功能代码、测试和文档作为一个完整变更提交。推送采用正常 dev 快进，不覆盖远端历史。
