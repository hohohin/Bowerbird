# 本机角色声音

2026-11-11 桌面源码已将录音克隆接入画板卡片，本轮变更待发布。

## 卡片流程

从画板工具箱选择「角色声音」，点击画板放置。卡片标题栏的圆点显示本机环境状态，放置卡片或返回窗口会检测。点击圆点可查看检测结果、选安装位置、准备／暂停环境或连接已有环境。

未选声音时，卡片接收一段参考录音。可以从画板连线、拖入音频、选择本地文件或从项目素材库选择。在真实波形上裁剪 1–30 秒，输入试听台词即可生成并在卡内播放。本次试听绑定音频、选区、可选原文和试听文字。名称独立于试听，点击「保存并使用」后以保存的 WAV 作为音色参考。

选择已有声音后，编辑正式台词或连接文本输入，点击「生成配音」。工作流按已选声音生成 WAV，保存到原项目素材库并在卡片旁放置音频素材；下游通过媒体输出口取得该音频。卡内可播放结果，项目配音历史支持导出与使用已有结果。

卡片保存于 `CanvasWorkflow.nodes`，类型为 `voice`。每张卡分别保存声音、录音连接、选区、试听文字和正式台词。首次放置接续该项目旧面板的草稿。已有声音档案与历史 WAV 沿用原生声音库。

环境状态点自动检测 NVIDIA 与磁盘，下载专用 Python、依赖和模型，校验后启用；支持后台继续、暂停、失败继续与重新检测。路径和手动连接已有环境收进详情。当前自动安装支持 Windows x64 + NVIDIA CUDA；不支持 CPU／Mac 自动安装。推理关闭 torch.compile 和降噪，模型加载离线，不修改系统 Python／PATH。新建安装和生成沿现有有效 Pro／Studio 本机权益，测试账号可用；无 Bcoin 计费、无 Cloud 协议变更。

安装目录默认应用 local data 下的 `Bowerbird-Voice`，可选其他目录（仍新建该专用子目录）。非空且没有本版本 owner 标记的目录拒绝接管。固定 uv 0.13.7、Python 3.12.13、VoxCPM 2.0.3、torch／torchaudio 2.11.0 CUDA 12.8、torchcodec 0.14.0 和 transformers 5.13.0；其余传递依赖由 uv 解析。模型冻结 OpenBMB/VoxCPM2 revision `7936080b41163874f38610f46f438e2c0757f9fd`，文件大小、SHA-256 与来源在 `voice-downloads.json`。模型／uv 下载使用 `.part`、Range 校验和散列后发布；Python 和依赖下载复用私有 uv 缓存。模型需要约 5 GB，安装器额外预留 12 GB 空间；实际检查以所在磁盘剩余空间为准。

CUDA 索引只用于 torch／torchaudio；其余依赖从 PyPI 安装，避免 Windows TorchCodec 在 CUDA 索引上没有 wheel 的解析失败。参考：[uv Python](https://docs.astral.sh/uv/guides/install-python/)、[uv PyTorch](https://docs.astral.sh/uv/guides/integration/pytorch/)、[TorchCodec](https://github.com/meta-pytorch/torchcodec)、[VoxCPM](https://github.com/OpenBMB/VoxCPM)。下载可达性取决于用户网络，当前没有第三方镜像回退。

当前验证机 Python：`D:/Tools/miniconda3/envs/voxcpm/python.exe`；模型：`D:/H/Project/Bowerbird/.tmp/voxcpm-local/model`。这只是验证机路径，正式代码不硬编码。该临时模型目录若清理，需要重新选择模型。

## 复用与存储

- VoiceCard 复用 TacticalSelect、AudioWaveform、VoiceReferenceTrim、原生文件选择、api.importFiles、materialCatalog 与公共音频播放器。选择工具放置时先固化目标项目。音频源通过已有媒体通道传递，并按实际音频类型核对。
- canvasWorkflowRuntime 在调用生成前保存请求标识。原生 Job.request_key 可用于恢复丢失的提交回执。继续工作流读取原任务；完整文件保存失败与画板落点失败可分别重试，正式配音按 job ID 固定画板落点身份。
- 资料库 `voice-studio/` 保存 config.json、voices/*.json、references/、jobs/*.json、runs/<id>/request.json／output.wav／diagnostic.log、安装位置与 Numba 缓存。角色参考保留独立副本，声音列表试听使用此副本，原素材移除后仍可生成及试听。配置包含本机绝对路径，换电脑需重新配置。安装状态与 setup.log 位于专用安装目录。
- 工作流卡片使用 node.prompt 保存正式台词，node.voice 保存选中的声音、试听台词和裁剪资料。完成的试听结果保存在步骤回执中，更新试听文字或更换参考后隐藏旧试听。首次放置读取旧版 localStorage 草稿。
- JSON 用同目录临时文件持久化替换。每次运行冻结 Python、模型目录、台词、参考音频路径、原文与项目。新请求必须有已保存声音或录音素材；旧客户端携带非空 description 的请求也明确拒绝。历史 Job.description 保留可读，但不参与新推理。runner 同样要求有效参考录音，不再拼接描述。模型文件升级可能影响后续结果，不宣称模型路径即不可变版本。
- 同时一个声音任务，关闭面板不取消；取消只终止本任务子进程。Python 守护线程监视父进程退出，终止推理，避免留下 GPU 任务。应用重开将无活动执行器的 running 标记 interrupted，绝不自动重发。
- 完整输出先写临时 WAV 再替换。取回只入库已存在完整 WAV，不重跑推理。`analyses` 中 `voice:<jobId>` 保证重复取回复用原资产；中途资产插入用 source=voxcpm 与唯一运行输出 origin_path 找回，元数据事务失败回滚资产。取消任务不可取回残留文件。
- 运行文件和历史当前保留供恢复与诊断，不自动清理；长文本分段、批量配音、CPU／Mac 自动安装不在本次实现范围。新前端与 Tauri 后端须配套重建。

## 验证

- TypeScript 全量检查、Vite 独立生产构建通过；沙箱依赖目录解析不完整时在正常权限下运行。
- `scripts/voice-studio-ui.test.mjs` 从正式画板工具箱放置卡片，用隔离 IPC 验证环境准备、参考音频、编辑试听、卡内播放、保存选用、配音输出、丢失提交回执与落点重试、重开恢复和多卡输入隔离。截图在 `apps/desktop/.tmp/voice-card-ui/`。
- `commands::voice::tests` 验证持久化覆盖、路径身份拒绝、入库／项目归属、两处提交中断恢复、重复取回及失败回滚。Windows 测试 EXE 需在临时副本补 Common Controls v6 清单（现有测试运行限制），不能修改正式应用替代验收。
- 忽略的真实 GPU 测试使用 `VOICE_TEST_PYTHON`、`VOICE_TEST_MODEL`、`VOICE_TEST_REFERENCE`，在临时库执行正式 Rust → 内嵌 Python → 真实 WAV → 入库，再验证取消；不写用户资料库。

日志位于 `.tmp/voxcpm-local/`。正式安装包原生窗口、其他用户环境和不同录音质量仍需分别验收。

本轮确认稿实装的复用决定、验证结果与行动记录见 [2026-11-10 实装记录](../project_logs/2026-11-10-voice-ux.md)。原网页确认稿保持可独立运行，不承担真实生成。

11 月 11 日克隆首版收敛的回归与操作日志见 [声音克隆收敛记录](../project_logs/2026-11-11-voice-clone-only.md)。

确认稿实装后，一键准备的独立环境安装成功（`ux-install.log`），并已用同一环境和用户批准录音跑通正式 Rust → Python → WAV → 临时库入库与取消（`ux-native-final.log`）；新旧两套 Python 均未改系统 PATH。模型文件复用已有缓存并校验散列，不能表述为全部模型重新从网络下载。最终类型／UI／草稿／视频裁剪／生产构建日志为 `ux-*.log`。

最终结果：原生隔离回归 **2 passed**（`native-tests-final.log`）；显式执行真实 GPU 测试 **1 passed，31.03 秒**（`gpu-native-final.log`，包含加载、推理、入库与取消，不能当作纯推理耗时）；完整类型检查 `tsc-final.log` 无错误，UI 日志 `ui-test.log` 通过，生产构建 `build.log` 通过。GPU 测试使用用户已批准的参考录音副本，不写真实资料库。Windows 测试副本仅补运行清单，未更改生产程序。

## 已定位问题

Python 退出监视不能阻塞读取标准输入：缓冲读取和 Windows CRT 读取均会与 ML 依赖初始化检查标准输入发生等待。改用 Windows 父进程句柄等待，不触碰标准输入。UI 截图须等待主题过渡结束，否则输入框会捕获到旧主题过渡色。

并行 Rust 编译与模型加载曾触发 Windows 1455（页面文件太小）；未修改系统设置，编译结束后串行真实生成通过。

PyPI VoxCPM 2.0.3 不支持 Git 测试版的 `generate(seed=...)` 参数；runner 在调用前设置 Python／NumPy／torch 的种子，保持每个显式新任务产生新的试听变化。uv 的 `--torch-backend cu128` 会影响 TorchCodec 的索引，因此只在安装 torch／torchaudio 时使用，其他依赖回到 PyPI 的 Windows wheel。

## 画板实装记录

核对 H3 环境状态点、工作流媒体端口、已有声音任务与裁剪组件后，沿现有接口实现卡片。先用连接测试复现新卡片取得通用图片／文本输入的问题，再接入按声音选择状态切换的端口。正式画板测试还发现启动检查读取了正式台词，现按卡片状态分别检查试听台词或配音台词。浏览器演练覆盖播放与投递，真实 GPU 克隆和原生卡片持久化使用独立测试库。验证记录在 `.tmp/voice-card/`。2026-11-10 的网页交互稿保留早期面板形态。

本轮通过 19 项端口／旧草稿／自动连线逻辑测试、正式画板工具箱浏览器回归、TypeScript、Vite 构建和 6 项原生测试（含真实 GPU 克隆与工作流数据库往返）。多卡片拖入、卡内实际播放、回执丢失、落点失败继续和刷新恢复使用隔离 IPC。H3 当前模式与运行恢复回归通过；较早的 comfy-video-ui 脚本在比例／分辨率弹层使用旧选择器，未完整通过。正式安装包验收待发布流程。
