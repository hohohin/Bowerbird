# 快传正式组件隔离验证

该入口直接导入 `src/components/QuickTransferPanel.tsx`，只模拟 Tauri IPC；不会开启接收服务、写入文件或访问真实资料库。剪贴板也使用内存模拟。

在 `apps/desktop` 执行：

```sh
node --experimental-strip-types --test scripts/quick-transfer-state.test.mjs
node scripts/quick-transfer-desktop.test.mjs
node scripts/quick-transfer-thumbnails.test.mjs
node scripts/quick-transfer-bundle.test.mjs
```

浏览器用例使用临时 `127.0.0.1:1598` Vite 和无头 Chrome，结束自动退出。截图位于 `.tmp/quick-transfer-desktop/`；构建依赖核对位于 `.tmp/quick-transfer-desktop-bundle/modules.json`。测试固定使用虚构目录和私网地址。

缩略图专项使用独立端口1603，读取合成PNG像素验证图片/视频封面映射，并覆盖迟到回包、收起取消、按需加载和四并发；截图位于`.tmp/quick-transfer-thumbnails/`，不读取真实素材。

在已经运行的隔离 Vite 中可打开 `/scripts/fixtures/quick-transfer-desktop/preview.html`。可用参数：`?theme=light`、`?offline`。正式组件默认使用BowerbirdLibrary/快传，直接开启接收；展示手机二维码和电脑可输入的地址／配对码。不把测试入口当作真实上传页面。
