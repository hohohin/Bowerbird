# 素材拖出到其他应用

画布长按与整窗模糊交互已于 2026-11-01 通过独立网页确认，替代先前右键抓起方案；产品约定以 `PROJECT.md` 为准。本页记录原生实现和验收边界，源码接入不代表安装包更新。

## 2026-11-03：全息反馈与系统缩略图

用户已确认透明投影方案并授权实装。正式桥挂载 `externalDragHud.tsx`，240ms opacity 渐显固定 6px 模糊，源素材轮廓按屏幕实际尺寸定位；提示无底板，减少动态效果时直接显示终态。原两帧绘制、取消 ACK、同窗拦截与子 WebView 显隐契约保留。

后端在 worker 中读取首项素材登记的独立 `thumb_path`，不生成缓存或读取大原件；输入最多 8 MiB、4096×4096／64 MiB 解码预算，输出上限 144×180 逻辑像素并支持 1–3 倍 DPI。无缓存、损坏或超限回退系统图标。拖影 RGBA 保留原比例与透明度，贴边短线／方点，无底板；文件交付仍是原件。Windows 使用顶向下 BGRA DIB 交给 Shell，交接成功后不再保留已由 Shell 消费的 HBITMAP；Mac 将 RGBA 复制进 NSBitmapImageRep，再交给 NSDraggingItem。

验证：18 项原生、17 项正式桥及正式 Canvas 回归通过，包含实际 Shell 缩略图数据写入；Mac 编译／真机、真实跨应用视觉仍待验，未更新安装包。详细失败／修复与类型检查边界见 [日志](../project_logs/2026-11-03-external-drag-hud.md)。

## 画布长按

- 原地按住鼠标主键 600ms 后，将普通画布手势交给系统文件拖动；保持按住移到其他应用，松手投放，Esc 取消。按下后达到既有 4px 屏幕移动阈值立即走画布移动；即使回到原位或途中停顿，本次按压也不再触发长按。
- 普通素材支持多选；折叠组内缩略图和展开组内图片携带该单项，生成会话携带当前展示图片。编辑区和非素材控件不启用该手势。旧「拖入到其他应用」菜单入口移除，素材库直接拖出沿用原有行为。
- 达到阈值后清掉未提交的画布拖动和帧队列，释放 pointer capture，拦截尾随点击，避免节点移动、打开详情或切换画板。离开项目、卸载、失焦、按键丢失及取消会使尚未启动的按压失效。
- 模糊层直接挂在 body，使用固定全窗、pointer-events:none、静态 6px backdrop-filter；不改变根节点 filter 或 fixed 定位，不持续动画模糊半径。系统拖影不受 DOM 模糊影响。原生探索子 WebView 通过现有 overlay 队列隐藏／恢复，不读取或截图网页内容。
- 两次可取消的 requestAnimationFrame 为模糊提供绘制机会后才请求原生拖动；超时则取消本次，不以未绘制状态启动。取消保护从等待前开始，防止松手／Esc／切换项目后旧手势复活。浏览器帧测试不等于原生合成器帧率验证。

## 接口与原件

- `start_external_drag({ assetIds, mode, sessionId })` 仅接受主 WebView 调用。素材库和画布长按均使用 `hold`；后台保留旧 `pickup` 协议以兼容既有调用，正式画布已无该入口。每次 sessionId 独立。
- 前端 `startExternalDrag(ids, mode, { source, signal, sourceRect })` 默认来源为素材库，保持立即起拖；画布来源增加模糊、绘制等待、同窗投递拦截及生命周期取消。
- `cancel_pending_external_drag` 返回 bool：true 确认该请求不会再进入原生拖动，可提前恢复界面；false 表示已经交给系统，模糊持续到原生完成。只取消对应尚未开始的手势，支持取消先到、启动后到；不干预已交给系统的拖放。确认取消后不再吞掉新操作的 Esc，不弹出旧准备请求迟到的错误；载荷锁仍等待原启动调用终态释放。
- `core/external_drag.rs` 从数据库解析所选素材的当前原件，保留选择顺序、合并重复路径。失效身份、缺失原件或非法文件拒绝整个拖动。
- 连接分身使用现有 Asset ID，因此输出原件，不输出 `.bowerbird` 描述文件。缩略图不作为交付内容。解析不解码媒体、不复制、不移动或删除原文件。
- 系统只提供 Copy 传输效果，接收程序自行决定导入方式。返回 `dropped: true` 只表示系统接受了投递，不等于第三方已完成上传、解码或导入。
- 后台线程解析路径；主线程执行原生拖动。单会话占用持续至原生完成或失败，防止嵌套系统拖动。

## Windows

使用 Shell item array 的 `IDataObject` 提供标准 `CF_HDROP` 文件列表；`IDropSource::QueryContinueDrag` 管理鼠标状态。当前素材库与画布均使用普通 hold，松手完成，Esc／右键取消。兼容分支 pickup 允许初始未按键，等下一次按下并松开才完成，本次不改写已验证的系统协议。

从 `fs::canonicalize` 得到的 `\\?\` 路径不能直接交给 Shell。本次实际复现 E_INVALIDARG 后，按 `std::path::Prefix` 转换磁盘及 UNC 共享路径，不使用丢失 Unicode 或破坏共享前缀的字符串截取。起拖前最后一次检查实际鼠标按钮，避免准备期间已经松手后误投递。

拖影优先使用登记的缓存缩略图；无缓存保留系统小图标。不在起拖时解码原始图片、视频或音频。OLE、PIDL 按作用域释放，位图在 Shell 初始化成功时转交所有权，失败时本地释放。

依据：[QueryContinueDrag](https://learn.microsoft.com/en-us/windows/win32/api/oleidl/nf-oleidl-idropsource-querycontinuedrag)、[DoDragDrop](https://learn.microsoft.com/en-us/windows/win32/api/ole2/nf-ole2-dodragdrop)。当前 Wry 的普通窗口宿主不采用 CompositionController 专属 DragStarting 接口。

## macOS

沿用仓库的 Objective-C／`cc` 桥接模式，使用原件 `NSURL` 与 AppKit `NSDraggingSession`，无新增运行依赖。只允许 Copy，源对象保活至末态；C 回调恰好一次，Rust 在回调中复制错误并释放 oneshot sender。

采用 [drag-rs 的局部事件方式](https://github.com/crabnebula-dev/drag-rs/blob/main/crates/drag/src/platform_impl/macos/mod.rs) 启动会话，不向系统注入鼠标事件。当前画布已统一到按住拖动的 hold，旧 pickup 不再暴露界面入口。Mac 编译、素材库拖出、画布长按、Esc、模糊及内部回落均须实机验收，不能将桥接源码存在写成验收通过。

## 内部拖动兼容

库内继续沿用 `dragPayload` 的 Asset IDs，HTML 自定义 MIME 不是身份来源。系统拖动期间不得因 HTML 早期 `dragend` 清掉身份；原生结束后才清理临时状态，保留素材栏既有收起偏好。Windows 已实测原生 Files 拖回同一 WebView 的 DOM drop 先于 IPC complete，身份能保留到投放完成。集合树和旧侧栏在原生拖动时接受 Copy 协议，内部建立分身／集合的业务不变。

画布长按触发后，通过 window capture 拒绝投回 Bowerbird 的 dragover/drop（dropEffect:none），不走素材库的内部分身／画布插入逻辑。该拦截不影响素材库直接拖出的内部投递。第三方拒绝文件、用户取消或原件失效都不改变画布和素材库记录。旧原生请求迟到完成时，不清掉用户之后开始的普通画布移动目标。

## 验证记录

- 原件解析：实际 RED → GREEN，4 项通过，含顺序／重复项、移动后路径、混合失效选择、非法原件及原件字节不变。
- Windows 原生单元测试：6 项通过，含拾起状态、普通拖动、延迟释放取消、Esc／右键、规范化 Unicode 原件与磁盘／UNC 路径形状。
- 准备会话：既有 3 项与新 ACK 2 项共 5 项通过；新项实际 RED → GREEN，覆盖准备取消／重复取消返回 true、已启动返回 false、取消先到仍阻止对应启动。
- 长按控制器 `canvas-drag-hold.test.mjs`：实际 RED → GREEN，5／5 通过，覆盖 599／600ms、微抖、4px 越界后回位、松手／取消／按键丢失、替换指针及回调交接。
- 独立网页 `canvas-drag-out-preview-ui.test.mjs`：长按模糊、普通移动、投递演示、Esc、深浅色通过，无页面错误或远程请求；用户明确确认采用。演示接收区不代表第三方应用。
- 主 crate `cargo test --locked --offline --lib external_drag`：15／15 通过。前次隔离同源原生 crate 9／9 与 Clippy `-D warnings` 记录仍保留；本轮未改 Windows／Mac 原生拖动适配器。
- 正式 Canvas `canvas-drag-out-ui.test.mjs` 15 个场景、模糊桥 `canvas-drag-backdrop-ui.test.mjs` 16 个场景、既有外拖／菜单／音频回归、完整 TypeScript 和独立 Vite 构建通过。覆盖长按交接、普通移动、组内单项、生成当前图、同窗取消、迟到回调、深浅色及子 WebView 显隐；浏览器调用真实组件和桥接逻辑，原生 IPC 为控制桩，不能替代 OS 验收。中途一次未定位的 pending-blur 等待超时及后续通过记录见 [长按日志](../project_logs/2026-11-01-canvas-drag-hold.md)。
- Windows 同窗原生拾取→DOM Files／IDs→IPC complete 顺序与 Esc／右键取消已实际操作通过。普通 hold 的成功日志存在但输入来源未确认，自动化快速拖动因提前松手正确取消，不据此声称普通跨窗拖放已验收。
- 前次独立接收进程测试因工具跨窗口手势限制及用户暂不便操作而延期；独立进程已清理。用户随后明确反馈「在素材库中拖出放到其他应用已经测试通过」，据此更新为素材库外拖用户验收通过，不推定所有目标程序和平台均通过。
- 新画布长按的真实跨应用投递及整窗模糊、Mac 编译／真机、具体 Codex 附件处理及剪辑软件导入：尚未逐项验收。未构建或发布安装包。

隔离原生入口：`apps/desktop/src-tauri/examples/native_file_drag_smoke.rs`；接收器与日志：`spikes/native-file-drag/`。只使用合成文件与独立 WebView profile，不读取用户素材库，不向真实对话或云端发送文件。

完整行动记录见 [首次拖出日志](../project_logs/2026-11-01-external-drag.md) 与 [长按替换日志](../project_logs/2026-11-01-canvas-drag-hold.md)。
