# 素材库创作框隔离预览

复用正式 LibraryHome、LibraryComposer、CreativeComposer、项目选择菜单、近期任务与通知组件。所有项目、素材、提交和对话均为本地合成数据，不操作用户库、账号或真实模型。

在 apps/desktop 运行 Vite 后打开 `/scripts/fixtures/library-composer/preview.html`。

- 项目入口与图片／视频／对话位于同一工具行，不额外占用一行。
- 项目菜单只对本入口使用紧凑单层样式；其他共用选择器保持原样。
- 素材库草稿与目标画板草稿独立；未选项目时首次实际发送才准备「快速生成」。
- 右上近期任务默认收起；完成通知提供画板入口。

验证入口：

- `node scripts/library-composer-ui.test.mjs`：默认项目、独立线程、冻结目标、路由中断、失效目标、资料目录恢复、对话历史及迟到回执。
- `node scripts/library-generation-selection-ui.test.mjs`：主屏标签／集合的引用、浏览与多选。
- `node scripts/library-generation-notices-ui.test.mjs`：可操作通知、提醒设置、键盘焦点、近期任务。
- `node scripts/library-generation-navigation-ui.test.mjs`：同任务后续轮次不改变旧通知定位。
- `node scripts/library-generation-runtime-ui.test.mjs`：H3 持久化完成、无历史重发及对话回复。
- `node scripts/library-workflow-focus-ui.test.mjs`：H3 原工作流卡片定位与线程归属。

正式 App 接入验证使用 `library-generation-live` 夹具；不能以本预览的模拟提交代替真实模型或原生安装包验收。
