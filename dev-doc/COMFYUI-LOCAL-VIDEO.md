# 本机 ComfyUI H3 视频卡片

产品约定以 [PROJECT.md](../PROJECT.md) 为准。本专项为源码接入，未打包发布，也未向真实 ComfyUI 提交生成。

## 入口与输入输出

工具箱第三项「本地 H3 视频」替换原「本地生图」占位项。仅登录身份与测试权益匹配时显示；原生检查和提交也验证账号、权益有效期及任务所属账号/项目。选择工具后点击画板放置卡片，沿用工作流卡片的连线、复制、移动、保存和执行。

- 首帧必填，尾帧可选，各一张静态图片；支持拖入库内图片或连接图片端口。文本端口内容与卡片提示词合并。
- 时长为 1–15 秒，默认 8 秒；比例固定 9:16 / 16:9 / 4:3；分辨率固定 0.6 / 0.8 / 1.0，默认 0.8。
- 分辨率使用基准节点的 MP 算法：`pixels = tier * 1024 * 1024`，按宽高比计算后，宽高分别舍入到 32 的倍数。卡片展示实际像素，因此实际宽高比存在舍入误差。
- 24 fps；帧数 `max(5, ceil((seconds * 24 - 5) / 17) * 17 + 5)`。8 秒为 192 帧，11 秒为 277 帧（约 11.54 秒）。实际时长在卡片展示；1–4 秒可以提交，但模型节点标注的训练时长约为 5–15 秒，短时长质量未验证。
- 输出一个原生 MP4，保留 H3 音频分支，不超分。自动入库并归属原项目，在卡片内播放，输出端口沿用现有媒体资产类型，可连接内容卡。

## 固定工作流

基准：`10_H3_768p_Turbo8_Review_First.json`，2026-10-19 核对本机文件 SHA-256：`e657cc058714f199edd6e4eac2e3fb440df46faeede2c1be967f2bf123eaa871`。

只转换启用的原生输出分支为 API graph；不复制工作流内的示例图片和私人提示词。模型及节点参数固定在 `apps/desktop/src-tauri/src/commands/comfy_video.rs`：

| 配置 | 基准值 |
|---|---|
| DiT | minimax_h3_fl2va_pruned_int8_convrot.safetensors |
| CLIP | qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors / minimax / default |
| Video VAE | minimax_h3_video_vae_int8_convrot.safetensors |
| Audio VAE | minimax_h3_audio_vae_fp32.safetensors |
| LoRA | minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors / 1.0 |
| Sigma shift | video 6 / audio 3 |
| 采样 | Euler / simple / 8 steps / denoise 1 |
| 视频编码 | 24 fps / 8 bit / sRGB / MP4 / auto codec |

ResolutionSelector 与秒数表达式由适配器等价计算；原 .98 MP 改为用户指定的三档。每次新任务使用新 seed；重连不创建新任务。尾帧通过独立 LoadImage 连接到 MiniMaxH3ImageToVideo.last_frame。沿用原节点首帧拉伸、尾帧居中裁切策略，暂不新增预裁切控件。SaveVideo 使用本机版本的动态参数 `format.codec`。

## 连接与恢复

卡片放置或重开后自动检测指定地址、`8000`、`8188`、托管环境 `18188`，优先复用节点与模型齐全的服务，并把选中的地址保存回卡片。默认地址为 `http://127.0.0.1:8000`，在「高级连接设置」可修改。只接受 loopback HTTP 根地址，不经过系统代理，不跟随重定向。检测使用 `/system_stats` 与 `/object_info`，不启动服务、不下载、不生成；提交前仍重新检查。就绪状态保持简洁，缺环境时显示安装引导，不暴露节点参数。端口按钮和连线共用紧凑坐标，顶部预留从 122 降至 68 画布单位。

## 一键环境准备

原生命令 `comfy_video_environment` 提供 detect/status/install/cancel，沿用测试账号门控。安装是单例后台任务，删除或关闭卡片不取消安装；退出应用中断下载，下次可从 `.part` 继续。注销或切换账号会取消。用户明确点击「一键下载并安装」或「一键启动」才执行；不会安装驱动、修改已有 ComfyUI、提交视频生成。

- 一键安装限定 Windows x64 + NVIDIA（CUDA 13 对应 580+ 驱动）；其他平台保留已有服务连接。检查 Windows tar 与安装卷可用空间，不假定显存检查能证明真实模型运行成功。
- 位置默认应用 local data 的 `Bowerbird-ComfyUI`，可选择其他文件夹，始终创建独立子目录。拒绝占用未带安装标记的非空目录；位置单独保存在 `comfy-install-location.json`。已有服务节点/模型不齐时会准备独立环境，不对其原目录追加或覆盖文件。
- 固定 ComfyUI Portable `v0.42.1` NVIDIA 包（约 2.0 GB）与 5 个基准模型（约 42.0 GB）。首次下载总计 **44,048,479,273 bytes**，再预留 12 GiB 给解压与运行。卡片展示剩余下载及所需空间，已下载内容校验后复用；不自动发现或迁移停止服务中的第三方模型目录。
- URL、版本、大小和 SHA-256 固定于 `commands/comfy_setup.rs`；只使用 HTTPS，流式落 `.part`，严格校验 Range、总长度与完整 SHA-256 后才改为正式文件。拒绝校验失败的已有正式文件，不自动覆盖。损坏的临时文件删除后可重试。系统代理用于公开下载，本机连接仍绕过代理。
- 解压经过校验的官方 portable 包，使用内置 Python 与依赖；通过独立 `models.yaml` 连接本安装模型目录。启动隐藏进程，仅监听 `127.0.0.1:18188`，不自动打开浏览器。端口占用不会杀其他程序。启动失败显示 `startup.log` 路径；取消或启动检查超时只终止本次启动的进程。
- 模型和节点检查成功才显示就绪；大模型真正加载、显存占用和视频质量仍需实机验收。运行中的用户服务优先复用；已安装的托管环境停止后提供一键启动。

清单来源：[ComfyUI 官方便携版](https://docs.comfy.org/installation/comfyui_portable_windows)、[固定版本发布](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.42.1)、[Comfy-Org 模型固定版本](https://huggingface.co/Comfy-Org/MiniMax-H3/tree/e5eb578a89295337b8ff433a035929ce0279e0b6)、[LightX2V 768p Turbo LoRA](https://huggingface.co/lightx2v/Minimax-h3-Turbo/blob/a29e57d195f80ead07c89f89e55ecf2911e893c5/minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors)、[NVIDIA CUDA 驱动兼容](https://docs.nvidia.com/cuda/archive/13.0.1/cuda-toolkit-release-notes/index.html)。基准 768p LoRA 的哈希 `08cfe946…f9980` 已与本机原文件核对，不能换成不带 768p 的另一 LoRA。

## 生成与任务恢复

原生 HTTP 使用 `/upload/image`、`/prompt`、`/queue`、`/history`、`/view`。图片按库内资产 ID 读取，解码并转 PNG 上传。输出只取节点 27 的唯一 MP4，流式下载上限 2 GB，通过现有 `for_project` / `ingest_generated` 保存。

工作流步骤先保存 UUID，再写入 `LibraryPaths.root/comfy-video/<UUID>.json`（账号、项目、冻结参数、提交标记、prompt_id、asset_id）。POST 前保存提交标记；重连和重复 start 都不重发。若 POST 回包丢失，通过 queue/history 中的 `extra_data.bowerbird_request_id` 找回原任务；找不到则等待人工核对，不推断失败或自动重试。没有 prompt_id 时只查最近 500 条历史，ComfyUI 清空历史后无法自动取回。

每次原生命令检查任务归属，提交前及下载后再次确认账号未切换。界面显示排队/生成阶段，不伪造百分比。断线进入等待，可「继续」取回；重启应用不会自动提交。停止只结束 Bowerbird 等待，不发送全局 interrupt。单卡停止后可「取回上次视频」；多卡工作流沿用原停止语义。恢复不依赖原输入图片仍然存在。导入中断可按固定来源路径找到已入库资产，避免重复导入；已删除的输出不自动重新生成。

## 验证与边界

- TypeScript 与 Rust 编译检查。
- Rust `h3_setup_`：固定清单与容量、本地 HTTP 模拟断点续传、服务器忽略 Range、错误范围拒绝、完整文件复用、哈希失败清理、取消不下载，以及 Windows tar 合成 7z 创建/解压。未下载或执行真实安装包。
- Rust `h3_` 测试：固定图参数、MP/帧数转换、loopback 地址边界；独立 axum 模拟服务验证 PNG 上传、POST、丢失回包后找回、下载与原生 MP4 入库、重复取回幂等及失败状态。仅用 FFmpeg 生成 0.25 秒纯色测试片，无 GPU 模型任务。
- Rust `comfy_video_frame_ports_and_single_video_survive_storage`：独立首尾帧端口、配置和媒体输出往返。
- `node scripts/comfy-video-ui.test.mjs`：隔离 Chromium / 合成 IPC 验证放置即检测且不安装、安装进度/取消/重试/就绪、顶部紧凑布局、首尾帧连线与拖放、参数持久化、单首帧、断线和停止取回、同一 request ID 不重发、唯一视频输出。
- `video-replication-ui.test.mjs` 验证普通/退出/错配账号隐藏入口及菜单键盘交互；`canvas-workflow-video.test.mjs` 和工作流逻辑测试回归原视频卡片。

还需用户实际启动本机 ComfyUI 后验证模型加载、显存、真实生成质量、音画输出及桌面原生视频播放。模拟通过不代表真实 H3 工作流已跑通。

```powershell
cd apps/desktop
npm run test:comfy-video
cargo test --locked --offline --manifest-path src-tauri/Cargo.toml --lib h3_ -- --include-ignored
cargo test --locked --offline --manifest-path src-tauri/Cargo.toml --lib comfy_video_frame_ports
```
