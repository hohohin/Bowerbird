# 2026-11-04 探索视频真实站点复核

用户反馈 9d809e90 后仍提示「尚未找到当前视频的分段清单，请播放视频后重新拖入」。上一轮合成测试通过不能证明真实网页已覆盖，本轮以真实页面定位，再补回归。

## 实际根因与修改

1. 复读当前探索／视频契约及 ub-mode，继续复用 `source_browser_video.js` 和既有 WebView2 网络／FFmpeg 通路；没有新增下载器、模型服务或账号数据导出。
2. 用 computer-use 查看正在运行的 Bowerbird，原页面为小红书笔记 `6ae99d430000000010013711`。开发者工具属于另一个进程，读取授权超时；没有绕过其工具授权，改由开发源码临时启用仅本机调试端口 9578，使用现有登录探索 WebView2 做程序诊断。没有读取、复制 Cookie，也没有操作登录或安全限制页面。
3. 真实页面播放完整 MP4 的字节范围，元素显示 Blob／MSE。先看到初始应用状态含 Vue Ref 与依赖图，补了 ID 索引与有界 Ref 解包；该缺口用大状态夹具稳定复现，但它不是后续真实失败笔记的直接原因。
4. 通过信息流打开真实笔记 `6aeaf4ce000000001b031b8b`，**再次复现原错误**。旧全局扫描能找到 2 个匹配记录，仍解析失败；实际 `video.media.stream` 的键及 `videoCodec` 值为 EF4／EF5／EF6／EF7，旧代码只查 h264／h265／av1。真实失败摘要在 `.tmp/explorer-video-live/spa-result.json`，结构诊断只输出媒体字段和去签名地址。
5. `noteVideoUrls` 遍历已明确匹配笔记的所有数组流分组，读取 masterUrl／master_url／url；不推断 EF 编码含义、不选择最近的任意网络视频。普通 URL 字段兜底保持。先按站点 ID 索引查初始数据，再回到既有有界扫描；对 Ref 仅有界读取 value，明确 noteId 与索引冲突仍拒绝。
6. 修复后重新从信息流进入同一笔记，分组仍为 EF，旧命名分组候选数为 0，新解析返回完整 MP4 地址。截图／用户内容未加入 Git，最终源码未保留默认调试端口，`source_browser.rs` 与本轮基线一致。

## 真实网络取回

使用与生产 `source_browser_network.rs` 相同的 `Page.getFrameTree → Network.loadNetworkResource(includeCredentials=true, disableCache=false) → IO.read` 通路，完整字节保存在本轮工作区临时目录，HTTP 200；随后以本机 ffprobe 和 FFmpeg 全片解码。没有把 Cookie 传到其他进程或网络服务。

| 来源 | 元素来源 | 完整字节 | 时长 | 音视频 |
|---|---|---:|---:|---|
| 小红书 6aeaf4ce000000001b031b8b | Blob／MediaSource | 12,259,844 | 40.800 秒 | 720×1280 + 音轨，全片解码通过 |
| Pinterest 664281013778109217 | Blob／MediaSource | 18,403,864 | 57.700 秒 | 1080×1920 + 音轨，全片解码通过 |
| Pinterest 1084663891475263837 | HTTP MP4 | 4,221,910 | 14.900 秒 | 640×1138 + 音轨，全片解码通过 |

摘要：`.tmp/explorer-video-live/xhs-capture.json`、`pin-blob-capture.json`、`pin-capture.json`；真实解析前后对照：`spa-result.json`、`live-after.json`。恢复浏览时也确认原先打开的小红书笔记能解析到完整 MP4。记录不包含 URL 签名、Cookie 或完整账号数据。

## 自动验证及边界

- `source-browser-video-sites.test.mjs`：增加 EF 真结构、大响应式状态（两站点）、索引键与显式 noteId 冲突；EF 和大状态均先失败再通过。11 组专项通过。
- `source-browser-video.test.mjs`：普通 Blob、MSE 分段关联、压缩、陈旧页面和多源拒绝回归通过。
- `verify-native-video-stream.mjs`：最终源码重编译后通过；小红书样例改用 EF 分组，两站点分别验证响应缓存和大状态索引。取回完整视频、HLS／DASH、分离音轨、时长、全片解码及取消／缺片／基址拒绝均通过。原生隔离验证目录为 `apps/desktop/.tmp/video-stream-native-1793791525125`。
- ub-mode：归属本轮及前轮源解析辅助函数的原字节／原行号隔离分析，真实 V8 覆盖率映射 LCOV，13 个辅助函数 CRAP 1–9；Dryer ≥0.8 无重复候选。7 项官方 Mutator 目标变异击杀，包含视频地址选择、Ref 判定、站点索引、身份及大小保护；不宣称全文件穷尽变异。
- 本轮只修改注入 JS、专项测试与文档，不再重复运行上轮已记录受其他创作编辑器改动阻断的全项目 TypeScript／旧 UI 夹具。
- 尝试过一次 Windows 物理拖动，但未形成可确认的新采集记录，未将其计作真实素材库保存验收。上表验证的是**真实播放器来源解析、同浏览器网络完整取回及解码**；原生任务／分段处理继续由隔离夹具验收。没有向用户素材库写入测试视频。
- 运行中的开发版已重建并重启，核对 EXE 内包含最终注入脚本；本机 9578 调试端口无监听，探索页已恢复到原先打开的小红书笔记。未发安装包，Mac 原生与用户实际拖入后保存仍需各自实机验收。
- 没有新建 worktree，夹具结束时关闭自身进程；验证后清理本轮下载的三条临时 MP4（约 34.9 MB），保留结构诊断、取回与解码摘要，未清理其他会话文件。
