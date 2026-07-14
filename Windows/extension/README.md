# Bowerbird Collect（浏览器扩展）

采集网页图片到本地 Bowerbird 桌面应用。Manifest V3，原生 JS（无构建步骤）。

## 通信

- 桌面端启动时在 `ws://127.0.0.1:39871/ws` 监听
- content script 把图片地址交给扩展后台；扩展后台使用当前浏览器会话读取图片字节
- 扩展后台先发 `save_blob` 元数据，再发 WebSocket 二进制帧；桌面端直接入库（含 pHash 去重），不再二次下载 URL

## 使用

1. **先启动 Bowerbird 桌面应用**（它会监听 WS 端口）
2. Chrome / Edge：打开 `chrome://extensions` → 打开「开发者模式」→ 「加载已解压的扩展程序」→ 选本目录（`Windows/extension`）
3. 在任意网页：
   - **把图片拖到右下角 Bowerbird Logo** → 采集该图片（支持一次拖入多张）
   - **点 Bowerbird Logo** → 弹出确认卡片，点「采集」后批量保存本页所有图片
   - 按住 **Alt + 点击图片** → 保存单张

## 协议

```jsonc
// 浏览器 → 桌面（两帧组成一次采集）
{ "type": "ping" }
{ "type": "save_blob", "url": "https://.../x.jpg", "page_url": "https://...", "file_name": "x.jpg", "content_type": "image/jpeg" }
<图片二进制帧>

// 桌面 → 浏览器
{ "ok": true, "pong": true }
{ "ok": true, "asset_id": "...", "name": "..." }
{ "ok": false, "error": "..." }
```

> 更新扩展文件后，必须在 `chrome://extensions` 或 `edge://extensions` 中点一次“重新加载”，并刷新待采集网页。失败原因会直接显示在网页提示中。
