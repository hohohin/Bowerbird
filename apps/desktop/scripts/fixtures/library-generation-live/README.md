# 素材库生成正式接入隔离回归

运行 `node scripts/library-generation-live-ui.test.mjs`。使用正式 App、HomeWorkspace、store.startGeneration、完成通知和 CanvasWorkspace，仅复用现有封闭 IPC fixture 并覆盖合成项目、素材和任务数据；不访问用户数据、模型或外网。

验证默认快速生成/显式项目归属、后台发送不修改原生项目作用域、完成通知定位项目及创作线程、返回素材库恢复草稿、项目页没有隐藏编辑器，以及 900/1440 深浅主题下菜单边界、筛选栏避让和最后一行素材点击。截图输出到 `.tmp/library-generation-live/`。
