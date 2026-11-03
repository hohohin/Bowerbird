# 快传交互示意

直接打开 `preview.html`，无需安装依赖或启动服务。文件内包含全部样式、脚本及图标，不读取文件内容、不发起上传、不使用真实账号或素材库。二维码是不可连接的占位图；顶部保留“交互示意 · 不会上传文件”。

- 默认并排展示电脑快传弹层、手机上传页；顶部可选电脑／手机，以及等待、传输、完成、中断、关闭状态和深浅主题。
- URL 支持 `?view=mobile&theme=light&state=complete`；`view` 可为 `both/desktop/mobile`，`state` 可为 `ready/sending/complete/interrupted/off`。
- 选择文件仅读取名称、大小和 MIME，状态／进度是示意值。地址按钮不写剪贴板；更改目录只切换示意文字。
- 电脑收起面板保持接收状态，关闭接收才停用手机动作；传输中接收目录固定。中断显示重新发送，不宣称断点续传。
- 2026-11-03 用户已确认此稿可以接入。本页保留为冻结示意；正式入口与接收状态以 `QuickTransferPanel` 和内嵌 `quick_transfer/upload.html` 为准。

验证：在仓库根目录运行 `node apps/desktop/scripts/fixtures/quick-transfer-preview/capture.mjs`，使用已有 `apps/html-renderer/node_modules/playwright`。浏览器在 `finally` 关闭，无预览服务、文件监听或常驻进程。截图及报告位于 `apps/desktop/.tmp/quick-transfer-preview/`。

行动记录：`project_logs/2026-11-03-quick-transfer-ui.md`。
