# 画布长按拖出确认稿与正式组件验证

本目录保留用户已采用的独立确认稿；采用后已接入正式 CanvasWorkspace。`preview.html` 仍为合成演示：模拟画布中按住素材约 600ms，整个 Bowerbird 壳（顶栏、侧栏、画布）模糊；保持按住移到右侧「接收演示」松手。素材原位置保留。Esc、失焦、提前松手都会结束当前手势并恢复画面。

按下后移动达到 4px 就立即沿用普通画布移动，本次手势永久取消长按资格，途中停顿不会改成拖出。左侧素材库直接拖出不触发画布模糊。右侧仅为本页接收演示，不代表跨应用原生验证，不接入真实文件、Tauri 或用户库。

计时与移动阈值复用 `src/lib/canvasDragHold.ts`、`canvasLogic.ts`，与正式接入使用同一规则。预览模糊层为 body 直属 fixed portal，以模拟 Bowerbird 壳的矩形为范围，使用静态 `backdrop-filter: blur(6px)`；不对应用根元素使用 filter，不动画模糊半径。携带缩略图独立于模糊层。

```powershell
node D:/H/Project/Bowerbird/apps/desktop/scripts/fixtures/canvas-drag-out/server.mjs
```

预览：`http://127.0.0.1:17903/scripts/fixtures/canvas-drag-out/preview.html`。只绑定 localhost，端口可用 `CANVAS_DRAG_OUT_PREVIEW_PORT` 调整。

在 `apps/desktop` 执行：

```powershell
node scripts/canvas-drag-out-preview-ui.test.mjs
```

测试和截图输出：`.tmp/canvas-drag-out-preview/`。包含完整壳模糊范围、清晰缩略图／接收区、移动后停顿不误触、原位保留、松手／Esc／失焦清理、库内直接拖出、深浅主题。

正式组件隔离入口：[production.html](production.html)、[production.tsx](production.tsx)。挂载真实 CanvasWorkspace，使用合成项目与受控原生 IPC，不读取用户素材库。在 `apps/desktop` 执行：

```powershell
node scripts/canvas-drag-out-ui.test.mjs
node scripts/external-drag-ui.test.mjs
```

正式画布回归已通过 15 个聚焦场景：长按与 capture 交接、同窗回落不增不移、旧菜单移除、普通移动不延迟、4px 取消、短按／Esc／项目切换取消、多选、折叠／展开分组单素材、生成会话当前图、下一次鼠标／键盘激活、准备取消及迟到终态不干扰新画布拖动。结果见 `.tmp/canvas-drag-out-ui/result.json`，真实画布模糊截图见 `.tmp/canvas-drag-out-ui/canvas-hold-dark.png`。受控 IPC 截图不包含操作系统拖动缩略图；跨应用投放由原生验收覆盖。
