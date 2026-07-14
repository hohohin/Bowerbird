# Bowerbird Collect（浏览器扩展）

采集网页图片到本地 Bowerbird 桌面应用。Manifest V3，原生 JS（无构建步骤）。

小红书适配（P0）：

- `xiaohongshu.com/explore`：读取页面结构化 feed，只采集笔记封面；滚动后新增卡片用笔记链接内主图补齐，不采头像与页面装饰。
- 图文详情页：读取 `noteDetailMap.note.imageList`，按原顺序采集完整图片列表；SPA 状态未写回首屏 script 时以 `credentials: omit` 重取当前公开详情 HTML，失败再回退当前轮播图 DOM。
- 视频笔记：发现页只采集封面，不下载视频文件。
- 不读取 Cookie、不调用私有 API；图片下载 URL 与笔记来源 URL 分开传给桌面端。

## 通信

- 桌面端启动时在 `ws://127.0.0.1:39871/ws` 监听
- content script 直连该 WS，批量发 `{ type: "save_batch", items }`，桌面端顺序下载入库（含 dHash 去重）

## 使用

1. **先启动 Bowerbird 桌面应用**（它会监听 WS 端口）
2. Chrome / Edge：打开 `chrome://extensions` → 打开「开发者模式」→ 「加载已解压的扩展程序」→ 选本目录（`apps/extension`）
3. 在任意网页：
   - **把图片拖到右下角 Bowerbird Logo** → 采集该图片（支持一次拖入多张）
   - **点 Bowerbird Logo** → 弹出确认卡片；小红书采集笔记封面/详情全图，其他站点批量保存本页图片
   - 按住 **Alt + 点击图片** → 保存单张

## 协议

```jsonc
// 浏览器 → 桌面
{ "type": "ping" }
{ "type": "save", "url": "https://.../x.jpg", "page_url": "https://..." }
{
  "type": "save_batch",
  "source_site": "xiaohongshu",
  "items": [{
    "media_url": "https://sns-webpic-...",
    "source_url": "https://www.xiaohongshu.com/explore/<note-id>",
    "source_id": "<note-id>",
    "index": 0,
    "total": 10,
    "media_kind": "image"
  }]
}

// 桌面 → 浏览器
{ "ok": true, "pong": true }
{ "ok": true, "asset_id": "...", "name": "..." }
{ "ok": true, "saved": 10, "total": 10, "results": [{ "ok": true, "asset_id": "..." }] }
{ "ok": false, "error": "..." }
```

桌面下载器复用连接、带 UA/Referer，按响应内容识别真实图片格式，单文件上限 50 MiB；不发送 Cookie，不支持断点续传。
