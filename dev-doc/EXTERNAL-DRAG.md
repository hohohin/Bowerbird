# 素材拖出到其他应用

交互已于 2026-11-01 通过独立网页确认；产品约定以 `PROJECT.md` 为准。本页记录原生实现和验收边界，源码接入不代表安装包更新。

## 接口与原件

- `start_external_drag({ assetIds, mode, sessionId })` 仅接受主 WebView 调用；`mode` 为普通按住拖动的 `hold` 或菜单抓起的 `pickup`。每次 sessionId 独立，`cancel_pending_external_drag` 只使对应尚未开始的手势失效，不干预已交给系统的拖放。
- `core/external_drag.rs` 从数据库解析所选素材的当前原件，保留选择顺序、合并重复路径。失效身份、缺失原件或非法文件拒绝整个拖动。
- 连接分身使用现有 Asset ID，因此输出原件，不输出 `.bowerbird` 描述文件。缩略图不作为交付内容。解析不解码媒体、不复制、不移动或删除原文件。
- 系统只提供 Copy 传输效果，接收程序自行决定导入方式。返回 `dropped: true` 只表示系统接受了投递，不等于第三方已完成上传、解码或导入。
- 后台线程解析路径；主线程执行原生拖动。单会话占用持续至原生完成或失败，防止嵌套系统拖动。

## Windows

使用 Shell item array 的 `IDataObject` 提供标准 `CF_HDROP` 文件列表；`IDropSource::QueryContinueDrag` 管理鼠标状态。普通拖动松手完成；菜单抓起允许初始未按键，等下一次按下并松开才完成。Esc／右键取消。

从 `fs::canonicalize` 得到的 `\\?\` 路径不能直接交给 Shell。本次实际复现 E_INVALIDARG 后，按 `std::path::Prefix` 转换磁盘及 UNC 共享路径，不使用丢失 Unicode 或破坏共享前缀的字符串截取。起拖前最后一次检查实际鼠标按钮，避免准备期间已经松手后误投递。

拖影取系统小图标，不解码原始图片、视频或音频。OLE、PIDL、位图均按作用域释放。

依据：[QueryContinueDrag](https://learn.microsoft.com/en-us/windows/win32/api/oleidl/nf-oleidl-idropsource-querycontinuedrag)、[DoDragDrop](https://learn.microsoft.com/en-us/windows/win32/api/ole2/nf-ole2-dodragdrop)。当前 Wry 的普通窗口宿主不采用 CompositionController 专属 DragStarting 接口。

## macOS

沿用仓库的 Objective-C／`cc` 桥接模式，使用原件 `NSURL` 与 AppKit `NSDraggingSession`，无新增运行依赖。只允许 Copy，源对象保活至末态；C 回调恰好一次，Rust 在回调中复制错误并释放 oneshot sender。

采用 [drag-rs 的局部事件方式](https://github.com/crabnebula-dev/drag-rs/blob/main/crates/drag/src/platform_impl/macos/mod.rs) 启动会话，不向系统注入鼠标事件。`pickup` 没有改成必须按住的替代手势，但 AppKit 没有 Windows 同形的继续／结束拖动控制接口；**当前 Windows 环境不能证明松手后携带及下一次点击投放在 Mac 可用**。Mac 编译、普通拖出、菜单抓起、Esc、内部回落均须实机验收，不能将桥接源码存在写成验收通过。

## 内部拖动兼容

库内继续沿用 `dragPayload` 的 Asset IDs，HTML 自定义 MIME 不是身份来源。系统拖动期间不得因 HTML 早期 `dragend` 清掉身份；原生结束后才清理临时状态，保留素材栏既有收起偏好。Windows 已实测原生 Files 拖回同一 WebView 的 DOM drop 先于 IPC complete，身份能保留到投放完成。集合树和旧侧栏在原生拖动时接受 Copy 协议，内部建立分身／集合的业务不变。

画布普通拖动仍移动节点；只有已登记素材才提供菜单拖出。第三方拒绝文件、用户取消或原件失效都不改变画布和素材库记录。

## 验证记录

- 原件解析：实际 RED → GREEN，4 项通过，含顺序／重复项、移动后路径、混合失效选择、非法原件及原件字节不变。
- Windows 原生单元测试：6 项通过，含拾起状态、普通拖动、延迟释放取消、Esc／右键、规范化 Unicode 原件与磁盘／UNC 路径形状。
- 准备会话：3 项实际 RED → GREEN，覆盖旧手势失效、先到取消、已启动会话不被 pending cancel 干预与并行拒绝。
- 独立网页：库内多选、画布普通移动、右键抓起、点击演示接收、Esc、深浅色通过，无页面错误或远程请求。演示接收区不代表第三方应用。
- 主 crate `cargo test --locked --offline --lib external_drag`：13／13 通过。隔离同源原生 crate 9／9 与 Clippy `-D warnings` 通过。
- 正式组件 `external-drag-ui.test.mjs`、既有 `asset-multi-menu-ui.test.mjs`、`audio-library-ui.test.mjs`、完整 TypeScript 和 Vite 构建通过。覆盖真实卡片、集合树、画布单选／混选、来源栏清理；IPC 为控制桩，不能替代 OS 验收。
- Windows 同窗原生拾取→DOM Files／IDs→IPC complete 顺序与 Esc／右键取消已实际操作通过。普通 hold 的成功日志存在但输入来源未确认，自动化快速拖动因提前松手正确取消，不据此声称普通跨窗拖放已验收。
- Windows 独立接收进程未得到接收证据：电脑操作工具限制拖动终点必须在同一窗口内，且点击会自动激活目标，干扰正在进行的系统拖动。用户选择暂不手动测试，记为待验收；这不证明真人操作失败。独立测试进程已清理。
- Mac 编译／真机、实际 Codex 附件处理及剪辑软件导入：尚未验收。未构建或发布安装包。

隔离原生入口：`apps/desktop/src-tauri/examples/native_file_drag_smoke.rs`；接收器与日志：`spikes/native-file-drag/`。只使用合成文件与独立 WebView profile，不读取用户素材库，不向真实对话或云端发送文件。

完整行动记录见 [本轮日志](../project_logs/2026-11-01-external-drag.md)。
