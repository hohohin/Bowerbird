# 视频采集入口迁移

从 CategorizedLibrary 和 ConnectedCollections 移除入口，在 SourceBrowserPanel 采集记录旁复用 VideoCollectionEntry。主应用经 ExploreWorkspace 传递已有新建项目回调，当前项目身份来自 store；保存、失败重试和原生浏览器模态遮挡沿用现有流程。

依据现有 UI 规范与 ui-ux-pro-max 的可访问名称建议，保留图标和文字，按钮宽度随内容。更新现有 video-collection-entry-ui 回归，确认库内无入口，探索在 1280／900／700 窗口宽度打开／关闭弹窗且保持探索面板。该回归与 tsc --noEmit 通过；未调用真实下载或更新安装包。
