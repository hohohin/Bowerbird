# 快传传输层行动记录

- 读取 ub-mode、PROJECT 当前进展/约定与开发计划；确认仅负责传输适配及固定上游，不改现有素材、公共入口或其他并行工作。
- 只读核验现有 Cargo 配置与工具链：Rust stable 1.90.0。源码网络访问先在沙箱失败，获自动审批后仅下载官方 Git 仓库固定标签 v1.18.2，提交 af0416be50770a97760f7070684bc667b759a15c；无全局工具链变更。
- 单独拷贝官方 packages/core 与 Apache-2.0 LICENSE 到 vendor/localsend-core，隔离 `cargo +stable check --features http` 成功。官网固定工具链是 1.97.1，但本机 1.90.0 编译该 http 核心通过；尚不能据此宣称更低 MSRV。
- 先定义接收事件契约与真实 HTTP 行为测试。Prepare 的受控 staging 路径由入库层提供，传输层不自行选择正式目标。Received 只代表完整传到电脑，入库另由父层执行。
- TDD：两个初始真实 HTTP 测试先因未实现接收器失败，再实现最小官方核心适配。沙箱阻止本机客户端连接，自动审批后在 127.0.0.1 与 tempfile 目录运行，认证上传/关闭端口转绿。
- 增加尺寸/校验和/路径/元数据上限和停止回归；准备中的停止测试先暴露缺失失败事件，再将停止纳入准备等待流程，转绿。测试审查发现临时目录用 `_` 解构会提前销毁，改为保留绑定，避免把无法创建文件误计作尺寸/校验和失败。
- 独立审查定位旧核心的 Host/跨源取消暴露，新增失败测试复现 Host 返回 200，再收紧实际接收监听的路由、Host、Origin 和取消配对认证，专项转绿。
- 文件流由适配层持有，create_new 防止覆盖；逐块限额、长度/可选 SHA256 检查，flush/sync 并等待 OS 句柄关闭后发 Received。Received 需应用回执：持久 Ready 事实成功才返回 HTTP 200，入库另行执行；新增测试证明回执前 HTTP 不提前成功、回执失败返回 500。
- 进度按每文件 150ms 节流，最后完整字节帧不丢弃。关闭服务等待全部 writer 结束；授权 cancel 的真实半传测试先复现等待闲置才停，增加会话取消通道及上游 writer 提前失败监听后转绿。
- 独立复核在原始 60 秒配置下验证未开始上传与停滞 body 均释放协议会话，后续上传可继续；来源 agent 记录由根汇总。适配层分离会话管理、manifest/name 边界、流写入及完整性验证；不宣称没有 coverage 数据的 CRAP 达标。
- 固定上游、许可和逐文件 SHA256 记录到 vendor/localsend-core/UPSTREAM.json 与 README.bowerbird.md。未 commit/push，公共入口与最终存档由根处理。
- 最终传输专项：`cargo +stable test --manifest-path .tmp/quick-transfer-transport-tests/Cargo.toml --offline --lib` **9 passed / 0 failed**。覆盖认证完整上传、非法类型/路径/元数据限额、真实尺寸与hash不符及拒绝重放、停止准备回调、半传关闭、持久回执前禁止HTTP成功、跨源/Host/路由隔离、认证cancel硬停。独立专项用固定core和实际transport文件编译，无用户库、用户原件或真实手机数据。
- 交付前校验目录归属后只清除本任务 vendor 下的 standalone target/Cargo.lock/examples/tests；保留 runtime源码/assets/LICENSE/Cargo、原始hash、四文件补丁与说明，`.gitignore` 防止未来构建产物入库。专项测试自己的 `.tmp` 构建目录仍保留供根复核，未清理其他任务产物。
- 官方质量工具最终隔离复扫：transport 每函数 CC ≤ 9（配置验证9、清单验证8、分块写入8），dryer threshold 0.8 无重复。未生成 coverage，因此 CRAP / Coverage 为 N/A；mutator 仅扫描站点，不宣称 mutation testing 完成。证据在 `.tmp/quick-transfer-quality/`，由根统一报告边界。
- 交付前范围复核：vendor LICENSE 与官方原始字节一致，61 条原始文件哈希匹配；实际差异仅 Cargo.toml 与 3 个接收安全修改文件，BOWERBIRD.patch 与全部差异逐字一致，无构建文件夹带。证据 `.tmp/quick-transfer-quality/vendor-scope.json`。
- 官方默认网页真实验收：隔离接收器 `upload_page=None`，headless Chrome 390×844，实际 Host/Origin/CSP/no-store/no-referrer 开启；通过文件 input 触发原版 JS 准备/上传，HTTP 200、进度 1/1、无 pageerror，并核对服务端接收字节和回执。证据 `.tmp/quick-transfer-browser/`；这是 Chromium 适配验证，不等同 iPhone/Android 实机或正式确认界面。
- MSRV 审查：Windows Cargo metadata 显示旧 HEAD 已存在需要 Rust 1.88 的依赖，本次新增/升级 rcgen、sha2、time 同样要求 1.88，uuid 1.29.0 要求 1.89。原应用声明 `rust-version=1.85` 与实际依赖不符，根已将声明修正为受验 Rust 1.90；本任务不升级全局工具链，也不宣称 1.85 可构建。
- 新增依赖许可声明复核：相对 HEAD 锁文件 67 个新增/升级 name+version，65 个属于当前 Windows metadata 图；这些包声明为 MIT / Apache-2.0 / BSD-3-Clause / ISC 或其 OR 组合，LocalSend manifest 唯一缺少 license 字段，已用固定上游根 Apache-2.0 原文补证。另外两个非当前 Windows 图包，以 docs.rs 精确发布版 Cargo.toml 补查：fiat-crypto 0.3.0 为 MIT OR Apache-2.0 OR BSD-1-Clause，unicode-width 0.2.1 为 MIT OR Apache-2.0。未发现非商用、GPL/AGPL 等强 copyleft 声明；这是包级声明核对，不是完整源码/NOTICE审计或法律结论。证据 `.tmp/quick-transfer-quality/new-package-licenses.json`。根负责将 LocalSend LICENSE 与修改说明实际纳入 Tauri bundle resources；本轮未再次编译。
