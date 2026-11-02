# 文本编辑器与文档卡片交互预览

2026-11-03。用户已确认并授权正式接入；本目录保留当时的独立确认稿。正式实现与验证见 [文本协议](../../../../../dev-doc/TEXT-LIBRARY.md) 和 [行动日志](../../../../../project_logs/2026-11-03-text-workspace.md)。

从 `apps/desktop` 启动：

```powershell
node scripts/fixtures/text-workspace-review/serve.mjs
```

打开 <http://127.0.0.1:1456/scripts/fixtures/text-workspace-review/preview.html>。`?view=composer` 从对话框开始。

## 可以检查的交互

- 对话框右上放大图标进入编辑器；编辑器复用正式 `TextPlateEditor`、Markdown 编解码、工业主题变量与仓库自带示例图。
- 正文编辑、标题、粗体、斜体、列表、引用、撤销／重做；正文／源码切换。
- 左侧素材库开合、搜索；双击图片在编辑选区插入，键盘 Enter 提供替代操作。样例只展示图片。
- 右上三个操作：选择示例集合后出现文本条目；选择示例项目后更新该画板的文档卡；添加到生成对话框后显示图文草稿，需另行发送。
- 文档卡放大编辑；依次点击输出和同类型输入连接。两种输出独立，右键输出可断开，查看输入展示引用内容。窗口尺寸变化重新测量端口和线端位置。
- 深浅色、900／1440 桌面宽度；Escape 关闭浮层或返回。预览条用于切换评审场景，不是正式产品新增导航。

## 边界

仅 Plate 编辑和文档编解码使用正式逻辑。对话框外壳、集合／项目保存、文档卡和连接是独立演示；示例状态仅存当前页面内存，刷新重置。生成按钮仅提示预览状态，无原生 IPC、真实文件写入、用户库访问或模型调用。

当前候选在接线后向下游草稿显示相应显式引用，不自动运行。正式工作流现有规则是只有显式引用的端口参与编译，接入时须保留这一可见操作结果。

## 正式实施入口

- `CreationBoard.tsx` 共用工具条放大入口，覆盖画板及素材库创作框；独立文档会话承载未保存长文。`TextDocumentEditor` 绑定已登记原件，不能直接替代新建会话。
- `TextPlateEditor.tsx` 复用编辑核心，正式素材异步加载须冻结选区及文档会话，防止焦点改变或旧回包错插。
- 新建文档使用受控原生命令：集合身份解析目标目录并创建不覆盖同名文件的 `.md`；项目仅创建原生文本卡片，保持一个正文来源。失败保留草稿，集合使用真实目录，不写旧虚拟成员关系。
- Plate／Markdown 和 ProseMirror 草稿显式转换：保留标题／列表／强调，媒体转成现有引用节点；受控素材 HTML 不直接作为模型提示词。原文档独立保留，以支持再放大编辑。
- 新文档卡单独扩展 note 协议，保留旧二维 `cells`；同步原生封闭枚举和字段校验。两输出来自同一文档，图片按文档顺序，文本携带 Markdown 和有序媒体引用；下游统一重编号。
- 正式保存／恢复、原生协议兼容、真实下游提示词编译和用户库验收不以此预览验证代替。

## 验证

```powershell
node node_modules/typescript/bin/tsc --noEmit -p scripts/fixtures/text-workspace-review/tsconfig.json
node scripts/text-workspace-review-ui.test.mjs
```

独立 tsconfig 覆盖预览 TSX 及其正式依赖，不通过修改主应用入口检查预览。截图写入 `.tmp/text-workspace-review/`。

2026-11-03 独立 TypeScript 与 Chromium 交互检查通过：段落中间真实光标插图一次、Markdown 格式保留、示例保存与草稿往返、不同类型拒接／双端口连接／断开／输入预览、Escape 焦点恢复、900／1440 深浅主题和线端位置；没有页面异常、外网请求或原生 IPC。Windows 沙箱阻断了依赖 realpath 和 Chromium 本机网络，正常权限下运行通过；不通过更改依赖或放宽正式应用权限解决。
