# 画布长按拖出预览与接入记录

2026-11-01。第 1–9 项记录用户采用前的独立预览与测试准备阶段，当时未修改正式组件。用户随后明确采用，正式接入与验证记录见第 10 项起。保留旧 external-drag 确认稿；本子任务不单独提交，由根任务统一复核代码与文档后提交。

1. 阅读当前 PROJECT/UI 约定、开发计划与 ui-ux-pro-max。针对拖动交互查询得到键盘／单指替代提醒；本候选只用于确认指定手势与视觉状态，完整操作入口仍由正式方案决定。检查 17903，无已有监听。
2. 先写真实 Chromium 行为测试，页面不存在时得到 RED：没有「画布」标题。测试只绑定本机、拦截外部请求。
3. 建立合成 Bowerbird 壳：顶栏、素材库侧栏、画布；右侧只保留小型「接收演示」标识。无常驻步骤说明或额外副标题。
4. 初版计时／拖动交互通过：600ms 静止长按，4px 选择普通移动且不重新计时，触发后拖到右侧松手；原位保留，Esc／失焦／提前松手清理，库内拖出不模糊。
5. 根代理提供已 RED→GREEN 的共享 `createCanvasDragHold` 后改为复用；取消独立计时规则。模糊改为 body 直属 fixed portal 的静态 backdrop-filter 6px，不对应用根元素加 filter；携带缩略图独立置于上层，接收区域不覆盖。
6. 浏览器发现清除 carrying 后 effect 更新 blurBounds 有一帧残留；模糊层按 carrying 状态直接条件渲染，位置测量使用 layout effect。重跑 GREEN，验证 overlay 边界严格等于模拟应用壳矩形、应用自身 filter=none。
7. 实际查看深浅色截图。第一次浅色静态截图恰逢原有 160ms 控件颜色过渡，重拍时等待过渡结束；不是额外改动产品主题。最终文字、控件、模糊与携带图均正确。
8. 最终测试 `canvas-drag-out-preview-ui.test.mjs` 通过，pageerror=[]、remote=[]。证据：`.tmp/canvas-drag-out-preview/result.json`、`carrying-dark.png`、`carrying-light.png`、`overview-light.png`。独立服务 17903 已启动并交根代理保留，预览不作为原生跨应用验收。
9. 候选等待用户采用期间，仅新增 `production.html`／`production.tsx` 与 `canvas-drag-out-ui.test.mjs`：复用封闭 canvas-reference harness 挂载真实 CanvasWorkspace，构造普通素材、分组、生成会话三种合成快照。得到预期 RED：原地按住后没有 start_external_drag，等待 exportCalls 超时；尚未修改正式组件。后续断言已准备多选、当前输出、组内单素材、4px／正常移动、capture交接、同窗回落不增不移、点击抑制与项目切换取消，需实装后逐项执行，不将未运行的后续断言声称通过。
10. 用户明确采用后，正式 CanvasWorkspace 复用共享长按状态机。按下时保存元素、选择与项目身份；600ms 触发前校验 capture／项目，交接前清除当前画布拖动并释放 capture，调用 `startExternalDrag(ids, 'hold', { source: 'canvas', signal })`。普通拖动沿用原 4px 规则，不增加等待；移除 AssetContextMenu 和混选菜单的旧 pickup 入口。
11. 补齐普通素材、多选、生成会话当前展示图、展开组成员及折叠组缩略图；折叠组长按只带出所按素材，普通移动仍移动整个组。折叠组用例先确认缺口再接入，最终 GREEN。视频海报禁止浏览器自发图片拖动，保留现有视频控件交互。
12. 精确校验原素材位置时，测试快照曾包含点击焦点附带的 view 字段，改为比较全部实际节点、边与分组；这些焦点变化不是素材移动。下一次普通点击的实际行为为打开媒体预览，修正原先等待 peek 回调的测试预期。
13. 独立复核发现原生外部松手可能不回传 DOM click，旧抑制标记会吞掉下一次鼠标或键盘激活。新有效手势清除旧标记，键盘激活 detail=0 不被抑制；受控接收端消耗本次 pointerup/click 后，两类后续激活均通过。修复 Agent 卡片点击处理缺失 event 形参。
14. 新增迟到原生终态回归：准备取消已获确认、用户开始新的内部拖动，旧 IPC 此时完成。先得到精确 RED（已就绪的建组提示被清掉），再将外拖结束清理限定为外拖状态；存在新的 node/graph 拖动时保留其 hover 与文件夹目标。重跑后保持建组提示且松手成功建组。
15. 最终 `canvas-drag-out-ui.test.mjs` exit 0，15 个聚焦场景通过，errors=[]、remote=[]；更新后的 `external-drag-ui.test.mjs` exit 0，保留素材库图片／音频外拖及内部目标语义。入口见 [README.md](README.md)，证据为 `.tmp/canvas-drag-out-ui/result.json` 与 `canvas-hold-dark.png`；已实际查看正式画布模糊截图。此 harness 使用受控原生 IPC，不将其称作跨应用投放实测。根任务另完成最终 TypeScript 与 Vite 构建，以及桥接深浅色截图复核。
