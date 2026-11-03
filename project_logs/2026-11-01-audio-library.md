# 音频素材库正式接入

用户已确认独立预览，授权正式实装。沿用 ub-mode：真实失败测试、最小实现、逐项验证。原件原位连接；波形点击临时试听，移出停止；左下按钮从零持续播放，新播放替换旧声音。

## 执行记录

- 阅读 PROJECT.md、开发计划、FOLDER-MODE 与错误提示规范，核对当前连接式素材库和共享卡片入口。工作区存在大量既有未提交修改，将本轮会修改的文件先备份到 `.tmp/audio-library-integration-baseline/`，按文件划分前后端任务，保留已有改动。
- 确定命令 `audio_waveform(assetId, expectedVersion?)`，返回实际源版本与有界峰值。只对已登记素材请求；两项并发、128 MiB 专用派生缓存预算。目录扫描只登记和校验原件，不解码整库音频。前端仅可见请求、64 项峰值缓存、共享一个播放器。
- 首版识别 WAV、MP3、FLAC、M4A、OGG；实际解码与平台播放分别验证，不承诺 raw AAC 或 Opus。现有图片筛选不能继续把所有非视频视作图片，音频不能进入图片参考/分类链路。
- Crapper、Dryer、Mutator 工具在本会话不可用；不报告虚构评分。改用实际行为测试、类型检查、Rust 检查与人工局部复核。

- 前端先运行真实 RED：三种媒体分离、音频独立导航和图片输入拦截均失败；加入音频类型与边界后 GREEN。正式库夹具原来没有音频入口，入口断言 RED 后接通，不使用独立旧预览来冒充实装。
- 后端先跑音频登记、筛选、服务版本与缓存测试 RED；接通轻量原位登记和命令后 GREEN。额外发现浮点 WAV 可以超出 [-1,1]，前后端约束不一致；用 ±2 样本及越界缓存复现后，将显示峰值截断并校验，缓存算法升级 v3。
- 根代理接通三种媒体切换、各自视图、原位拖入导航、全部／标签／真实目录集合、卡片、详情时长及手动标签。音频卡在图片预览 hook 前分流；图片生成、画板图片投递、反推与自动分类保持排除音频。
- 单播放器不归虚拟卡片所有，按钮持续播放跨滚动、换视图和关闭详情保留。按已确认的交互修正测试中的错误旧预期：切到图片不应强停持续播放。同源 seek 不重设 src，延迟原件响应不能复活旧声音。
- 只读审查找到实际选中崩溃：音频卡缺少既有选中标记测量用的 `.folder-media-preview`。正式卡片选择测试重现 getComputedStyle(null) 后补齐节点合同。随后修复时长回传的数字去重：每次接受波形结果、只在父组件时长不同时回填，覆盖相同素材刷新和等时长素材复用。
- 多选模式不启动／定位音频，但已在播放的暂停按钮仍能使用；实际 RED→GREEN 验证波形选择点击不 seek、不额外播放、暂停不冒泡成选择。
- Windows 文件操作前，按素材或目录停止关联播放，释放句柄；兼容普通路径、extended drive 与 UNC，严格匹配目录段。只删除外部记录、项目关系或分身不停止原件；无关目录不受影响。真实菜单／改名／删除对话框断言在 IPC 发生前播放器已释放。
- 全局 TypeScript 在 sandbox 内曾错误解析 ProseMirror 类型（16 条错误）；直接本机同一 `tsc --noEmit` 通过，不改无关编辑器代码。类型检查及 Vite 独立临时输出构建通过。
- 相关 Node 回归最初发现新纯函数 import 缺少 `.ts` 导致原生 Node loader 失败；按仓库允许的显式 TS 扩展名修正后，媒体／瀑布流／目录排序／视频生成与恢复共 **43/43** 通过。
- Rust 全 core 回归 **534 passed / 0 failed / 12 ignored**；media 回归 **42/42**。忽略项含真实模型、Shell 与独立性能项，未把忽略当成功。

## 正式服务性能测量

Windows 本机、未优化 Cargo **debug**，临时 SQLite 与缓存目录，链接既有合成文件。下表冷测量包含实际正式服务的源指纹检查与解码；热测量为五次服务调用均值，不含 IPC、画布绘制或声卡出声。热请求的测试 decoder 一旦调用即 panic，故明确验证没有重复解码。

| 合成文件 | 首次生成（debug） | 热缓存均值 | 缓存大小 |
|---|---:|---:|---:|
| 1 小时 MP3 | 104.38 s | 2.014 ms | 35,700 B |
| 1 小时 FLAC | 34.32 s | 2.194 ms | 35,938 B |
| 10 分钟 WAV | 6.23 s | 2.477 ms | 47,789 B |

三个原件的前后 SHA256 完全相同，素材副本数为零。首次长音频波形并非即时完成，需后台生成；以上 debug 冷耗时不能当作发布版指标。此前独立 release spike 的 1 小时 MP3 约 2.04 s 是另一实现阶段／构建范围，不能移作正式全应用延迟。本轮未构建发布安装包，也未量声卡首次出声。

证据：`.tmp/audio-library-integration-baseline/backend-{core-green,media-green,service-performance}.log` 与 `backend-service-performance.json`；新边界失败日志为 `backend-audio-red.log`。正式播放器组件的 RED→GREEN 细节另见 `apps/desktop/scripts/fixtures/audio-waveform-production/AGENT-LOG.md`。

## 最终验收

- `cargo check --locked --offline` **PASS**，只含原有 warning；日志 `backend-cargo-check.log`。
- 最终 `tsc --noEmit` **PASS**；独立 Vite production build **PASS**（2041 模块，保留既有大 chunk 提示，未为本任务拆改全应用打包）。
- `audio-waveform-ui.test.mjs` **PASS**：正式 React.StrictMode 组件、共享原生 HTMLAudioElement、真实 WAV。创建播放器 1 个、波形最大在途 2；覆盖失败重试、版本、延迟响应、同源定位、可见订阅取消、键盘、暂停及选择。IPC 波形使用与合成原件一致的 peaks，不冒充 native command 集成。
- `audio-library-ui.test.mjs` **PASS**：正式 Toolbar／LibraryHome／AssetDetail／ContextMenu／FileDrop 组合。1206 项合成记录只挂载 50 卡片，30 个可视波形请求，分页最多 60 项。悬浮不请求原件；原位 drop 与集合分身无 bytes 导入；手动标签、集合连续目录顺序、三种媒体、详情、选中后暂停、改名及删除释放均通过。最终 `pageerror=[]`、未知 IPC `[]`。
- 正式组件真实播放：WAV 点击时间 5.991 → 6.209 秒，1 小时 MP3 点击 1791.832 → 1792.044 秒；二者同源点击均无 loadstart。软件事件 click→playing 为 7.3／27.5 ms，**不是**声卡首次出声延迟，也不包含首次波形生成时间。显式播放产生 14 条 HTTP Range 请求。
- 已查看正式库全部视图深浅色和集合／详情截图。证据目录 `apps/desktop/.tmp/audio-library/` 含 `result.json`、`audio-all-dark.png`、`audio-all-light.png`、`collections-dark.png`、`detail-dark.png`。播放器组件的独立结果位于 `apps/desktop/.tmp/audio-waveform-production/`。
- 正式源码已接入，未操作真实用户库、未发安装包、未执行 Mac 原生或正式完整 Tauri 应用端到端验收；前阶段的 WebView2 spike 仍单独留作历史证据。

## 提交与范围

开工时已有第 6 步未提交的 `connected_media.rs`、分类变更重排与目录扫描前置；它们是音频入口的实际依赖。并行工作又提交了侧栏动效和界面文本选择修复。不能将本轮差分独立提交到当前 HEAD 后声称依赖完整，也不能整文件暂存而夹带 watcher、Codex updater、SVG 缓存、生成恢复等工作。因此保留音频专用基线差分与文件哈希清单，不混合提交或重置既有修改。

此前向共享 `dev` 的推送已被自动审批拒绝，原因是远端归属未核实且会夹带其他提交；本轮没有重试，也没有改用另一分支绕过。用户的“实装”授权用于本地实现，不视作对那次远端推送问题的回答。

本轮 72 个源码／测试／文档文件的增量已保存为 `project_logs/2026-11-01-audio-library.patch`，对应哈希清单为 `project_logs/2026-11-01-audio-library-files.json`。这是相对于逐文件开工快照的差分，**不能直接当作干净 HEAD 的完整补丁**；上述第 6 步前置需保留。PROJECT／AGENTS 只提取本轮音频段落，排除并行任务的文档更新。复现生成器在 `.tmp/audio-library-integration-baseline/capture-audio-delta.mjs`，未暂存任何文件。

测试启动的浏览器和服务由各脚本 finally 关闭，先前用户音频预览服务及其合成媒体保持可用。保留本轮基线、结果截图和最后一次独立构建用于复核；不清理其他任务的未提交工作。
