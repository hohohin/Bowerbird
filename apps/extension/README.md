# Bowerbird Collect（浏览器扩展）

采集网页图片到本地 Bowerbird 桌面应用。Manifest V3，原生 JS（无构建步骤）。

## 通信

- 桌面端启动时在 `ws://127.0.0.1:39871/ws` 监听
- content script 直连该 WS，发 `{ type: "save", url, page_url }`，桌面端下载入库（含 pHash 去重）

## 使用

1. **先启动 Bowerbird 桌面应用**（它会监听 WS 端口）
2. Chrome / Edge：打开 `chrome://extensions` → 打开「开发者模式」→ 「加载已解压的扩展程序」→ 选本目录（`apps/extension`）
3. 在任意网页：
   - **把图片拖到右下角 🐦** → 采集该图片（支持一次拖入多张）
   - **点 🐦** → 弹出确认卡片，点「采集」后批量保存本页所有图片
   - 按住 **Alt + 点击图片** → 保存单张

## 协议

```jsonc
// 浏览器 → 桌面
{ "type": "ping" }
{ "type": "save", "url": "https://.../x.jpg", "page_url": "https://..." }

// 桌面 → 浏览器
{ "ok": true, "pong": true }
{ "ok": true, "asset_id": "...", "name": "..." }
{ "ok": false, "error": "..." }
```

> Phase 1 简化版：直链下载，不含防盗链 / 断点续传 / UA·Referer·Cookie 伪装（计划 §6 远期）。
