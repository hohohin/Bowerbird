# Bowerbird Collect（浏览器扩展）

源码版本 0.5.3，Manifest V3。Chrome / Edge 需支持 WebCrypto Ed25519，并与带配对功能的桌面版配套使用。

## 安装与更新

1. 启动 Bowerbird 桌面应用，从「探索 → 浏览器插件」查看状态、安装或更新教程并复制扩展目录。开发时可直接加载唯一源码目录 `apps/extension`。原来加载 `Windows/extension` 的浏览器需要改为加载新目录并重新配对。
2. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`；开启「开发者模式」，选择「加载已解压的扩展程序」，粘贴扩展目录。
3. 在支持的网页打开 Bowerbird 菜单 →「设置」，复制配对码，到桌面「探索 → 浏览器插件」粘贴并确认。设置中的完整选项页与浏览器的「扩展选项」是同一入口，可查看和重置配对码。重置后需在桌面重新确认。桌面保存一份公钥，配对另一浏览器安装会替换旧授权。
4. 更新桌面安装包或扩展源码后，在浏览器扩展管理页点「重新加载」，再刷新待采集网页。新的桌面版本会在检测到版本落后的插件时显示更新指引。
5. 桌面安装包的 `extension/` 由打包读取同一份源码。通过浏览器扩展详情确认正在加载的目录。切换到新目录时，浏览器可能分配新的扩展 ID，此时需重新配对。

## 使用与归属

- 点击页面中的 Bowerbird 按钮，从二级菜单选择「采集本页图片」，确认后逐张采集本页发现的图片；按钮和菜单项均支持键盘 Enter / Space。
- 菜单中的「设置」可查看并复制配对码、恢复按钮默认位置，或为当前网站隐藏悬浮按钮。点击浏览器工具栏中的 Bowerbird 图标可恢复本站悬浮按钮，或打开当前页菜单。面板底部显示当前版本。
- 按钮可拖动调整位置，纵向按视口比例保存。拖到左右边缘会吸附并自动收起，悬停、聚焦或拖入文件时展开。
- 将图片拖到按钮，或按住 Alt 点击图片，可直接采集。支持普通图片、CSS 背景、页面 blob/data 图片；Alt 点击可导出且未受跨域保护的 Canvas 也可采集。被透明覆盖层挡住、自身 `pointer-events:none` 的图片（如 Instagram）会按点击位置找回并采集。
- 视频与图片一样，拖到 Bowerbird 图标即可直接采集。普通点击播放与播放器控制条保持；同次拖动或采集中重复投放不会重复提交。
- 选择「采集本页视频」或 Alt 点击视频可查看候选再选取，不会自动下载所有视频。采集中有持续状态，保持网页打开直到回执；本版不提供传给桌面后的取消。
- 通用网页和小红书每批最多 100 张。采集中点「停止」可中止接下来的读取和保存，已发送的图片等待桌面回执。界面显示已保存、明确失败、待确认和未采集数量。同页一次只处理一批。
- 打开左键菜单或设置时，首项显示桌面当前项目。采集的图片进入该项目的素材库，并出现在画布上；同一素材已有可见卡片时保留其位置。没有已保存项目时进入收集箱。每张图片上传时由桌面确定归属，批量期间请保持目标项目不变。
- 「重试失败项」只重新提交明确失败的图片。回执丢失或超时的图片标记为待确认，先到桌面素材库查看。

## 图片发现

通用候选来自 IMG/currentSrc、srcset/picture、lazy 属性、CSS 背景、OG/Twitter、JSON-LD、poster/SVG image 和开放 Shadow DOM。同一 IMG 尽量只选择一个较清晰版本。采集保留 `srcset` 候选 URL 自带的逗号，拖拽 HTML 内的图片优先于包裹它的商品页链接。扫描范围为当前页面已加载的内容和开放 Shadow DOM。

远程 AVIF 和 HEIC 按文件内容识别，即使 CDN 返回 `application/octet-stream`。浏览器将 AVIF/AVIS 的第一帧转为 PNG，保留网页来源。HEIC 沿用桌面已有的图片归一化流程。

小红书优先读取页面已有结构化数据：发现页采集笔记封面，图文详情按 imageList 顺序取图；SPA 状态缺失时重新读取当前公开详情 HTML，再回退可见轮播 DOM。图片入口保留采集视频封面的行为；「采集本页视频」另从详情公开 stream 数据或页面播放器中发现视频。图片地址与笔记来源 URL 分别保留。

## 视频发现与边界

候选来自 VIDEO/currentSrc/source、OG/Twitter 视频、JSON-LD VideoObject、开放 Shadow DOM 和小红书详情的公开视频流。实际文件 blob 在所属页面读取，HTTP(S) 文件由后台沿浏览器会话下载；不导出 Cookie。不进入跨域 iframe，也不自动滚动页面或嗅探所有网络请求。

支持完整视频文件，单条上限 200 MiB、浏览器读取最多 120 秒，桌面入库等待最多 180 秒。HLS/DASH 播放列表、MediaSource 临时流及受保护的视频会明确提示，不将封面或网页 HTML 当作视频成功入库。站点未公开可下载文件时，需要换用可用直链或桌面的抖音采集入口。

桌面按真实容器和视频轨道校验，保存原文件、封面、尺寸、时长及网页来源。相同内容沿用原素材，保留已有名称与来源；新增采集来源另存于 `analyses(kind=extension_capture)`。项目归属在收到上传元数据时冻结，入库期间切换项目不会改投。

## 当前通信

- 桌面在 `ws://127.0.0.1:39871/ws` 接收采集，最多同时 4 条连接。扩展后台从同一监听器的 `/pairing-session` 读取当前会话标识，复用已导入的签名密钥，签名同时绑定会话、用途、Origin、时间与单次随机数。重启桌面或重新配对即撤销已有证明。
- 可见网页按需请求后台心跳，后台合并整个扩展安装的请求，每 15 秒最多送出一次心跳并在 `ping` 中上报扩展版本。所有可采集页面关闭或隐藏后，桌面在约 30 秒无活动时清除连接状态。
- 网页中的图片与视频选择、确认、Alt 点击和投放仅响应浏览器派发的真实用户输入。可用鼠标或键盘激活按钮，后台心跳只检查连接能力。
- 悬浮入口的拖动位置经后台 `button_position_get` / `button_position_set` 读写 `chrome.storage.local`；配对后存储仅限受信扩展上下文，内容脚本也只经后台转发。
- 设置面板经后台 `pairing_code_get` 读取公开配对码；私钥仍只存受信扩展存储区，配对码本身不授予采集权限。
- 页面读取 blob/data/Canvas 时，后台根据浏览器报告的来源签发一次性上传凭据，页面只可协商能力、上传单份文件。扩展签名私钥只存浏览器受信扩展存储区。
- 兼容 URL 下载逐跳解析并固定到公网地址，直连而不交给代理重新解析。日常 HTTP(S) 图片仍由浏览器会话取图，可沿用系统代理。
- HTTP(S) 图片由后台用当前浏览器会话读取，可携带对应站点 Cookie。批量最多同时读取 4 张，按候选顺序通过同一条 WebSocket 逐张保存。连接断开后，后续图片可在新连接保存。已发送且未收到回执的图片标记为待确认。
- blob/data 图片在所属页面读取字节，Canvas 由页面导出 PNG。所有图片最终均经 `save_blob` 元数据 + 图片二进制两帧上传；桌面根据实际字节校验并入库、去重。主链不会让桌面再次下载图片 URL。
- 视频上传先协商桌面能力。支持 `capabilities.video_stream_upload` 时，依次发送 `save_blob_start` 元数据、最大 1 MiB 的二进制分片和 `save_blob_end` 总字节数，每片等待桌面确认再继续。桌面暂存分片，在结束后校验和入库。只支持 `video_blob` 的桌面继续接收原先包含整段视频的 `save_blob` 二帧上传。

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
node --test apps/extension/candidate-utils.test.js apps/extension/collection.test.js apps/extension/preferences.test.js
node apps/extension/collection-ui.test.mjs
node apps/extension/avif-native.test.mjs
node --test apps/extension/video.test.js
node apps/extension/video-ui.test.mjs
node apps/extension/video-drag-ui.test.mjs
```

UI 测试使用仓库已有 Playwright 和独立无头 Chrome，网页、后台与 WebSocket 均为本地合成夹具；不连接用户 Bowerbird、不操作用户浏览器或素材库。

原生协议验收：在 `apps/desktop/src-tauri` 运行 `cargo build --locked --offline --no-default-features --example collect_video_smoke`，再在 `apps/desktop` 运行 `node scripts/video-extension-native.test.mjs`。它执行真实扩展后台、随机 localhost WebSocket、桌面接收与临时 SQLite 入库，并解码保存的视频；覆盖精确去重／来源保留、图片兼容和伪视频拒绝。专用 AppData、禁用自动理解、无生产 setup。真实站点登录、用户浏览器重载及正式安装包仍须实机验证。

配对专项验收使用同一原生夹具，执行 `node scripts/extension-pair-native.test.mjs`。它在独立 Chromium 配置中安装测试副本、从扩展选项取得公钥、重启浏览器，再把网页 Canvas 保存进临时库。如需指定支持加载解压扩展的 Chromium，可设置 `BOWERBIRD_TEST_CHROMIUM` 指向测试浏览器可执行文件。

多标签页和批量性能使用 `node scripts/extension-multitab-native.test.mjs`。它在临时 Chromium 和本机原生夹具中记录 20 个标签页的配对与 WebSocket 心跳，检查桌面超时状态，与 0.5.2 对比固定网络延迟下保存 50 张图片的耗时和连接数，并验证 AVIF 经扩展保存到临时库。

有公网时，在同一原生夹具追加参数 `--live-cdn` 可验证带逗号的公开 Cloudinary `srcset`，比对扩展实际读取的高分辨率候选及入库尺寸。
