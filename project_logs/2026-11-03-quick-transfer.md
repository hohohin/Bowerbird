# LocalSend 快传开发行动记录

日期：2026-11-03（北京时间）。用户已选择 LocalSend，并要求使用 ub-mode 推进开发。手机扫码打开浏览器，无需安装 App。

## 范围与验收

- 显式开启局域网接收，文件完整落到真实收件目录后复用连接式素材索引；保留手机实际上传原件。
- 首版只收素材到全局收件目录，不同步画板、账号或跨设备创作资料。HTTP 网页模式不声称加密，不承诺断点续传。
- 界面先独立网页示意并验证，按 PROJECT.md 约定经用户确认后接入正式入口。
- 验证包括临时文件/SQLite、实际 HTTP 上传、拒绝未配对与非法文件、关闭/中断、不覆盖同名文件、幂等登记及恢复。真机与安装包验收单列。

## 行动

1. 阅读 ub-mode、PROJECT 当前状态/约定、开发架构、文件连接、错误展示、UI 规范及 Windows 开发说明；复核研究结论对应本地实现，避免复用已停用的旧上传 IPC。
2. 检查 dev 分支与工作区：已有其他任务未提交修改及大量历史临时文件。保留这些内容；只编辑、提交本任务文件/精确补丁。既有工作树用途未确认，不执行清理。
3. 并行分工：固定 LocalSend 源码及接收适配、原件存储和索引、独立桌面/手机预览；根负责生命周期、命令、集成与复核。每项先用行为测试证明缺口。
4. 发现工具清单没有 crapper/dryer/mutator，但历史日志指向本机 `.tmp/ub-tools`；检查可用安装后按真实支持范围调用，不将空报告计作通过。
5. 固定 LocalSend v1.18.2 Rust 核心、Apache-2.0 许可、原始逐文件哈希及四文件适配补丁。仅开启选定私有 IPv4 上的接收服务，未打开现有扩展 loopback 服务或公网中继。
6. 存储、传输与整合分别先观察未实现行为测试失败，再完成实现。使用真实临时目录／SQLite／HTTP 验证完整文件持久回执、原件发布和索引；HTTP 成功不提前于 Ready 记录持久化。
7. 独立审查复现未限制 Host／跨源取消，以及未上传批次占住槽位；收紧 Host、Origin、路由和配对认证，加入闲置超时。原始 60 秒配置下独立验证会话释放，半传 socket 保持开启时下一批次仍可开始。
8. 新增延迟取消回归，先观察已入库结果被覆盖为 Failed；修复为以 Ready／Saved／Indexed 持久事实为准，完整收件不被网络取消撤销。实际红测和最终绿测均来自隔离测试 exe。
9. 提供独立电脑／手机示意，覆盖深浅色、390px、传输／完成／中断／关闭、目录冻结和收起语义；已向用户展示并请求确认，尚未收到界面确认，不挂载正式组件。
10. 对接显式 start／status／stop／retry IPC、单会话生命周期与素材变更事件；复用连接 GATE 串行入库，应用启动不监听。通过限定源码的质量扫描按职责拆分高复杂函数，保持行为测试通过。
11. Windows 测试主程序缺少 Common Controls v6 清单导致启动失败，沿仓库既有方法仅给 `.tmp/quick-transfer-runtime/` 下的 exe 副本嵌入清单；不修改正式构建脚本或应用。受沙箱文件／socket 权限影响的验证经自动审批后在隔离临时目录重跑，不将环境失败计作功能通过。
12. 只清理已核实归属本任务的 vendor 构建产物；保留其他任务工作树和临时文件。更新专项协议、PROJECT 决策与 AGENTS 文档索引；交付前精确审查差异，提交本任务源码和记录。
13. 扩大编译检查到 all-targets 时发现 `collect_video_smoke` 通过 path 引入全套 commands，却遗漏新 quick_transfer 与既有 external_drag 根模块；补齐该隔离夹具的两个声明。依赖核对发现旧 Rust 1.85 声明不符合锁定依赖：既有多项要求1.88，新 uuid要求1.89；声明改为本轮实际验证的1.90，没有安装或升级系统工具链。
14. 为后续二进制分发在 Tauri resources 映射 LocalSend 原始 LICENSE 与本地修改说明到 `licenses/localsend/`；本轮只核对配置，不打包或发布。

## 验证与交付

- `cargo test --locked --offline --lib --manifest-path apps/desktop/src-tauri/Cargo.toml quick_transfer --no-run`：编译成功。带清单副本 `.tmp/quick-transfer-runtime/tests-final.exe quick_transfer --nocapture`：**23 passed / 0 failed**（存储11、协议9、整合3）。覆盖认证、限制、半传、关闭监听、持久回执、恢复、同名保护、HEIC原件及伪装媒体拒绝。
- 同一测试副本运行 `folder_connections core::external_files::`：**72 passed / 0 failed / 2 ignored**；忽略项为 Windows Shell 真缓存与需本机 FFmpeg 的既有测试。
- 扩大 `cargo check --locked --offline --all-targets` 未全绿：既有 `video_probe_smoke` 缺 audio、`replication_browser_smoke` 缺 source_browser_jobs、`pinterest_native_fixture` 被独立编译时缺 crate 根模块。没有扩大本任务修改这些无关夹具；正式库、二进制和本次直接影响的 collect_video_smoke 单独验证。
- `cargo check --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --lib --bins --example collect_video_smoke`：**通过**，保留既有未使用项警告；未启动该夹具或正式应用。
- 独立真实 HTTP 审查：**3 passed / 0 failed，63.02秒**；保留原始60秒超时验证。详见 [审查记录](2026-11-03-quick-transfer-review.md)。
- 官方默认上传页在隔离 Rust 服务（upload_page=None、正式 CSP／Host／Origin限制）与390×844 headless Chrome中真实选文件上传成功：HTTP200、1/1文件、pageerror为空，服务端校验原字节及回执。该项验证真实网页协议，不等同于Safari／Android真机。
- 独立界面候选 capture 验证通过，真实网络请求为零；仅为示意，不把占位二维码或示意进度称为已完成手机接收。详见 [界面记录](2026-11-03-quick-transfer-ui.md)。
- 官方 crapper／dryer／mutator 扫描最终限定快照：所有函数 **CC ≤ 9**，dryer **0.8** 阈值无重复；mutator **174** 个生产候选站点。没有覆盖率数据，CRAP／Coverage 为 N/A；未执行变异，不宣称杀死率或完整质量门禁已满足。源码哈希和实际命令见 `.tmp/quick-transfer-quality/`，持久结论见 [存储记录](2026-11-03-quick-transfer-storage.md)。

本阶段交付接收后端、命令与可审查的独立界面候选。正式界面仍等待用户确认；尚未进行真实手机扫码、Windows防火墙交互、Mac原生及安装包验收，未操作用户素材库、替换运行实例或发布安装包。网页HTTP不加密，没有断点续传。

其他分工记录：[传输](2026-11-03-quick-transfer-transport.md) · [存储](2026-11-03-quick-transfer-storage.md) · [审查](2026-11-03-quick-transfer-review.md) · [界面](2026-11-03-quick-transfer-ui.md)。
