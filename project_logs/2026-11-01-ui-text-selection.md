# 2026-11-01 界面文字拖选修复操作记录

范围：阻止拖动鼠标时误选应用 UI 文字；不修改布局、主题或业务选区。

1. 阅读 ub-mode、PROJECT 当前约定、架构入口与 UI 规范，检查全局及组件的 `user-select`。原来只有部分画板控件禁选，普通面板仍可拖选。
2. UI/UX Pro 两次检索未得到直接适用的原生文本选择条目，采用已有编辑行为和浏览器实测作为验收依据。当前工具中没有 crapper、dryer、mutator；本次仅改 CSS，无新增生产函数。
3. 先添加 `apps/desktop/scripts/ui-text-selection.test.mjs`，加载真实全局样式及 ProseMirror 编辑器。实际鼠标拖动复现标题选中，断言按预期失败。
4. 在全局 body 设置标准及 WebKit 禁选规则；输入框、textarea、可编辑内容与对话正文恢复选字。已有只读编辑器、生成结果等显式可选规则继续生效，不使用全局鼠标事件或透明选区遮盖。
5. 隔离 Chromium 验证深浅主题各 11 类目标：标题、字段标签、body 浮层不产生文本选区；输入、多行输入、只读输入、ProseMirror、空值及 plaintext-only 编辑区、对话正文、工作流结果仍可拖选；编辑器输入正常。原有 `creation-editor-ui.test.mjs` 也通过。
6. 默认沙箱阻止 Vite 文件解析及本地导航，改用已批准的隔离浏览器测试权限；不操作真实账号或素材库。测试进程自行关闭，未清理其他任务的文件或工作树。

命令（在 apps/desktop 执行）：

```powershell
node scripts/ui-text-selection.test.mjs
node scripts/creation-editor-ui.test.mjs
```

验证边界：源码与 Chromium 行为通过；未重新打包、发布或验证 macOS 原生 WebView。
