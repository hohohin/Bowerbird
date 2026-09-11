# 视频与 FFmpeg 本地集成 v3

> 后续状态（2026-09-11）：0058、VPS 视频 Worker 与 Edge 已上线，尚未启价/真实生成验收；部署指纹、验证边界与回滚见 [当前视频部署记录](VIDEO-API-INTEGRATION.md#2026-09-11-云端同步部署)。下文保留 2026-09-06 本地集成时的原始事实。

执行任务：01a075d3-a061-76f0-b987-4329e8ac74a6；结果版本 video-api-integration-v3。

## 范围与编号

本轮把视频 API 增量与 ffmpeg-discovery-v1 串联，保留保存项目全部既有 UI、画板、素材库与 Harness 变化。视频基础提交 522a26d、准备提交 c7d9ad9；FFmpeg 交付提交 887b119c420addf3b3adfd2008f2a917ee932a00，仅取其经过 before/after 校验的 6 文件补丁。

视频迁移最终编号为 **0058_video_generation_jobs.sql**。主目录原至 0056，但已知尚未集成的 Harness 交付占用 0057_agent_automatic_review.sql，因此不能按主目录缺席推断 0057 空闲。已向 Harness 经理及视频经理确认保留 0058；没有集成对方自动审批或 Codex 改动，没有执行云迁移。

v2 的原 ready.patch 含旧编号，现已废止。v2 manifest 标记 superseded，校验工具会拒绝它。使用本轮 `VIDEO-API-INTEGRATION-V3.json`，按 **api-ready.patch → ffmpeg-ready.patch** 顺序；before、api、after 三个阶段都有逐文件 SHA-256 校验。

## 集成与验证结果

2026-09-06 已在经理授权的共享写入窗口合入 `D:/H/Project/Bowerbird`。两段补丁先在独立仓库副本重放，再对主目录完成 before → api → after 各 70 项哈希校验；共 71 个管理路径（含 manifest 自身），原始字节及缺失状态已记录到 rollback。另核对 785 个原有文件逐字节未变，0057 Harness 预留路径未被改动，旧视频 0057 文件不存在。主目录保留为增量工作区变更，没有提交或覆盖其他任务代码。

从保存项目当前工作区只读复制 835 个代码/配置/测试文件（不含凭据、缓存、构建产物和临时目录），先应用视频补丁再应用 FFmpeg 补丁。三个原 media 文件及三个新增文件均匹配对方 manifest。视频迁移已同步为 0058，隔离 SQL 测试通过。

合并代码通过 308 项 Rust 库测试（3 默认忽略）、124 项画板及视频/编辑器测试、桌面与 Worker 类型检查；真实 MP4 入库、时长/尺寸探测和 JPEG 海报测试单独通过。真实测试使用实际用户环境，没有给 FFmpeg 注入 PATH，也未设置工具覆盖变量；合成样本与 SQLite 只写测试临时目录。测试样本生成也使用统一解析器，不再让测试自己依赖裸 ffmpeg。

FFmpeg 预检、metadata 与海报共享绝对路径解析器；保留 Windows 子进程隐藏、两个组件检查与首帧回退。未安装软件、未改全局或用户 PATH，没有为 Cloud 另造检测器，VPS 的 ffprobe 部署依赖不属于这次桌面修复。

实际合入后，主目录再通过桌面/Worker TypeScript、124 项桌面测试、22 项 Worker/验收脚本测试、两个 Cloud 入口 Deno 检查、0058 PGlite SQL 测试与 Vite 构建。完整 Tauri `cargo build --offline -j 1` 成功，单独将本包 debug 信息设为 0 以避免内存峰值；依赖沿用原配置，产物输出到本任务独立 target，没有覆盖主目录正在使用的 exe。构建只有已有 Rust 警告及 Vite 包体积提示。308 项 Rust 与真实 MP4 测试针对逐文件匹配主目录的合并源码副本完成。

## 集成与回滚规则

经理已协调 UI/Harness 共享源码窗口，由本任务作为唯一执行者。应用前重新核对所有写入路径及缺失文件；任何漂移先重算，禁止强推。快照记录原始字节和缺失状态，回滚仅恢复本任务写入文件；当前内容若不属于本次 before/api/after 状态就停止，不能覆盖别人后续修改。

本 worktree `.tmp/video-api/integration-v3/` 保存两份补丁、摘要、source-snapshot、rollback 与验证日志。补丁不随部署执行，不提交主项目中他人的未提交代码。

```text
node <verify-video-integration.mjs> <VIDEO-API-INTEGRATION-V3.json> <target> before
# snapshot → api-ready.patch
node <verify-video-integration.mjs> <VIDEO-API-INTEGRATION-V3.json> <target> api
# ffmpeg-ready.patch
node <verify-video-integration.mjs> <VIDEO-API-INTEGRATION-V3.json> <target> after
```

## Tauri 与真实 API 边界

前序检查发现用户已有 Tauri 实例运行于主项目旧 debug 路径。没有关闭、重启或向它发送生成请求，也未启动新构建；新源码/新编译产物不能改变既有进程已加载的代码。应用还包含单实例、启动时恢复任务及自定义协议注册，因此不把额外启动同标识实例当成无副作用探测。

已准备后续操作：由经理确认用户实例中的生成任务已结束，再批准关闭该实例并启动新构建；在实际 GUI 中走不产生 provider 请求的工具/媒体检查，并确认探测与海报均成功。当前没有这项重启授权，**不能宣称运行中的 GUI 已生效**。

原唯一一次真实视频提交仍 outcome_unknown，没有第二次鉴权实测或 POST。最小验收脚本及一次提交门闩保留；后续费用核对、Cloud 全链路、正式价格和上线另由经理安排。本轮不部署、不发包、不启价、不购买或充值。
