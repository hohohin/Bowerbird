# 2026-11-03 快传桌面正式组件

用户已明确确认此前独立示意可接入，继续按 `ub-mode` 实施；本记录只覆盖桌面组件和客户端状态，不代表手机真机或安装包验收。根代理负责顶栏挂载、总体协议、提交与推送。

## First Make it Work

- 对照 `PROJECT.md`、`dev-doc/UI-DESIGN-SPEC.md`、`dev-doc/USER-FACING-ERRORS.md` 和已确认的 `scripts/fixtures/quick-transfer-preview/preview.html`。采用 `ui-ux-pro-max` 的异步反馈、移动尺寸及键盘检查，视觉以仓库工业主题为准。
- 新增 `QuickTransferPanel.tsx/.css`，导出自包含 `QuickTransfer()`；持续挂载的 hook 订阅 `quick-transfer://changed`，以 5 个 `quick_transfer_*` IPC 读取地址/状态、开启、关闭、重试入库。没有默认开启或轮询。
- 收起、Esc、遮罩仅隐藏面板，接收继续；显式“关闭接收”才发 stop。选择真实接收文件夹及本机私网地址，接收期间冻结；无网卡不退回 loopback 或所有网卡。目录选择取消保持未选择。
- 队列区分接收进度、正在入库、已入库、已中断、待入库。只有后端 `retryable` 为真才提供重试入库。正文错误统一经 `userErrorMessage`；不将原始异常加入 title。文件名按普通文本渲染。

## TDD 与验证

- `quick-transfer-state.test.mjs` 先使用无版本防护的接受函数运行，实际观察 2 条红测：旧 active 覆盖 stopped、旧 receiving 覆盖 complete。随后按后端新增单调 `revision` 接受非旧快照，2 条转绿。
- 正式组件浏览器测试直接导入真实组件，覆盖不自动开启、目录/网卡选择、目录取消、异步开关防重复调用、接收期间冻结、收起/重开持续接收、状态事件、关闭移除旧二维码、失败恢复边界、原始错误脱敏、离线刷新、Tab/Esc 焦点、迟到 initial/start 响应与乱序事件。根代理另行记录真实 App 顶栏缺失的红测及接入绿测。
- 二维码使用固定 MIT `qrcode@1.5.4`，运行时实际包含 MIT `dijkstrajs@1.0.3`；完整许可证保留于 `apps/desktop/public/licenses/quick-transfer-qr.txt`。`@types/qrcode@1.5.5` 与 Apache-2.0 `jsqr@1.4.0` 仅用于开发和二维码解码测试。解码得到完整会话 URL（含配对参数），不是手画的二维码；复制按钮也复制完整地址。
- `quick-transfer-bundle.test.mjs` 构建真实浏览器组件并检查模块清单：包含 qrcode/dijkstrajs，不包含 jsqr、pngjs 或 yargs。隔离构建输出只放 `.tmp/quick-transfer-desktop-bundle/`。
- `node node_modules/typescript/bin/tsc --noEmit` 通过。普通沙箱下 pnpm/浏览器遇 Windows `realpath EPERM` / `ERR_NETWORK_ACCESS_DENIED`，以自动审批允许的同一隔离检查重跑完成；没有改动真实资料库。

## Then Make it Right

- 先注册事件再读 initial status；所有事件及命令结果统一经 revision helper，杜绝迟到响应恢复已关闭 QR 或降级已完成文件。无订阅/读取成功时不允许盲目启动。
- 共用 `ModalShell` 处理焦点循环与恢复；共用 `OverlayScrollArea` 管理队列滚动，不新增另一套弹窗/滚动基础设施。
- 初次截图发现半透明：实际捕捉到了进入动画。截图改为禁用瞬态动画后复核真实阅读面；同时修复浅色全局样式优先级对专用 header/body/title 的覆盖，保留一致布局。深浅色均为不透明阅读面、单错位轮廓，无额外装饰标签。
- 测试中的服务和浏览器均在 finally 中退出，没有常驻辅助服务；二维码链接、文件路径、会话凭据不写日志。

## 验收边界

所有组件测试使用内存模拟 IPC，不会开启真实局域网监听；二维码解码/原生协议验证不替代 iOS Safari、Android Chrome、Windows 防火墙、真实多网卡或跨设备大文件验收。本次不打包，不修改 App.tsx，不改公共 UI 基础组件，不提交。

## Follow Practice：独立工具审查与职责收敛

早期子代理没有直接发现三项工具，不能据此认定环境不可用；后续已委托 `integration_audit` 实际运行官方 `crapper`、`dryer` 和 `mutator`，具体报告以其质量记录为准。

首轮复杂度扫描发现 `QuickTransfer` CC 70、`TransferRow` CC 14、`useQuickTransfer` CC 11。按实际职责收敛：目录选择和网卡刷新分别放在 `quickTransferDestination.ts` 的独立 hook；目的地字段、二维码生成与地址复制、接收队列分别放在 `QuickTransferDestination.tsx`、`QuickTransferConnection.tsx`、`QuickTransferQueue.tsx`；会话订阅注册/清理抽为具名 `observeQuickTransfer`。顶层组件保留会话生命周期和弹层组合，未改 CSS 或添加通用表单框架。

拆分前后运行同一套真实组件浏览器测试，均通过；拆分后的纯状态 2 项测试与 TypeScript 全量检查再次通过。没有为了降低纯展示条件指标继续拆无用属性层。

最终官方复扫：`QuickTransfer` 与 `QuickTransferNetwork` 各 CC 14，其余桌面函数最大 8；`dryer` 阈值 0.8 无重复命中。两处剩余条件主要是开关可用性、网络空态和显示组合，根代理接受保留，未声称所有函数 CC/CRAP 均低于 10。独立复核确认新 hook 仍保留序列、取消与错误契约，无新增问题。

独立变异验证中，官方 `>=` 改 `>` 存活属于等价状态：同 revision 应描述相同快照。额外经官方执行引擎的 `<=` 反向排序变异被两个实际行为断言杀死；不为等价变异增加无业务价值的引用断言。
