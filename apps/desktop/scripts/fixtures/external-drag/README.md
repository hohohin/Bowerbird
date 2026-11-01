# 外部拖出交互示意

这是独立界面候选，未挂进正式组件。左侧模拟素材库直接拖动；中间画布素材的右键菜单提供「拖入到其他应用」，进入带缩略图／数量的抓起状态；在右侧演示接收区点击放下，Escape 或取消按钮退出。画布普通左键拖动仍只移动节点。Ctrl／Command 可选择多项后直接拖动。

右侧明确标注「演示」；只更新页面内合成状态，**不读取原文件、不通过系统发送文件，也不证明 Codex 或剪辑软件已接收**。真实系统拖放由独立 native spike 验证，不能混淆两组证据。

启动（任何工作目录）：

```powershell
node D:/H/Project/Bowerbird/apps/desktop/scripts/fixtures/external-drag/server.mjs
```

地址：`http://127.0.0.1:17892/scripts/fixtures/external-drag/preview.html`。端口可用 `EXTERNAL_DRAG_PREVIEW_PORT` 调整，只绑定 localhost。

在 `apps/desktop` 执行交互回归：

```powershell
node scripts/external-drag-preview-ui.test.mjs
```

输出位于 `apps/desktop/.tmp/external-drag-preview/`。使用正式主题 tokens 和共用 ContextMenu；合成素材图案为本页 CSS／SVG，不访问网络、不替换正式源文件。按 PROJECT.md 的界面约定，用户确认本示意后才接入新菜单与抓起状态。

## 正式组件隔离验证

用户确认候选后，`production.html` 挂载正式 FileMediaCard（包括音频）、AssetContextMenu、ConnectedCollections、FileDropImport；测试还复用 canvas-reference 的正式 CanvasWorkspace。这里的原生 IPC 是可挂起、成功、取消、失败的控制桩，不读取用户库和真实文件，也不声称是系统拖放验收。

```powershell
node scripts/external-drag-ui.test.mjs
```

覆盖：只发送去重 Asset IDs；hold／pickup；提前 HTML dragend 不清除原生会话；单会话；准备期松手、新按下、失焦／Escape 取消与监听清理；同窗 Files 保留内部身份；真实集合树 COPY 效果及分身操作；画板来源栏收起／清理；真实画板单项与图片＋便签混选仅发送素材；无效记录禁用；失败中文提示；非 Tauri 网页保留 HTML 拖动。结果写 `.tmp/external-drag-ui/result.json`。
