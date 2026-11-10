# 本机角色声音

2026-11-11 按用户决定收敛为声音克隆，本轮收敛尚未发布安装包。有效范围以 PROJECT.md 为准。

## 流程与入口

画板工具箱 → 角色声音。主界面围绕「我的声音」、台词与本项目配音展开。录音创建支持导入 WAV／MP3／FLAC／M4A／OGG 或选择当前项目素材，在真实波形上拖动两端裁剪后命名保存，**不要求先生成试听**。双端手柄沿用视频裁剪的键盘、长按细调及秒数输入；试听仅播放选区。保存时由 FFmpeg 提取独立的 48 kHz 单声道 PCM WAV，保留原文件。

参考为 1–30 秒清晰单人录音；默认无需原文，可选原文必须与选区一致。当前只支持「录音 → 裁剪 → 命名保存 → 用这个声音朗读台词」，录音克隆试听可选。已移除「用文字创建」、声音描述和无参考生成路径。克隆试听使用固定示例台词，每次显式「再试一个」建立新任务和种子；修改参考／选区后旧试听不能误用于新输入。声音可改名或删除；删除仅移除声音档案，已生成配音、原录音及冻结任务引用保留。用户提供的 3.924 秒录音已通过前序克隆试听，不宣称任意录音质量均已验证。

原文字设计把用户描述原样拼成 `（描述）试听台词`，不给参考录音，直接交给 VoxCPM2；没有额外描述解析、属性校验或听感匹配评价。此前仅验证生成、保存与复用流程，未验证描述符合度。网页 `18026` 则一直是模拟流程，播放既有样本，不会根据描述实时生成。11 月 11 日正式界面与网页示意同步移除此分支；旧录音草稿保留，旧文字设计创建草稿清空，已有声音、台词与生成结果保留。

首次「启用本机配音」自动检测 NVIDIA 与磁盘，下载专用 Python、依赖和模型，校验后启用；支持后台继续、暂停、失败继续与重新检测。路径和手动连接已有环境收进详情。当前自动安装支持 Windows x64 + NVIDIA CUDA；不支持 CPU／Mac 自动安装。推理关闭 torch.compile 和降噪，模型加载离线，不修改系统 Python／PATH。新建安装和生成沿现有有效 Pro／Studio 本机权益，测试账号可用；无 Bcoin 计费、无 Cloud 协议变更。

安装目录默认应用 local data 下的 `Bowerbird-Voice`，可选其他目录（仍新建该专用子目录）。非空且没有本版本 owner 标记的目录拒绝接管。固定 uv 0.13.7、Python 3.12.13、VoxCPM 2.0.3、torch／torchaudio 2.11.0 CUDA 12.8、torchcodec 0.14.0 和 transformers 5.13.0；其余传递依赖由 uv 解析。模型冻结 OpenBMB/VoxCPM2 revision `7936080b41163874f38610f46f438e2c0757f9fd`，文件大小、SHA-256 与来源在 `voice-downloads.json`。模型／uv 下载使用 `.part`、Range 校验和散列后发布；Python 和依赖下载复用私有 uv 缓存。模型需要约 5 GB，安装器额外预留 12 GB 空间；实际检查以所在磁盘剩余空间为准。

CUDA 索引只用于 torch／torchaudio；其余依赖从 PyPI 安装，避免 Windows TorchCodec 在 CUDA 索引上没有 wheel 的解析失败。参考：[uv Python](https://docs.astral.sh/uv/guides/install-python/)、[uv PyTorch](https://docs.astral.sh/uv/guides/integration/pytorch/)、[TorchCodec](https://github.com/meta-pytorch/torchcodec)、[VoxCPM](https://github.com/OpenBMB/VoxCPM)。下载可达性取决于用户网络，当前没有第三方镜像回退。

当前验证机 Python：`D:/Tools/miniconda3/envs/voxcpm/python.exe`；模型：`D:/H/Project/Bowerbird/.tmp/voxcpm-local/model`。这只是验证机路径，正式代码不硬编码。该临时模型目录若清理，需要重新选择模型。

## 复用与存储

- `VoiceStudio` 复用 ModalShell、AudioWaveform、全局音频播放器、原生文件选择、`api.importFiles`、materialCatalog 与中文 userErrorMessage。文件导入冻结项目并先 materialize，结果只归请求项目。`VoiceReferenceTrim` 复用 `MediaTrimTimeline`；原 `VideoTrimTimeline` 作为兼容导出，视频默认行为保持。
- `commands/voice.rs` 调用现有 `ingest_generated`、音频解码、LibraryPaths 项目目标与 assets-changed 事件，结果进入项目素材库；没有新增画板生成卡或 Agent Runner。
- 资料库 `voice-studio/` 保存 config.json、voices/*.json、references/、jobs/*.json、runs/<id>/request.json／output.wav／diagnostic.log、安装位置与 Numba 缓存。角色参考保留独立副本，声音列表试听使用此副本，原素材移除后仍可生成及试听。配置包含本机绝对路径，换电脑需重新配置。安装状态与 setup.log 位于专用安装目录。
- 台词、所选声音、参考素材身份、裁剪范围、名称、原文和试听任务身份按项目保存到 localStorage；关闭／重开恢复，不因重开重新发起推理。旧录音草稿与试听身份兼容，旧文字设计草稿不能恢复已移除分支。本机文件先原生导入为素材后存身份，不依赖临时浏览器 File 对象。试听任务仍进入项目素材库，主界面「本项目配音」只列正式配音任务。
- 配音结果可试听、显式再生成、添加到画板、导出 WAV。画板复用 `saveMediaAssetToCanvas` 的项目与 operationId 契约，成功后才标记已添加；导出通过原生保存对话框。保存失败且完整 WAV 存在时只提供重试保存，不重复推理。
- JSON 用同目录临时文件持久化替换。每次运行冻结 Python、模型目录、台词、参考音频路径、原文与项目。新请求必须有已保存声音或录音素材；旧客户端携带非空 description 的请求也明确拒绝。历史 Job.description 保留可读，但不参与新推理。runner 同样要求有效参考录音，不再拼接描述。模型文件升级可能影响后续结果，不宣称模型路径即不可变版本。
- 同时一个声音任务，关闭面板不取消；取消只终止本任务子进程。Python 守护线程监视父进程退出，终止推理，避免留下 GPU 任务。应用重开将无活动执行器的 running 标记 interrupted，绝不自动重发。
- 完整输出先写临时 WAV 再替换。取回只入库已存在完整 WAV，不重跑推理。`analyses` 中 `voice:<jobId>` 保证重复取回复用原资产；中途资产插入用 source=voxcpm 与唯一运行输出 origin_path 找回，元数据事务失败回滚资产。取消任务不可取回残留文件。
- 运行文件和历史当前保留供恢复与诊断，不自动清理；长文本分段、批量配音、CPU／Mac 自动安装不在本次实现范围。新前端与 Tauri 后端须配套重建。

## 验证

- TypeScript 全量检查、Vite 独立生产构建通过；沙箱依赖目录解析不完整时在正常权限下运行。
- `scripts/voice-studio-ui.test.mjs` 使用正式组件、隔离 IPC，验证文字入口不存在、文件／素材库录音导入、保存角色、引用身份、克隆试听、关闭重开不重提、取消、深浅主题。截图：`apps/desktop/.tmp/voice-studio/`。
- `commands::voice::tests` 验证持久化覆盖、路径身份拒绝、入库／项目归属、两处提交中断恢复、重复取回及失败回滚。Windows 测试 EXE 需在临时副本补 Common Controls v6 清单（现有测试运行限制），不能修改正式应用替代验收。
- 忽略的真实 GPU 测试使用 `VOICE_TEST_PYTHON`、`VOICE_TEST_MODEL`、可选 `VOICE_TEST_REFERENCE`，在临时库执行正式 Rust → 内嵌 Python → 真实 WAV → 入库，再验证取消；不写用户资料库。

日志位于 `.tmp/voxcpm-local/`。正式安装包原生窗口、其他用户环境和不同录音质量仍需分别验收。

本轮确认稿实装的复用决定、验证结果与行动记录见 [2026-11-10 实装记录](../project_logs/2026-11-10-voice-ux.md)。原网页确认稿保持可独立运行，不承担真实生成。

11 月 11 日克隆首版收敛的回归与操作日志见 [声音克隆收敛记录](../project_logs/2026-11-11-voice-clone-only.md)。

确认稿实装后，一键准备的独立环境安装成功（`ux-install.log`），并已用同一环境和用户批准录音跑通正式 Rust → Python → WAV → 临时库入库与取消（`ux-native-final.log`）；新旧两套 Python 均未改系统 PATH。模型文件复用已有缓存并校验散列，不能表述为全部模型重新从网络下载。最终类型／UI／草稿／视频裁剪／生产构建日志为 `ux-*.log`。

最终结果：原生隔离回归 **2 passed**（`native-tests-final.log`）；显式执行真实 GPU 测试 **1 passed，31.03 秒**（`gpu-native-final.log`，包含加载、推理、入库与取消，不能当作纯推理耗时）；完整类型检查 `tsc-final.log` 无错误，UI 日志 `ui-test.log` 通过，生产构建 `build.log` 通过。GPU 测试使用用户已批准的参考录音副本，不写真实资料库。Windows 测试副本仅补运行清单，未更改生产程序。

## 已定位问题

Python 退出监视不能阻塞读取标准输入：缓冲读取和 Windows CRT 读取均会与 ML 依赖初始化检查标准输入发生等待。改用 Windows 父进程句柄等待，不触碰标准输入。UI 截图须等待主题过渡结束，否则输入框会捕获到旧主题过渡色。

并行 Rust 编译与模型加载曾触发 Windows 1455（页面文件太小）；未修改系统设置，编译结束后串行真实生成通过。

PyPI VoxCPM 2.0.3 不支持 Git 测试版的 `generate(seed=...)` 参数；runner 在调用前设置 Python／NumPy／torch 的种子，保持每个显式新任务产生新的试听变化。uv 的 `--torch-backend cu128` 会影响 TorchCodec 的索引，因此只在安装 torch／torchaudio 时使用，其他依赖回到 PyPI 的 Windows wheel。
