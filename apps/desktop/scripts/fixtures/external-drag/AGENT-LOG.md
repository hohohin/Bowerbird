# 外部拖出前端审查与预览

2026-11-01，任务分工为前端只读审查与独立候选预览；未修改正式源码、数据库、原文件，未 commit/push。

1. 阅读 PROJECT 当前进展／关键约定、UI-DESIGN-SPEC、开发计划及 FOLDER-MODE 的连接式素材库协议。PROJECT:116 明确界面改版先网页确认；根代理确认先完成可审阅候选，原生能力独立验证。
2. 审查 dragPayload、FileMediaCard、AudioFileMediaCard、VirtualCatalog、ConnectedCollections、CanvasFrequentAssets、CanvasWorkspace 与 AssetContextMenu。当前跨内部区域拖动的真实身份是模块内 Asset IDs，text/plain 仅作拖动信号；Mac 已知会移除自定义 MIME，不改回以自定义 MIME 为唯一来源。
3. 识别内部兼容边界：CanvasWorkspace 补齐虚拟列表选区缺页并固定项目路由；source-panel 依赖冒泡 dragstart 自动收起、window dragend 清理。直接替换成 native 前须验证自窗 native drop 是否仍回到 WebView DOM；不能根据浏览器 mock 推断系统行为。
4. 原生命令建议收 Asset IDs 和 hold／pickup 模式，由 Rust 解析当前登记原件，禁止前端传任意 thumb URL、分身 JSON 路径或按文件名找原件。canvasSelection 已提供资产身份；素材组／多选中视频可通过既有 includeVideos 分支获得。
5. 创建独立浏览器行为测试。首次 sandbox 运行因 pnpm realpath EPERM 与 localhost 限制失败，属于环境失败；本机重跑得到预期 **RED**：独立页面尚不存在，无「素材库」标题。
6. 实现三个区域的最小候选：素材库直接／多选拖动；画布普通拖动；右键抓起、缩略图数量与 Escape／取消；右侧对话附件／时间线两个演示接收区域。目标清楚标「演示」，底部注明不会向其他应用发送文件。
7. **GREEN**：真实浏览器单项拖动、Ctrl 多项、右键抓起→点击接收、Escape 取消、时间线、深浅主题全部通过，pageerror 与远程请求均为零。真实拖拽为页面内 HTML DnD，不声称原生跨应用效果。
8. 查看两主题截图，发现误用了不存在的 panel/edge token，导致边线与底面丢失；改用正式 bb-surface/bb-line/bb-bg 并导入 IndustrialMenus，重新回归通过并实际查看。抓起状态的演示文案区分「点击放下」与直接拖动的「松开放下」。

证据：`.tmp/external-drag-preview/result.json`、`carrying-dark.png`、`timeline-dark.png`、`menu-light.png`、`overview-light.png`。测试服务在 finally 关闭；单独的 localhost 预览服务由根代理决定保留。未使用模拟接收结果作为系统原生功能验收。

## 用户确认后的正式前端接入

9. 根代理转达用户已明确采用候选，开始正式接入；原生 IPC/文件解析由根代理负责，原生窗口拖放由另一代理独立验证。修改前将涉及的已有源码备份到仓库 `.tmp/external-drag-ui-baseline/`。
10. 先创建正式组件测试和封闭 IPC fixture，实测 RED：FileMediaCard 的 dragstart 未转原生，defaultPrevented 为 false。修复 fixture 错误路径不算 RED。最小接入放在 FileMediaCard 包装层，图片／视频／音频共用；无需重复改 AudioFileMediaCard。
11. 新增 externalDrag，收 Asset IDs、hold/pickup；后端决定原文件。dragPayload 在原生会话期间持有身份，HTML 提前 dragend 和其他调用不能清除／覆盖。finally 清空并发结束事件，CanvasWorkspace 解除临时 dragging/hover，保留原有拖后收起习惯。画板普通指针移动代码未改。
12. 加入 AssetContextMenu 单项／多项及画板混选通用菜单「拖入到其他应用」，只取现有资产身份，去重；未登记或没有文件的记录禁用／隐藏。测试混选先误点便签编辑区导致单选，改为 Ctrl 点便签边缘后验证素材＋便签只传素材 ID；不把测试选择错误当功能回归。
13. 独立审查发现 ConnectedCollections 的 link、旧 Sidebar 的 move 与原生只允许 COPY 不兼容。真实集合树 RED（link 非 copy）→GREEN，仅原生会话请求 copy，分身／内部业务不变。其他素材接收区已使用 copy。
14. 根代理与原生代理提供真实 Windows 同窗证据：DOM drop 在 IPC complete 前，drop handler 保留 IDs，因此 finally 释放时序成立。浏览器测试的模拟 Files 接收只证明前端行为，不替代原生证据。
15. 针对准备期间旧手势松手后新手势误抓旧素材，先得到 RED（start 无 sessionId），增加每次 UUID；hold 监听 pointer/mouse up、下一次 down、blur，全部模式 Escape；每会话只发送一次 cancel_pending_external_drag，finally 移除监听。后端只取消对应准备中会话，已开始的 OS 拖放不受该命令影响。测试包含连续会话、鼠标抬起、下一次按下、pickup 等待点击和 Escape。
16. 完整受控 IPC 测试已覆盖真实 FileMediaCard／音频卡／菜单／集合树／FileDropImport／CanvasWorkspace；`external-drag-ui.test.mjs`、既有 `asset-multi-menu-ui.test.mjs`、`audio-library-ui.test.mjs` 和全量 TypeScript 检查均通过。音频波形点击、持续播放、多选、原路径连接与无字节重新导入保持。结果见 `.tmp/external-drag-ui/result.json`。没有提交、推送或读取真实素材。
