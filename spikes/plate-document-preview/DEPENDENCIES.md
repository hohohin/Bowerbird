# Plate 文档预览依赖与边界

2026-11-02；独立 npm 包，不改变桌面端 React、ProseMirror、pnpm 锁文件或原生数据库。安装使用 `npm install --ignore-scripts`；精确版本见 `package-lock.json`。

| 包 | 锁定版本 | 已查许可 | 用途 |
|---|---|---|---|
| platejs | 53.5.2 | MIT | 真实 Slate/Plate 编辑器 |
| @platejs/markdown | 53.3.18 | MIT | Markdown 与 Plate 节点转换 |
| @platejs/basic-nodes | 53.0.0 | MIT | 标题、引用及基本文字样式 |
| @platejs/list | 53.3.13 | MIT | 列表 |
| @platejs/media | 53.1.4 | MIT | 图片、音频、视频节点 |
| remark-gfm | 4.0.1 | MIT | 识别 GFM，未支持内容保留源码 |
| remark-frontmatter | 5.0.0 | MIT | 识别 frontmatter，保留源码 |
| react / react-dom | 18.3.1 | MIT | 与当前桌面大版本一致 |
| lucide-react | 0.453.0 | ISC | 与桌面图标版本一致 |
| vite | 6.4.5 | MIT | 仅独立预览开发／构建 |
| tsx | 4.23.15 | MIT | 仅行为测试 |

核对依据为 npm registry 元数据及下载包的 `package.json` / `LICENSE`。Plate 核心和所选插件的 React peer 均支持 `>=18.0.0`。使用本地自行编写的组件，不复制 Plate Plus 付费组件或模板；正式分发时保留对应版权及许可文本。

官方说明：[Plate 媒体](https://platejs.org/docs/media)、[Markdown](https://platejs.org/docs/markdown)、[许可](https://github.com/udecode/plate/blob/main/LICENSE)。

## 预览格式

- 文档结构直接沿用 Plate 节点；媒体通过 `assetId` 引用登记素材。
- 图片引用使用 `![说明](bowerbird-asset:ID)`；音频／视频使用固定属性的 `<audio|video data-bowerbird-asset="ID" data-caption="URL编码说明" />`。这是待正式协议确认的预览语法，不宣称跨 Markdown 软件完全一致。
- 序列化已有媒体引用不会写入 blob URL 或媒体二进制。纯文本仍按纯文本编辑。
- 只渲染已登记素材；外部图片链接、未知 HTML、脚本、代码块、表格、任务列表、frontmatter、复杂列表按字面源码保留。MDX 不执行；预览未提供任意 HTML 渲染。基本段落、标题、粗体／斜体／行内代码、简单列表、引用支持富文本往返。Markdown 空行／强调符号可能规范化，不宣称字节级无损。
- 媒体 `preload="none"`，图片 lazy/async；只有打开的文档挂载编辑器。未实测大文档或原生 Windows／Mac 性能。

## 开发与验证记录

1. 先核对当前官方 API、npm React peer 和下载包许可，再创建隔离依赖；未增加云端上传服务。
2. 先写 5 项 codec 行为测试；空实现实际 5 RED。完成 Plate 转换后媒体身份／说明／顺序、未知源码、失联引用、安全协议均通过；斜体断言调整为接受等价的 `*` 或 `_` 表达。
3. 独立审查发现 frontmatter 等源码会被基础 Markdown 转换改写，外部图片会被解析为可加载节点。新增 2 项测试并观察实际 RED，再加入 AST 语法识别及字面保留；7 项 codec GREEN（含交接测试合计 16）。
4. TypeScript 检查通过。UI 验收由主线程记录，不能将单元测试视为真实桌面保存／转发验收。
5. 初装的 Vite 5 / tsx 4.19.2 存在 3 项开发工具告警；定向升级至上表版本，最终安装后的 npm audit 为 **0 vulnerabilities**。未运行自动 `audit fix --force`，未修改主应用开发工具。

预览不写用户原件、不触发模型调用或收费。后续正式接入仍需原件冲突检测、原子保存、索引更新、跨平台路径解析及真实草稿目标适配。
