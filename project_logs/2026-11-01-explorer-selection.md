# 2026-11-01 探索笔记拖选穿透修复

## 范围与根因

用户报告：探索页小红书打开笔记后，按住拖选正文会采集笔记下的信息流图片。只修改共享网页注入脚本的媒体命中和本次手势判断，不修改采集接收协议、扩展、素材入库或站点账号。

原脚本先把 `elementsFromPoint` 的文字、面板、遮罩过滤掉，再取剩下的图片／视频；祖先回退同样只判断图片矩形。`pointerdown` 因此将正文设成 draggable，`dragstart` 还可重新寻找媒体，将文字操作转换为采集。

现保留完整命中栈，按实际文字 Range 矩形阻止正文穿透，并让不透明／固定面板、对话框和输入控件成为遮挡边界。同一卡片的空透明覆盖层保留拖图代理。按下时冻结本次是否命中媒体，正文手势不会在起拖时重新拾图。`pointer-events:none` 的单候选图片临时参与同步命中查询，随后完整恢复内联样式。

## 操作记录

| 步骤 | 操作与原因 |
| --- | --- |
| 1 | 按 ub-mode 读取项目约定、架构、探索／扩展文档与 Windows 验证入口；检查工作区，保留既有画板测试、截图、DSH 配置等无关修改。 |
| 2 | 分工只读定位、独立测试和质量工具核验。注入生产脚本，以真实鼠标／原生拖放复现，避免手造拖动载荷。 |
| 3 | 原实现上首批 8 场景为 **5 failed / 3 passed**；取消注入的对照页 5 个负向场景保持正常文字行为，确认不是测试本身禁用了文字选择。 |
| 4 | 保留遮挡栈并冻结手势后首批通过。审查发现简单“包含文字”会误伤图外标题和视频后备文字，补充边界后为 **10 passed / 3 failed**。 |
| 5 | 改为实际文字矩形；识别背景 alpha=0；同步恢复禁止指针命中的图片以查询绘制顺序。**13/13** 通过。 |
| 6 | 补充透明 A 链接覆盖图，验证图片地址与 `/pin/42` 来源链接保持；**14/14** 通过。 |
| 7 | 旧 `explorer-drag.test.mjs` 链接覆盖场景、`explorer-video-drag.test.mjs` overlay 场景本机挂起。冻结未修改 HEAD 的有界复跑同样挂在 CDP `mousePressed`，不归因于本修复、不计通过。仅清理本次明确 PID 的测试树，新链接覆盖回归独立通过。 |
| 8 | 编译 `explorer_smoke` 时生成 PDB 损坏；仅将该 PDB 移为备份后重新编译成功。隐藏 WebView2 新增正文拖选，连同原图片／视频、Cookie、来源、权限、重开／滚动和引导遮罩回归通过。使用独立资料和本机合成站点，未打开用户库。 |
| 9 | 最终只读审查提出整体 `opacity:0` 的空渐变覆盖层兼容点；新增用例先得到 **14 passed / 1 failed**，允许整体透明的同卡空覆盖层后 **15/15** 通过。最终源码重新构建并复跑 WebView2 通过。 |
| 10 | 更新 PROJECT 踩坑与探索协议，检查最终 diff；代码、测试和文档同次提交，只提交本任务文件。 |

## 验证

从 `apps/desktop` 执行：

| 检查 | 最终结果 |
| --- | --- |
| `node scripts/explorer-selection-drag.test.mjs` | **15/15 passed，exit 0**。包括正文／已选文字、面板空白／遮罩、信息流及笔记图、轮播、视频后备文字、禁指针图片、图外标题、alpha=0／opacity=0 覆盖层和链接来源。 |
| `cargo build --locked --offline --manifest-path src-tauri/Cargo.toml --example explorer_smoke` | 最终重建 **exit 0**；既有 Rust 未使用项警告保留。等待现有开发构建释放锁，没有停止其他会话的编译或进程。 |
| `node --experimental-strip-types scripts/verify-native-explorer.mjs src-tauri/target/debug/examples/explorer_smoke.exe` | **exit 0**；`noteTextSelectionWithoutCapture:true`，原生图片／视频、带 Cookie 跨源取回、来源、远程 IPC 拒绝、重开／重启及引导遮罩回归通过。最终独立资料 `.tmp/explorer-native-1793548394868`。 |
| `node --check` 与本任务 `git diff --check` | 通过。 |

最终产品 JS 工作区 SHA256：`0a9a0d338a8236ae7aa3469a08759d70f14bed3e1e831fde13903b88a6a5b8a6`。浏览器结果与负向手势载荷在 `apps/desktop/.tmp/explorer-selection/`，均为合成内容。

质量工具沿用 `.tmp/ub-tools` 的官方源码与既有 Windows 适配：crapper `6fd92c4c`、dryer `66ff6d21`、mutator `a5a0cb80`。实际调用记录在 `.tmp/explorer-selection/quality.md`。crapper／mutator 缺 JavaScript grammar，dryer 该版本不发现 `.js`；字节不变的临时 `.ts` 探针又因 IIFE 内嵌函数不进入提取而得到空报告。未把这些空结果算作通过，未宣称 CRAP <10、无重复或 mutation score，也未为指标改写产品脚本或增加项目依赖。

## 边界

- 未操作真实小红书页面／账号，未模拟 Windows OS 物理跨窗口拖放，Mac 原生未验收。
- 本轮覆盖当前可见轮播，以及单个 `pointer-events:none` 媒体。多张禁止指针命中的媒体同时可见且 DOM 与 z-index 顺序相反时，旧祖先回退仍可能选择 DOM 尾项，本轮未扩展处理。
- 脚本由 Rust `include_str!` 嵌入，需重新构建并运行后端、重新加载探索网页才使用新版本；前端热更新不足。仅构建隔离验证程序，未发布或安装正式包。
- 测试浏览器与原生夹具均正常退出。临时诊断、独立资料和 PDB 备份留在 `.tmp`／构建目录，不提交，不清理用户工作区与无关文件。
