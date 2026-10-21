# 本机 ComfyUI H3 视频卡片

产品约定以 [PROJECT.md](../PROJECT.md) 为准。本专项桌面源码未打包发布；2026-10-20 已通过已有 ComfyUI Desktop 完成首个真实视频生成与入库，详见「生成与任务恢复」。全新 Portable 安装和下载仍未完成实机验收，各阶段的隔离验证不代表真实生成验收。

## 入口与输入输出

工具箱第三项「本地 H3 视频」替换原「本地生图」占位项。仅登录身份与测试权益匹配时显示；原生检查和提交也验证账号、权益有效期及任务所属账号/项目。选择工具后点击画板放置卡片，沿用工作流卡片的连线、复制、移动、保存和执行。

- 首帧必填，尾帧可选，各一张静态图片；支持拖入库内图片或连接图片端口。文本端口内容与卡片提示词合并。
- 时长为 1–15 秒，默认 8 秒；比例固定 9:16 / 16:9 / 4:3；分辨率固定 0.6 / 0.8 / 1.0，默认 0.8。
- 分辨率使用基准节点的 MP 算法：`pixels = tier * 1024 * 1024`，按宽高比计算后，宽高分别舍入到 32 的倍数。卡片展示实际像素，因此实际宽高比存在舍入误差。
- 24 fps；帧数 `max(5, ceil((seconds * 24 - 5) / 17) * 17 + 5)`。8 秒为 192 帧，11 秒为 277 帧（约 11.54 秒）。实际时长在卡片展示；1–4 秒可以提交，但模型节点标注的训练时长约为 5–15 秒，短时长质量未验证。
- 输出一个原生 MP4，保留 H3 音频分支，不超分。自动入库并归属原项目，通过绿色输出连线交付独立视频素材卡，在标准素材预览中播放；输出端口沿用现有媒体资产类型，可连接内容卡。

2026-10-21 布局：内容顺序为首尾帧示意 → 提示词文本框 → 时长／比例／分辨率选项；端口与连线锚点同步下移，继续对齐提示词区域。DOM 顺序与视觉顺序一致。本地视频卡片宽度从 320 增至 416（+30%），提示词框到两侧端口的预留距离约从 61 缩至 42.7（−30%）。首尾帧标签作为图片左上角深底白字角标，不单独占行，删除图片内的移除按钮；仍可拖图替换或从输入端口断开。连线、选择边界、定位和输出避让统一按卡片实际宽度计算，其他卡片保持原宽度。TypeScript、既有 H3 隔离 UI 回归与截图检查通过，无原生代码变化。

2026-10-21 显示简化：移除底部尺寸、帧率、预计时长和输出数量说明，保留时长／比例／分辨率参数选择。视频完成后显示“用时 X 分 Y 秒”，从对应 prompt 的 execution_start/execution_success 毫秒时间戳计算并随本地任务记录保存；重连取回不额外累计耗时，旧历史缺少时间时不猜测。TypeScript、15 项 H3 常规测试及 H3 隔离 UI 回归通过。开发 EXE 已构建至 `.tmp/comfy-elapsed/`，备份旧版后在队列空闲时正常切换为进程 37564，窗口响应与开发页面正常；未提交真实生成、未打包发布。

2026-10-21 进度条外观参照 [Uiverse ancient-falcon-18](https://uiverse.io/dylanharriscameron/ancient-falcon-18)：蓝色圆角边框、浅色底槽和蓝色斜纹填充，保留 MIT 署名。移除参考样式的循环填充与闪烁动画；填充宽度直接使用真实 value/max，中央显示取整百分比。没有数值时保持静态空槽，不显示伪造进度。

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

卡片放置或重开后先读取 Desktop 安装登记，再检测指定地址、`8000`、`8188`、托管环境 `18188`、已有环境启动端口 `18189` 及 Desktop 配置中的自定义端口。优先复用节点与模型齐全的服务，并把选中的地址保存回卡片。默认地址为 `http://127.0.0.1:8000`；地址由自动检测选择，不再暴露输入框。只接受 loopback HTTP 根地址，不经过系统代理，不跟随重定向。检测使用 `/system_stats` 与 `/object_info`，不启动服务、不下载、不生成；提交前仍重新检查。服务检查失败与未安装分开，模型列表检查等待上限由 4 秒延长至 45 秒，其他应用占用常见端口不冒充 ComfyUI。2026-10-20 按用户示意图取消顶部独立端口预留：提示词框紧接标题栏，左侧按首帧、尾帧、文本排列，右侧为视频输出，端口按钮与连线共用坐标。提示词下依次为时长/比例/分辨率与首尾帧图片槽；文字标签不覆盖输入框。

### 已有 Desktop 安装识别（2026-10-19 修正）

旧版只探测运行端口，且「更换位置」始终把选中目录当作新安装父目录，因此即使选中已安装的 Desktop 也显示未检测到。原生发现器已区分已有安装与新安装目的地；最新界面只保留安装位置和安装按钮，已有环境自动发现（原生手动选择命令保留兼容）：

- 从系统应用配置目录下 `Comfy Desktop/installations.json`、`settings.json` 读取本机实例、最近启动顺序、共享模型目录和端口；忽略 Cloud 实例。兼容 `ComfyUI/config.json` 的 basePath 记录。
- 可选 Desktop 总目录、具体实例、源码子目录、便携版目录或 Desktop 程序所在目录。识别 standalone-env、python_embeded 和 .venv；缺 Python 仍显示安装已找到，提示在 Desktop 中启动，不冒充未安装。
- 文件检查只统计基准 5 个模型是否存在，使用已登记共享目录和当前实例 models 的有界遍历；不读用户工作流/提示词，不扫描整盘。文件存在不等于模型已成功加载。
- 环境状态缩为复制按钮左侧圆点：绿点代表无需用户准备即可运行，不要求服务已启动。`ready`，以及 Python 可启动且 5/5 模型文件齐全的 `stopped` 实例、已完整安装且满足启动条件的托管环境，均显示绿点；其自动启动期间保持绿点，缺 Python/模型、检测失败、已记录启动失败仍显示红点。hover 提示「环境已就绪，运行卡片时会自动启动」。放置卡片只读检测，运行自动启动并核验实际节点/模型后提交；文件检查不等于模型已加载或 GPU 生成成功。红点打开面板查看原因，环境可用后自动关闭，无须再点击启动；已有安装不推荐整包重下。
- 明确选择保存到独立 `comfy-existing-location.json`。点击卡片原有「运行」时使用该实例的 Python/main.py 和 Desktop 生成的模型路径配置，保留已识别的显存/缓存/attention 参数，隐藏启动并监听 `127.0.0.1:18189`，检查通过后直接继续生成；不安装、不替换模型。日志落应用数据 `comfy-existing/startup.log`。用户也可自行在 Desktop 启动。卡片正文不再显示环境区域，也无独立启动、检测、地址或实例选择。返回应用和打开红点面板自动检测；运行仍可自动启动已有实例。
- 2026-10-19 用原生发现器只读核验本机 `ComfyUI`、`信息流` 两个实例均有 Python 和 5/5 基准模型文件；完整检测器在本机最终返回 `stopped`（已找到 ComfyUI、服务未启动），不再返回未安装。Windows 未监听端口可能报 connect timeout，按连接未建立处理；只有连接建立后的响应/模型检查异常才归服务检查失败。没有启动真实 ComfyUI 或生成视频。

## 一键环境准备

原生命令 `comfy_video_environment` 提供 detect/status/prepare/install/cancel/select_existing/start_existing，沿用测试账号门控。安装和已有环境启动共享单例后台任务，删除或关闭卡片不取消任务；退出应用中断下载，下次可从 `.part` 继续。注销或切换账号会取消。放置卡片仅检测；点击运行调用 prepare，复用可用服务或自动启动已安装环境并等待检查完成，再提交视频。prepare 不隐式下载缺失环境。点击红点弹出「本地部署工作流」面板，仅有「安装位置」和一个随状态变化的操作按钮：前者选择新部署目录，后者在未安装时显示「安装」，已有可启动环境显示「启动」，失败后显示「重试安装／重试启动」，安装取消显示「继续安装」。检测中显示「检测中…」，安装／启动中显示对应进度文案，均禁用；就绪为「已就绪」且禁用；缺前置条件显示「暂不可安装／无法启动」且禁用，原因保留在状态文字。连接或服务检查异常时同一个按钮变为可点击的「重新检测」，只读检查后再决定后续动作。已有环境启动及重试均调用 prepare，不重复下载。路径、容量、进度和错误均为只读文字；检测和准备过程中禁用两个按钮，关闭面板继续安装，环境可运行或可自动启动后关闭面板并变绿。Esc 或点击面板外关闭、焦点返回圆点，无额外关闭或取消按钮。不会安装驱动或升级已有 ComfyUI。

- 一键安装限定 Windows x64 + NVIDIA（CUDA 13 对应 580+ 驱动）；其他平台保留已有服务连接。检查 Windows tar 与安装卷可用空间，不假定显存检查能证明真实模型运行成功。
- 新安装位置默认应用 local data 的 `Bowerbird-ComfyUI`，可选择其他文件夹，始终创建独立子目录。拒绝占用未带安装标记的非空目录，也拒绝把已识别的已有安装当作下载目的地；位置单独保存在 `comfy-install-location.json`。已有服务节点/模型检查不通过时明确提示检查问题，不直接推荐安装另一份环境。
- 固定 ComfyUI Portable `v0.42.1` NVIDIA 包（约 2.0 GB）与 5 个基准模型（约 42.0 GB）。首次下载总计 **44,048,479,273 bytes**，再预留 12 GiB 给解压与运行。全新安装展示剩余下载及所需空间，已下载内容校验后复用；已有 Desktop 通过原共享目录读取，不复制或迁移模型。
- URL、版本、大小和 SHA-256 固定于 `commands/comfy_setup.rs`；只使用 HTTPS，流式落 `.part`，严格校验 Range、总长度与完整 SHA-256 后才改为正式文件。拒绝校验失败的已有正式文件，不自动覆盖。损坏的临时文件删除后可重试。系统代理用于公开下载，本机连接仍绕过代理。
- 解压经过校验的官方 portable 包，使用内置 Python 与依赖；通过独立 `models.yaml` 连接本安装模型目录。启动隐藏进程，仅监听 `127.0.0.1:18188`，不自动打开浏览器。端口占用不会杀其他程序。启动失败显示 `startup.log` 路径；取消或启动检查超时只终止本次启动的进程。
- 模型和节点检查成功才显示就绪；大模型真正加载、显存占用和视频质量仍需实机验收。运行中的用户服务优先复用；已安装的托管环境停止后也随「运行」自动启动。

清单来源：[ComfyUI 官方便携版](https://docs.comfy.org/installation/comfyui_portable_windows)、[固定版本发布](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.42.1)、[Comfy-Org 模型固定版本](https://huggingface.co/Comfy-Org/MiniMax-H3/tree/e5eb578a89295337b8ff433a035929ce0279e0b6)、[LightX2V 768p Turbo LoRA](https://huggingface.co/lightx2v/Minimax-h3-Turbo/blob/a29e57d195f80ead07c89f89e55ecf2911e893c5/minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors)、[NVIDIA CUDA 驱动兼容](https://docs.nvidia.com/cuda/archive/13.0.1/cuda-toolkit-release-notes/index.html)。基准 768p LoRA 的哈希 `08cfe946…f9980` 已与本机原文件核对，不能换成不带 768p 的另一 LoRA。

### 2026-10-20 已有 Desktop 启动修复

本机 Desktop 同时保留 `standalone-env/python.exe` 与 `ComfyUI/.venv/Scripts/python.exe`。前者是基础解释器（旧 `comfy-aimdo 0.4.10` 且无 torch），后者才是 Desktop 成功运行时使用的完整环境（`comfy-aimdo 0.5.6`、torch）。原发现器错误地优先选择前者，导致 `init() got an unexpected keyword argument 'nvml_pressure'`；这不代表用户需重装 ComfyUI。现在优先源码目录的 `.venv`，其次实例根目录 `.venv`，最后才回退 standalone/portable Python；Unix 同样识别源码 `.venv/bin/python`。保留原有显存优化、模型配置与启动参数，不降级显存管理、不安装或替换依赖。进程启动失败时读取日志末尾最多 64 KiB，将末条错误摘要（最多 600 字符）连同日志路径展示到卡片诊断。

已在本机用正确 `.venv`、相同受控启动参数和 Desktop 模型配置于独立 `127.0.0.1:18190` 临时启动 ComfyUI 0.40.0；GET `/system_stats`、`/object_info` 确认所需 16 种节点与 5 个模型均可用，随后关闭本次测试子进程。未上传图片、未提交生成、未修改依赖或模型。回归用例覆盖基础 Python 与虚拟环境共存、直接选择源码目录、Unix 虚拟环境路径，以及启动错误日志有界读取。

18:42 用户复测仍报旧错误，核对为运行中的主 EXE 仍是 14:56 构建；之前 `cargo test --lib` 仅重建测试程序，不能更新主 EXE。18:44 已单独编译开发版主程序（SHA-256 `4e7e260261e7cffb87e3f6850f14fb8eef64932f8dfdb719860f9b0ca4e6b062`），备份旧 EXE 后正常关闭旧窗口、替换 canonical `target/debug/bowerbird-desktop.exe`，18:45 重开并核对进程响应和 Vite HTTP 200。未打包发布、未提交视频。今后原生修复交付须区分测试通过、主程序重编译与运行进程切换。

## 生成与任务恢复

2026-10-20 按用户要求统一结果交付：本地 H3 卡片不再内嵌播放器。取回视频后，沿既有 `projectCanvasNodeCreate` 创建独立视频素材卡（原资产、原线程），在源卡右侧就近避让放置，以 `resultNodeIds` 从“视频”输出口绘制绿色连线；使用标准素材卡预览、拖动与缩放。结果节点身份固定为 `workflow-comfy:<requestId>`，取回/重试不重复创建；新的一次显式生成产生新节点，旧视频保留。节点保存失败停在可继续取回状态，不重发生成。已有内嵌结果载入画板时使用保存的资产与完成任务补建节点，不查询或提交 ComfyUI；已有隐藏节点不复活。输出数据仍通过 `outputs.image.assetIds` 传给下游，未更改端口身份。界面回归覆盖独立素材节点/绿色输出线、卡内无播放器、保存失败后继续、重复运行独立结果、重载不重复、旧结果迁移和删除不复活；本机既有视频已自动补建原生画板节点。

2026-10-20 实机首个 H3 任务已在 ComfyUI 完成（273.96 秒），视频成功入库并归属原项目，但卡片结果引用随后被清空：运行期间自动准备切换到 `18189`，运行完成解锁后环境检测将地址写回卡片，沿通用 `patch` 默认执行 `invalidateWorkflow`，误删本卡及下游结果。环境控件写回连接配置现在使用不失效的更新路径；正文提示词、时长、比例、帧输入等实际生成参数仍保留原失效规则。无须重新生成或重新导入。

界面回归先复现「完成后检测到新地址 → outputs.image 消失」，修复后验证视频仍可见、结果引用持久化、重载不重提任务；完整 H3 UI 与本机 TypeScript 检查通过。对本次已有视频，先备份精确画板文档，再正常关闭开发版，仅为匹配的最新完成 run/job 恢复已存在资产 ID 的输出引用并递增 revision，重开应用；未更改视频文件或任务提交记录。该视频为 672×1216、2,552,317 字节；真实生成和入库已确认，播放体验/生成质量仍待用户验收。

原生 HTTP 使用 `/upload/image`、`/prompt`、`/queue`、`/history`、`/view` 和按任务取消 `/api/jobs/{prompt_id}/cancel`；WebSocket `/ws?clientId=<request UUID>` 接收本任务进度。图片按库内资产 ID 读取，解码并转 PNG 上传。输出只取节点 27 的唯一 MP4，流式下载上限 2 GB，通过现有 `for_project` / `ingest_generated` 保存。

新任务先校验必填输入，再准备环境；准备失败或期间停止，不创建视频任务身份、不提交视频。停止等待不取消可能被其他卡片共用的环境启动。准备成功后使用返回的服务地址，工作流步骤先保存 UUID，再写入 `LibraryPaths.root/comfy-video/<UUID>.json`（账号、项目、冻结参数、提交标记、prompt_id、asset_id）。POST 前保存提交标记；重连和重复 start 都不重发，也不重新 prepare。若 POST 回包丢失，通过 queue/history 中的 `extra_data.bowerbird_request_id` 找回原任务；找不到则等待人工核对，不推断失败或自动重试。没有 prompt_id 时只查最近 500 条历史，ComfyUI 清空历史后无法自动取回。

每次原生命令检查任务归属，提交前及下载后再次确认账号未切换。界面通过 WebSocket 接收 executing/progress，并按 prompt_id 过滤；显示当前阶段，使用真实 value/max 换算百分比并叠加在进度条中（如 38%，不显示步数），进入解码/合成/保存时清除采样百分比，无明确步数时显示不定进度。断线进入等待，可「继续」取回；重启应用清除旧进度与正在停止状态，不会自动提交。停止先等待正在提交的调用结束，再按原任务编号调用 ComfyUI job cancel：排队任务移出队列，运行任务由服务原子核对编号后中断，确认退出队列才持久化 cancelled。不会发送全局 interrupt，也不停止共享服务。取消失败或状态未知保持等待并提示未确认停止，可再次停止；不支持按任务取消的旧服务明确报错，不回退到全局中断。已取消任务不显示取回按钮；若视频先于停止请求完成，保留「取回上次视频」。恢复不依赖原输入图片仍然存在。导入中断可按固定来源路径找到已入库资产，避免重复导入；已删除的输出不自动重新生成。

## 验证与边界

2026-10-20 取消/进度增量：Rust 隔离 HTTP 验证排队取消、运行中断、完成竞态、未知状态与账号拒绝；真实 WebSocket 协议模拟验证步数、阶段切换、prompt 过滤与监听释放。UI 验证 3/8=38%、阶段重置、取消失败不误报停止、确认取消不提供取回，以及完成竞态仍可取回。核对本机 ComfyUI 源码支持按任务原子取消；尚未用真实 GPU 生成验证此次中断和进度。本轮 14 项 H3 常规测试、1 项隔离视频入库测试、完整 H3 UI（含提交中停止竞态与取消后重开）及 TypeScript 检查通过。新版开发 EXE 输出于 `.tmp/comfy-cancel-progress/`，旧版已备份为 `before-cancel-progress.exe`；用户允许中断当前生成后，复查队列已空，未实际发送取消请求。已正常退出旧进程 53392 并替换启动为 41980，窗口响应及 localhost:1420 均正常。新 EXE SHA-256 `a0fe97f68cf03ab90f27de933f9def133ac61998b4abd119cb9692e9d62754d7`；未打包或发布。

- TypeScript 与 Rust 编译检查。
- `h3_discovery_` 覆盖 Desktop 总目录/实例/源码子目录选择、共享模型、非默认端口、Cloud 忽略、便携版和缺 Python 区分；可选 read-only 测试核对本机真实登记。`h3_setup_slow_server` 覆盖超过旧 4 秒阈值的慢响应。UI 覆盖已有环境选择不会改变下载位置、未启动/启动中/检查失败均不提示整包重下。
- Rust `h3_setup_`：固定清单与容量、本地 HTTP 模拟断点续传、服务器忽略 Range、错误范围拒绝、完整文件复用、哈希失败清理、取消不下载，以及 Windows tar 合成 7z 创建/解压。未下载或执行真实安装包。
- Rust `h3_` 测试：固定图参数、MP/帧数转换、loopback 地址边界；独立 axum 模拟服务验证 PNG 上传、POST、丢失回包后找回、下载与原生 MP4 入库、重复取回幂等及失败状态。仅用 FFmpeg 生成 0.25 秒纯色测试片，无 GPU 模型任务。
- Rust `comfy_video_frame_ports_and_single_video_survive_storage`：独立首尾帧端口、配置和媒体输出往返。
- `node scripts/comfy-video-ui.test.mjs`：隔离 Chromium / 合成 IPC 验证放置即检测且不安装、安装进度/失败重试/就绪、顶部紧凑布局、首尾帧连线与拖放、参数持久化、单首帧、断线和停止取回、同一 request ID 不重发、唯一视频输出。2026-10-19 简化流程追加验证：复制按钮左侧红绿状态圆点、放出卡片后完整未启动实例自动绿点且不启动服务、托管安装同样可自动启动、缺 Python/模型和失败仍红点、红点面板仅两个按钮、安装/启动/重试/继续/重新检测文案与禁用状态、失败启动重试不下载、安装目录传递、关闭不中断及重开不重复安装、Esc/外部点击关闭与焦点恢复、绿点不打开面板、运行自动准备并使用返回地址、准备失败不产生任务身份、启动等待中停止不提交、恢复不重新准备。Rust `h3_setup_run_prepares_installed_environment_without_implicit_download` 验证已有/托管环境选择、共享模型与启动参数保留、缺环境不隐式下载及检查失败不重复启动。
- `video-replication-ui.test.mjs` 验证普通/退出/错配账号隐藏入口及菜单键盘交互；`canvas-workflow-video.test.mjs` 和工作流逻辑测试回归原视频卡片。

本机已有一次真实模型加载、H3 生成与 MP4 入库记录；真实生成质量、音画输出及桌面原生播放仍待用户验收。其他比例、分辨率、安装下载及中断恢复不能据此视为已完成实机验证。

```powershell
cd apps/desktop
npm run test:comfy-video
cargo test --locked --offline --manifest-path src-tauri/Cargo.toml --lib h3_ -- --include-ignored
cargo test --locked --offline --manifest-path src-tauri/Cargo.toml --lib comfy_video_frame_ports
```
