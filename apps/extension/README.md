# Bowerbird Collect（浏览器扩展）

0.2.0，Manifest V3、原生 JavaScript，无构建步骤。用于从 Chrome / Edge 采集网页图片到本机 Bowerbird。

## 安装与更新

1. 先启动 Bowerbird 桌面应用；从「探索 → 浏览器插件」查看配置状态、安装或更新教程并复制扩展目录，或使用源码目录 `apps/extension`。`Windows/extension` 是与其同步的独立加载副本，只需安装其中一份。
2. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`；开启「开发者模式」，选择「加载已解压的扩展程序」，粘贴扩展目录。
3. 更新文件后，在扩展管理页点击「重新加载」，再刷新所有待采集网页。只更新磁盘文件不会替换已打开页面中的旧脚本。避免同时启用旧版或重复副本。

## 使用与归属

- 点击网页右下角 Bowerbird 按钮，确认后逐张采集本页发现的图片；按钮支持键盘 Enter / Space。
- 将图片拖到按钮，或按住 Alt 点击图片，可直接采集。支持普通图片、CSS 背景、页面 blob/data 图片；Alt 点击可导出且未受跨域保护的 Canvas 也可采集。
- 通用网页和小红书每批最多 100 张。界面显示已处理进度、已保存数量、明确失败及待确认数量；正在采集时同页其他采集入口不会重复提交。
- 采集进入桌面当前已保存项目的素材库；没有已保存项目时进入收集箱。需要放到画板时，再从素材库拖入。每张图片上传时由桌面确定归属，批量期间请保持目标项目不变。
- 部分失败不会回滚已保存图片。回执丢失或超时时，先查看桌面素材库，不要整批重复采集。需要重试时，只重试尚未保存的图片。

## 图片发现

通用候选来自 IMG/currentSrc、srcset/picture、lazy 属性、CSS 背景、OG/Twitter、JSON-LD、poster/SVG image 和开放 Shadow DOM。同一 IMG 尽量只选择一个较清晰版本；拖拽 HTML 内的图片优先于包裹它的商品页链接。不会自动滚动页面、进入跨域 iframe 或穿透 closed Shadow DOM。

小红书优先读取页面已有结构化数据：发现页采集笔记封面，图文详情按 imageList 顺序取图；SPA 状态缺失时重新读取当前公开详情 HTML，再回退可见轮播 DOM。视频笔记仅收集封面，不下载视频。图片地址与笔记来源 URL 分别保留；本次不扩展标题、作者等入库字段。

## 当前通信

- 桌面在 `ws://127.0.0.1:39871/ws` 接收采集；页面每 15 秒发送独立 ping，表示连接可达。
- HTTP(S) 图片由 content script 发 `save_image` 给后台；后台通过当前浏览器会话 fetch（沿用浏览器网络环境，允许发送相应网站 Cookie），不导出 Cookie。
- blob/data 图片在所属页面读取字节，Canvas 由页面导出 PNG。所有图片最终均经 `save_blob` 元数据 + 图片二进制两帧上传；桌面根据实际字节校验并入库、去重。主链不会让桌面再次下载图片 URL。

```jsonc
// 浏览器 → 桌面：先发元数据，再发一帧图片字节
{
  "type": "save_blob",
  "requested_url": "https://cdn.example/image.jpg",
  "effective_url": "https://cdn.example/image.jpg",
  "page_url": "https://example.com/page",
  "url": "https://cdn.example/image.jpg",
  "file_name": "image.jpg",
  "content_type": "image/jpeg",
  "candidate_source": "srcset"
}
// 下一帧：图片二进制
// 桌面回执
{ "ok": true, "asset_id": "...", "name": "..." }
{ "ok": false, "error": "..." }
```

HTTP(S) 图片上限 50 MiB，页面内嵌图片/Canvas 上限 20 MiB；HTML 主图回退最多 2 MiB、只跟进一层。浏览器取图最多 45 秒，桌面回执最多 60 秒，页面等待后台为 110 秒，覆盖两个阶段。界面只显示固定中文错误指引，不展示原始异常、路径或 URL。

## 隔离验证

在仓库根目录运行：

```sh
node --test apps/extension/candidate-utils.test.js apps/extension/collection.test.js
node apps/extension/collection-ui.test.mjs
```

后者使用仓库已有 Playwright 和独立无头 Chrome，网页、后台与 WebSocket 均为本地合成夹具；不连接真实 Bowerbird、不操作用户浏览器或素材库。真实站点登录、浏览器安装与桌面入库仍需实机验证。
