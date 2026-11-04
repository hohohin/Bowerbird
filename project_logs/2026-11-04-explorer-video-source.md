# 2026-11-04 探索视频采集来源修复

用户反馈：小红书与 Pinterest 的视频拖入后都提示「尚未找到当前视频的分段清单，请播放视频后重新拖入」。控件问题已解决，本轮只改视频来源识别和验证。

## 定位与复用

- 阅读 ub-mode、PROJECT 当前约定、开发计划与复用地图、EMBEDDED-BROWSER、VIDEO-MEDIA、USER-FACING-ERRORS、Windows 运行说明；复用 `source_browser_video.js`、拖拽协议、原生 network／stream 与采集记录，没有新增下载器或站点外解析服务。
- 确认报错来自 `resolve`，发生在原生下载前。原代码按请求时 location 丢弃 SPA 切页后的 JSON，并对 JSON XHR 强制要求未压缩且有长度头；只保留最近 12 个任意 JSON 响应，统计请求也会挤掉视频数据。
- 补齐小红书 API 的 `note_card` 包装，以及 Pinterest 视频与同卡片链接互为兄弟元素的情况。只在当前卡片内确认唯一媒体身份，不能借相邻卡片或页面其他视频补齐。
- 查阅 [yt-dlp 小红书解析器](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/xiaohongshu.py) 和 [Pinterest 解析器](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/pinterest.py)，核对 stream／video_list 格式；未接入该项目或复制其下载通路。

## 修改与红绿

1. 新增 `source-browser-video-sites.test.mjs`：原代码在两站点压缩 JSON、响应晚于 SPA 切页、小红书包装／搜索路径、Pinterest 卡片识别用例失败，复现同一错误。无关笔记和超大 JSON 保持拒绝。
2. 视频记录按站点与明确 ID 缓存，最多 128 条；以实际解码 JSON 检查上限，移除压缩／无长度头的误拒绝。统计响应不占视频缓存。后续简略记录没有地址时仍可使用同一身份的初始数据；该边界同样先红后绿。
3. 卡片内唯一链接提供拖动的 pageUrl；兼容小红书 search_result 与 Pinterest slug Pin。保持原始拖动类型与 Blob URL，封面仍只供拖影。
4. MSE 关联仍要求同一个 MediaSource 的实际追加缓冲区命中清单；解除同文档 SPA 地址改变造成的失联，不使用最后一个清单兜底。拖动后换页、视频元素替换、媒体保护与多源歧义检查保持。
5. JSON 上限的变异初次存活，增加恰好 1 MiB 的包含边界测试后击杀。没有为了指标删除有效保护或重写下载流程。

## 验证

- `node scripts/source-browser-video-sites.test.mjs`：8 组通过，包含浏览器真实拖动、SPA 请求竞态、压缩／无长度 JSON、无关响应、同 ID 简略记录、错笔记拒绝和大小边界。
- `node scripts/source-browser-video.test.mjs`：普通 Blob 字节、有界读取、当前笔记／Pin、真实 MSE 追加缓冲区跨 SPA 清单关联、多清单歧义和旧文档拒绝通过。
- `node scripts/explorer-video-drag.test.mjs`：10 类真实拖动载荷通过。
- `cargo build --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --target-dir apps/desktop/src-tauri/target-local-classification --example explorer_smoke` 通过。
- `node scripts/verify-native-video-stream.mjs`：合成小红书 Blob → JSON → 完整 MP4 字节一致；合成 Pinterest Blob → JSON → HLS → MP4 的完整时长、声音与全片解码通过。原 HLS、分离音轨、DASH、gzip、浏览器 Cookie 跨源读取、取消、部分响应拒绝、缺片拒绝、未确认清单基址拒绝继续通过。最终隔离资料：`apps/desktop/.tmp/video-stream-native-1793787242840/`。
- ub-mode 工具：9 个归属本次改动的辅助函数用原字节／原行号隔离副本分析，V8 浏览器覆盖率转换 LCOV，CRAP 1.0–9.0；Dryer ≥0.8 无重复候选。Mutator 官方生成／应用的 4 项目标变异全部击杀；不是全文件穷尽变异。辅助证据在 `.tmp/explorer-video-source/`；只变异隔离副本，不改运行源码。
- 全项目 TypeScript 检查被当前工作区 creation／WorkflowPromptEditor 的 Transaction 类型及 platejs 导出问题阻断；本轮没有修改这些文件。旧 `explorer-video-ui.test.mjs` 完成前面的画板视频交付／落点／项目隔离检查，但重新载入探索夹具后找不到「探索」按钮而超时，未记作全套 UI 通过，也未夹带修改该夹具。

## 生效与边界

- 开发监视器自动重建并重启 `apps/desktop/src-tauri/target/debug/bowerbird-desktop.exe`；已检查实际二进制含最终 `acceptNote` 与视频身份缓存代码。最终源文件修改后的 EXE 写入时间为 2026-11-04 18:12:55（北京时间）。未发布安装包、未改数据库或用户素材。
- 用户提供笔记 `6aea9804000000000f01e2e8`；隔离浏览器返回小红书「当前网络存在风险」安全限制。公开 Pinterest 样本显示登录界面。没有绕过这些限制、复制用户 Cookie 或将合成验证当作真实账号验收；不在记录中保存链接令牌。
- Mac 的共享注入脚本同步生效范围仅到源码，未做 Mac 原生测试。Worker／转封装后无法跟踪字节且页面也没有明确媒体数据的来源，仍可能被拒绝；本轮不靠猜测网络地址放开混采。
- 未创建新 worktree；测试子进程由夹具退出流程清理。保留本轮隔离证据目录，未清理其他会话或用户资料。
