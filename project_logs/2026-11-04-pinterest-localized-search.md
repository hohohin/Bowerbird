# Pinterest 中文以图搜图修复

## 诊断与复用

- 用户反馈仍停在「正在准备搜图」。按明确调用的 ub-mode 执行；读取项目进展／约定、架构复用地图、内置浏览器、Windows、错误展示与视觉规范。记忆索引无相关记录。
- 核对当前开发实例：`target/debug/bowerbird-desktop.exe`，01:11:10 构建、01:11:13 启动；二进制内包含修改前完整适配器，排除“上次源码根本没重建”的猜测。默认沙箱看不到宿主进程，获准后只读查询宿主；未把沙箱返回空视为应用退出。
- 使用 computer-use 只读查看探索：页面已到搜图超时，网站仍展示普通 Pinterest 内容。无障碍树明确给出中文按钮名称 `Pinterest 镜头`，代码却只查 `button[aria-label="Lens"]`。旧公开 bundle 也显示按钮标签经过翻译函数，原英文夹具没有覆盖这项变化。
- 前两轮修复的共同前提是“所有账号的 Lens 入口都可用英文精确标签定位”。网站掌握语言与标签，适配器硬编码英文、测试也硬编码英文，导致双方测试自洽却漏掉用户中文页面。本轮把已观察到的中英文入口纳入同一选择器，同时用于打开入口和识别登录后页面。
- 复用 `source_browser_pinterest.js`、现有 Rust 素材准备／导航／通知、专属 Lens input、现有 Chromium 和 WebView2 验证入口；不新增接口、上传通道或公共抽象，不改搜图结果布局与采集。
- 运行一个独立资料、临时库、合成图片的真实站点诊断：Pinterest 未登录页正常收到 `preparing → waiting-login`，适配器存在，网页时间与系统时间吻合；未发现足以修改文档时间门槛或通知桥的证据。未登录访问没有上传图片，不等于真实登录搜图验收。
- 另尝试前台查看后续状态；遇到用户正在输入后停止界面操作，没有点击搜图、操作账号或上传用户图片。

## 改动与红绿证据

- 正式脚本仅新增共享中英文按钮选择器，两处调用改为复用它。文件交付仍严格限定 `input#lens-file-upload[type="file"][data-test-id="lens-file-upload"]`。
- 新增中文入口行为测试：自动打开一次、交付 `search.png`、由网站 change handler 进入结果路由，旁边 Pin 创建 input 收到零文件。额外覆盖登录元数据仍为 false 但真实按钮已经出现。
- 初版中文测试遗漏 HTML UTF-8 声明，中文文本被解码错误，不能当作产品红测。补正确编码后，使用 HEAD 原脚本再次执行：点击 0、文件 0、状态 0，按预期失败；新脚本同一测试通过。已有英文、登录、取消、重复请求、迟到文档及站外边界回归通过，共 10 组。
- 原生红测保留同一慢资源夹具，仅改为真实观察到的中文按钮并声明 UTF-8。旧 EXE 在页面可操作／加载完毕两种状态均未传图，只有 `preparing`；结果 `apps/desktop/.tmp/pinterest-loading-native-1793727297748/result.json`。
- 离线缓存重建 `pinterest_search_smoke` 后绿测：无关资源仍 pending、文档 interactive、`loadFired=false` 时，收到一张 PNG 并进入 `/lens-search/?synthetic=loading`，通知为 `preparing → searching → submitted`。结果 `apps/desktop/.tmp/pinterest-loading-native-1793727393508/result.json`。
- 完整 `pinterest-search-native.test.mjs` 通过：登录续办、文件字节、跨文档结果不重传、请求防重／替换／取消、外部登录返回边界。隔离本地进程与服务已退出。

## 质量与交付边界

- 使用已安装的官方 crapper／dryer／mutator。临时按原行号与字节提取 8 个命名 helper，仅作为指标输入；正式完整 IIFE 在 Chromium 实际运行，22 份 V8 记录转 LCOV，整段实测行覆盖 98%，交付异常 catch 未覆盖。helper 最大 CRAP 9.0，严格阈值 9.99 通过；dryer 0.8 无重复。不是整个匿名 IIFE 的 CRAP，也不宣称完整分支覆盖。
- 官方 mutator 发现 49 个原始位点，执行交付标记／结果路由／hydration 重试 3 个针对性变异，3 个均被正式行为断言杀死；不是全量变异评分。独立回退中英文选择器的 HEAD 控制也失败。正式适配器 SHA256：`b1d39229210d19fcbfbc670c2d4dd284f3de34cb1e626f757c4cac9fd89acf81`。
- 质量证据在 `.tmp/pinterest-current/quality/`；真实未登录原生诊断在 `.tmp/pinterest-current/live-*`。这些临时目录没有加入 Git。
- 仅本次明确源文件、测试和文档提交；其他聊天的创作预览／素材库修改保持原归属。检查已有 worktree，本轮未新建，无可确认属于本轮的废弃 worktree；不清理其他任务工作区。
- 当前修复已通过隔离原生验证，真实用户账号完整上传、其他本地化名称、Mac 原生尚未验收。未发布安装包；JavaScript 通过 Rust `include_str!` 编入 EXE，前端热更新不能使运行中的旧脚本生效，需要重建并重启开发程序。
- 已完成开发主程序构建：`apps/desktop/src-tauri/target-local-classification/debug/bowerbird-desktop.exe`，2026-11-04 01:38:33、104972800 bytes。当时询问是否更新并重启，未把等待回复当成重启授权；后续实际运行状态见下条。
- 用户回复「现在更新并重启」后重新核验，发现开发监视器已在 01:34:44 自动重建默认 `target/debug/bowerbird-desktop.exe`，01:34:47 启动新 PID 48124（父进程为 `cargo run --no-default-features`），原 PID 24196 已退出。运行文件完整包含本次已验证适配器，SHA256 `22875f70ef0de67ffc0733c8a7ddfa1f8cc91f6993f725851d194adb82c85337`；与独立构建目录的二进制哈希不同，不据此误判为旧脚本。Vite 1420 端口正常，原生窗口与素材库内容已打开。前次回复“当前程序尚未更新”没有重新核对自动重启，现更正为开发实例已加载修复；无需再替换和重复中断。真实账号上传的验收边界仍保持。
