# Seedance 2.5 视频接入与验收记录

> 日期：2026-09-06。状态：本地接入、自动回归与合成媒体验收完成；真实即梦生成及 Tauri 原生 UI 待验。
> 本次用户已确认使用即梦官方 Dreamina CLI 路线；不扩展方舟托管视频 adapter。
> 本文记录本专项的接口核验与验收证据；项目全局决策仍以 [PROJECT.md](../PROJECT.md) 为准。

## 1. 范围与依据

应用接入 `seedance2.5` 文生视频、单图生视频、首尾帧生视频和全能参考四种模式。沿用现有本机即梦登录态、生成队列、持久化和项目画板归属。

本次明确指定 Seedance 2.5：请求必须显式传 `--model_version seedance2.5`；权限不足或服务暂不可用时说明原因，不能静默切换为 2.0/fast。历史 [VIDEO-GENERATION.md](VIDEO-GENERATION.md) 的 2026-08-06 spike 与五模式规划保留原文；本次不把固定模型的 `multiframe2video` 当作 Seedance 2.5 实现。

相关资料：

- [官方 Dreamina CLI 入口](https://jimeng.jianying.com/cli)。网页工具本次未成功提取入口内容，接口契约以已安装官方 CLI 的本机帮助输出为证。
- [AI provider 接入路线](AI-PROVIDERS.md) 与 [历史生成系统规划/spike](VIDEO-GENERATION.md)。
- [当前项目画板契约](PROJECT-CANVAS-PLAN.md)。

## 2. 官方 CLI 本机核验

2026-09-06 只读运行了以下命令，未发起生成、未上传参考素材、未扣生成积分：

```powershell
& "$env:USERPROFILE/bin/dreamina.exe" version
& "$env:USERPROFILE/bin/dreamina.exe" text2video -h
& "$env:USERPROFILE/bin/dreamina.exe" image2video -h
& "$env:USERPROFILE/bin/dreamina.exe" frames2video -h
& "$env:USERPROFILE/bin/dreamina.exe" multimodal2video -h
& "$env:USERPROFILE/bin/dreamina.exe" query_result -h
```

本机位置：`C:\Users\Hins\bin\dreamina.exe`。

```json
{
  "version": "a857341-dirty",
  "commit": "a857341",
  "build_time": "2026-07-31T16:28:32Z"
}
```

四个模式的帮助均明确列出 `seedance2.5`。统一约束：**VIP-only、输出时长 4–30 秒、分辨率 480p 或 720p**；`--video_resolution` 必填。

| 模式 | 参考参数 | prompt | ratio | CLI 实际默认模型 |
|---|---|---|---|---|
| `text2video` | 无参考图 | 必填 `--prompt` | 可传；省略为 16:9 | `seedance2.0fast` |
| `image2video` | 一张 `--image` | 必填 `--prompt` | 不支持，按输入图推断 | `seedance2.0_vip` |
| `frames2video` | `--first` 与 `--last` | 可传 `--prompt` | 不支持，按首帧推断 | `seedance2.0_vip` |
| `multimodal2video` | 重复 `--image` / `--video` / `--audio` | 可传 `--prompt` | 可传；省略为 16:9 | `seedance2.0_vip` |

因此不能依赖 CLI 默认模型。历史文档“2.5 默认”不等于 CLI 当前帮助中的默认值；应用指定 2.5 才能确保用户选择得到准确执行。

可设置的比例仅六档：`1:1`、`3:4`、`16:9`、`4:3`、`9:16`、`21:9`。图片生成的 `2:3`、`3:2` 不适用于这里。

全能参考模式的 Seedance 2.5 帮助还列出：

- 最多 30 张图片、10 个视频、10 个音频，总输入最多 50 项。
- 支持纯音频输入；每条以及视频/音频总时长受 2–30 秒限制。
- 输入采用重复的单数参数 `--image`，不能误用图片生成的 `--images`。
- 以上是 CLI 完整能力，不代表本次 UI 已暴露视频/音频输入；应用首版输入范围应按最终实现与验收记录说明。

CLI 帮助明确说明：模型列表是公开支持集合，运行时可用性、输入上限与权限仍由后端配置决定。本次帮助核验不等于当前账户已经真实生成成功。

同日只读执行 `dreamina user_credit` 成功（exit 0）：当前登录态有效，返回 `vip_level=standard`、`total_credit=30`。该摘要不包含用户标识或凭据。此结果不足以认定账户已具备 Seedance 2.5 VIP 权限；不得沿用历史 spike 的 maestro 等级/余额作为本次验收前置，也未据此发起生成。

## 3. 异步查询、下载与错误边界

- `--poll N` 表示提交后每秒查询、最多等 N 秒；`--poll 0` 禁用此等待。应用应取得 `submit_id` 后尽快持久化，再进入后续查询。
- `query_result` 仅暴露 `--submit_id` 和 `--download_dir`。继续查询同一 `submit_id`，不能通过重新提交来模拟查询恢复。
- 所有四模式支持 `--session int`，默认 0。即梦会话 ID 与 Bowerbird 项目/创作线程归属不是同一个标识。
- 返回 `AigcComplianceConfirmationRequired` 时，官方帮助要求先到即梦 Web 使用该模型完成首次生成。
- 权限不足、积分不足、未登录和并发限制应保留可行动原因。Seedance 2.5 具体费用不能用旧 spike 中 2.0fast 的 10 积分直接代替。
- 本地停止不代表远端任务取消或退款；保留已提交 ID 供取回。
- 视频输出文件名、实际容器/编码、当前账户 2.5 费用与排队耗时尚无本次真实生成样例，不能写成已验证。

## 4. 验收清单

| 检查项 | 验收标准 | 本次状态 |
|---|---|---|
| 四模式命令 | 模式正确，显式 `seedance2.5`，拒绝静默降级 | Rust/前端专项通过 |
| 参数边界 | 4/30 秒接受，3/31 秒拒绝；仅 480p/720p | Rust/前端专项通过 |
| 比例 | 文生/全能参考六档；单图/首尾帧省略 ratio | Rust/前端专项通过 |
| 参考顺序 | 按编辑器顺序传入；首尾帧精确映射；不自动混入上轮图片 | Rust/前端专项通过 |
| 输入检查 | 无效路径、缺失素材、模式数量不符在提交前拒绝 | 已实现 preflight；数量/provider 前端与 Rust 回归通过 |
| 下载 | 只收集临时目录内允许的视频产物；图片不能假作视频成功 | Rust 扫描/离线协议回归通过；拒绝 symlink，保留准确临时根 |
| 队列与恢复 | 保存提交 ID；恢复按 job 媒体类型下载；不重复提交 | 离线 CLI 续查/取消/失败/未知状态测试通过；恢复取消链路已审查 |
| 入库 | MP4 可探测尺寸/时长，poster 实际存在且可解码 | 真实本地合成 MP4 单项通过 |
| 短视频与损坏文件 | <1 秒视频可抽帧；损坏 MP4 不成功入库 | 0.4 秒首帧回退、poster 解码及坏 MP4 拒绝通过 |
| 展示与历史 | 结果/历史/画板按视频渲染，重试保留模式与参数 | 参数/历史回归与真实 React 组件播放检查通过；完整桌面真机 UI 待验 |
| 图片回归 | 图片仍走原 provider，既有项目归属与续轮不受影响 | Rust 全量与前端既有 96 项回归通过 |
| 真实 2.5 生成 | 账户实际提交、成功下载与播放，核对实际计费 | 未执行 |

## 5. 实现入口与测试记录

源码入口（最终改动以 diff 为准）：

- [Dreamina provider](../apps/desktop/src-tauri/src/codex/jimeng.rs)、[共享请求类型](../apps/desktop/src-tauri/src/codex/types.rs)、[生成 IPC](../apps/desktop/src-tauri/src/commands/codex.rs)。
- [持久化生成队列](../apps/desktop/src-tauri/src/core/task_queue.rs)、[生成收尾与恢复](../apps/desktop/src-tauri/src/core/generation_worker.rs)、[资产入库](../apps/desktop/src-tauri/src/core/ingest.rs)。
- [视频元数据](../apps/desktop/src-tauri/src/media/probe.rs)、[视频缩略图](../apps/desktop/src-tauri/src/media/thumb.rs)。
- [创作板](../apps/desktop/src/components/CreationBoard.tsx)、[生成结果](../apps/desktop/src/components/GenerationPanel.tsx)、[前端状态](../apps/desktop/src/store.ts)。

本机初次检查时 `ffmpeg` 与 `ffprobe` 不在 PATH。[FFmpeg 官方下载页](https://ffmpeg.org/download.html) 只提供源码并列出 Windows 构建供应方；尝试从其推荐的 [gyan.dev Windows builds](https://www.gyan.dev/ffmpeg/builds/) 下载 release essentials，但连接低速/超时，后续原站与 GitHub 镜像 DNS 失败。下载未完成，**没有执行该未校验的下载包**。

最终测试工具使用本机既有 `D:\H\Project\ccHome\ScriptCut\src-tauri\binaries\` 中的 `ffmpeg-x86_64-pc-windows-msvc.exe` 和 `ffprobe-x86_64-pc-windows-msvc.exe`。只读核验版本均为 `8.0-full_build-www.gyan.dev`，复制到本仓 `.tmp/video-integration/tools/local/ffmpeg.exe` / `ffprobe.exe`；复制前后 SHA-256 一致。原项目文件未修改，只在测试进程临时设置 PATH，未全局安装。这是本地已有 sidecar 的复用与复制一致性检查，不宣称通过了本次网络下载的发布校验。

| 本地工具 | SHA-256 |
|---|---|
| ffmpeg.exe | `81B5832F6C548D64FEBA0EC7D643397E2351D9F3460A65C6C296956045EEBAEA` |
| ffprobe.exe | `421DBC81A3D758DFE114534FF48EF47A61EF91896EB4B9E819609A8752AB8272` |

2026-09-06 当前验证记录：

- Rust 全量：**284 passed / 0 failed / 3 ignored**。随后单独执行其中的本地合成短 MP4 测试，**1/1 通过**；另 2 个是既有 Agent Z 真机测试。
- 真实本地媒体验收：FFmpeg 合成 0.4 秒、120×240 的 MP4；`ingest_generated` 经 FFprobe 得到正确尺寸/时长，`source=jimeng` 与生成 session 关联正确；第 1 秒无帧时回退首帧，poster 可解码、最长边不超过 480，并完成提色。损坏 MP4 被拒绝，数据库素材数仍为 1。证据：`.tmp/video-integration/backend-media-test.log`；本测试不调用即梦或其他生成服务。
- Rust 视频专项覆盖四模式精确参数、时长/分辨率/模型/模式拒绝、引用顺序、视频下载扫描、失败原因、非法 JSON，以及视频参数的历史持久化。
- 离线 CLI 协议测试编译仓库内的 [测试替身](../apps/desktop/src-tauri/tests/fixtures/dreamina-video-cli.rs)，验证只提交一次、下载嵌套产物、按同一 ID 恢复、失败/未知状态与取消轮询。这是本地子进程协议测试，**没有调用即梦服务**；替身文件也不是可播放的视频验收样例。
- 前端最终回归 **106/106**（新增专项 10 + 既有 96），覆盖生产 store 的首尾顺序/项目归属、provider 拒绝、精确视频续轮、空参考文生重试、项目草稿、启动恢复与对应轮参数；TypeScript 与 Vite production build 通过。证据：`.tmp/video-integration/frontend-tests.txt`、`frontend-build.txt`。
- 真实 React 组件验证：380/560/900 px 三档无横向溢出，发送入口可见；本地合成视频的 controls 与播放/暂停通过。证据 `.tmp/video-integration/ui-check.json` 明确 `nativeTauri=false`，不能据此宣称 Tauri 原生桌面全链路已验。
- 独立增量审查按本次 `.tmp/video-integration/baseline` 对照，已推动修正：下载扫描不跟随符号链接、清理准确临时根；恢复等待/轮询响应取消并释放并发许可；迟到 Submit 不复活终态；恢复事件携带视频参数；图片/视频混合轮次使用对应轮的媒体、模型和 provider 快照。
- 最终历史复用修正已复核：任务未载入或仅载入最新轮时，旧画板 prompt 都按输出资产与精确 `turn_key` 读取持久化历史；不套用最新轮的图片参数。缺失历史则停止并提示，异步回调检查项目路由是否过期。视频轮的 Agent 重试入口也按该轮媒体类型禁用。上述修正后前端仍为 **106/106**，TypeScript 与 Vite 构建重跑通过。

剩余验收：完整桌面真机 UI、当前账号真实 Seedance 2.5 提交到成功播放及实际计费。常规启动的应用仍需要可用的 FFmpeg/FFprobe；此次只对测试进程临时注入工具目录，未完成全局安装或桌面分发配置。帮助参数核验、离线协议测试和本地合成媒体验收均不等同于真实即梦 Seedance 2.5 生成端到端通过。
