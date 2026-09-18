# 本地动态分类

2026-09-10 用户确认并完成首版源码：不预设类别，根据实际素材识别产生多标签；用户新建标签可匹配存量及后续图片，人工纠正优先。分类全部本地，反推维度继续使用现有 API/CLI。Windows 已随后续版本打包；下述 macOS 适配已纳入 26.9.17 Mac 安装包，交付记录见 `macOS/README.md`。

## 实现与验收

1. 独立本地分类存储：自由标签、分类说明、手动正例/排除记录、图片识别记录。迁移保留已有标签与归属，仅移除未使用的旧预置标签。
2. 应用管理 llama.cpp 子进程和 Qwen3.5-0.8B Q4_K_M + F16 视觉投影。按需下载、固定版本及 SHA256、断网推理、串行运行、可停止。Windows x64 支持 NVIDIA CUDA 加速及 CPU 回退，其他显卡本轮使用 CPU。
3. 本地模型直接识别并提出中文标签，参考已有标签统一命名；逐批匹配全部启用标签。自定义标签可附说明，手动归属与排除提供示例。暂不增加第二套向量模型或强制互斥聚类。
4. 侧栏始终显示分类入口；安装、开始/停止、自动处理新素材、标签创建/编辑及存量匹配在本地分类面板完成。无账号门控，无云端回退。
5. 验证迁移、人工保护/并发修订、动态标签、错误/取消、离线真实模型样本、前端类型与构建。

## 2026-09-17 Windows 下载失败修复

用户在下载 Qwen 权重时遇到 `error sending request for url (https://huggingface.co/...)`。真实 Windows 用户启用了系统 HTTP 代理，进程没有 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY；项目设置 reqwest `default-features = false` 后仅开启 rustls/json/stream/multipart，遗漏 `system-proxy`，GUI 因此未读取系统代理。Mac `b6e3ec9` 的打包说明也明确记录：同期 Cargo.toml/Cargo.lock/runtime.rs 的系统代理修改尚未提交、未进入该包，不能以已提交平台适配判断下载问题已修复。

本轮显式启用 reqwest `system-proxy`，按操作系统现有代理配置下载，不硬编码端口、不修改用户代理配置、不换模型或下载源。权重及运行时固定版本、大小和 SHA-256 不变；本地推理客户端继续 `.no_proxy()`，图片仍仅发送本机模型。网络错误保留底层原因，标明失败文件和系统代理检查提示。

真实验收使用新的隔离目录 `.tmp/local-download-fix-20260917/fresh-model`，不复用缓存、不注入代理环境变量：由正式 install/download 代码从 Hugging Face/GitHub 下载全部 **755,911,809 bytes**，逐文件 SHA-256、运行时解压与 installed 状态通过，耗时 **54.74 秒**。本地分类确定性回归 10/10、管理面板 Chrome 合成 IPC 通过；全量回归与重包记录见 PROJECT.md。新增显式 ignored 的 `real_model_download_uses_system_network_settings`，需指定不存在的 `BOWERBIRD_LOCAL_MODEL_DOWNLOAD_TEST_DIR` 才能运行，不在普通测试中联网。本轮不操作用户素材库，不将下载成功视为分类准确率验收。

## 2026-09-17 Windows GPU 加速与重复标签恢复

Windows 优先使用固定 b10809 CUDA 12.4 运行时，检测 NVIDIA 驱动后才补充加速组件；已有 CPU 安装复用权重与视觉投影，仅增加 **645,382,170 bytes** 的 CUDA 运行时和库文件。CPU 与 CUDA 的 EXE/DLL 分目录保存，下载仍使用系统代理并逐文件校验 SHA-256。CPU 基础包就绪后保留可用状态，CUDA 下载中断、设备不可用或加载失败时可使用 CPU。分类面板显示实际后端、显卡名称或回退原因；首次加载失败会回退 CPU，不把运行过程中的任意图片错误伪装成 GPU 已成功回退。

RTX 4070 Ti SUPER 上通过生产启动路径确认 `offloaded 25/25 layers to GPU` 和 `CLIP using CUDA0 backend`，语言模型与视觉组件使用同一设备。参数为 `--n-gpu-layers 99 --split-mode none --mmproj-offload --mmproj-device CUDA0`；CPU 保留原来的零层卸载及视觉 CPU 参数。没有引入 Mac Metal 适配，本轮不提供 AMD/Intel GPU 路径。

用户报错「模型重复判断了同一个标签」来自旧数组 Schema：限定数量和允许名称，不能保证每个名称只出现一次。保留原有发现/匹配协议，发现重复或遗漏时，将本批最多八个标签分别重判，每个只重试一次；必须全部成功才返回完整结果。冲突判断不任取一项，遗漏不当作 false，失败/取消不写部分归属，人工修订保护保持。正常完整批次不增加推理请求。更新后用「识别未处理素材」重试失败项，已完成记录不被清空。

真实回归还发现序列化顺序影响小模型：默认 JSON 对象排序会把说明放在名称前、把证据/判断放在名称前。现在仅为分类请求固定「名称→说明」「名称→证据→判断」顺序，不更改全应用的 JSON Map 行为。中途尝试的固定字段/元组方案未通过原有负样本检查，未进入最终版本；不能把这些试验结果当成已发布能力。最终 CUDA 路径通过产品/动物、自定义插画正负例及视觉示例检查，并增加负例在正例前后都不匹配的断言。六轮八标签请求全部完成（约 15.16 秒，不含安装/加载）；此项验证结构恢复和批量连通，宽泛标签仍可能误匹配，不能据此宣称 471 张用户素材的准确率。

本轮获取的 `origin/mac` 仍为 `b6e3ec9`，其已提交分类运行时保留旧的重复判断错误，未找到可直接移植的对应修复。Windows 本轮补齐恢复逻辑。确定性 Rust 回归 **361 passed / 8 ignored / 11 filtered**，新增覆盖重复冲突、漏判后失败不返回部分结果、正常结果不额外请求及序列化顺序；ignored 的真实 GPU、CPU 回退和分类专项另跑，交付结果见 PROJECT.md。分类面板含 GPU/CPU 提示的 Chrome 合成 IPC、TypeScript/Vite 通过；未扫描或修改用户的 471 张素材库。证据：本地 `.tmp/local-gpu-fix-20260917/`。

## 固定模型

- 模型：unsloth/Qwen3.5-0.8B-GGUF，revision `6ab461498e2023f6e3c1baea90a8f0fe38ab64d0`。
- Q4_K_M：532,517,120 bytes；SHA256 `bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517`。
- mmproj-F16：204,987,232 bytes；SHA256 `56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453`。
- llama.cpp b10809 Windows CPU ZIP：18,407,457 bytes；SHA256 `9df3158ed228a641a4b127942d7f459f24c9e13f04682659d05c00c80099b6b5`。
- NVIDIA CUDA 12.4 运行时 ZIP：253,938,543 bytes；SHA256 `c77bfcd9ed8d91e8721a2d6a290b907fddd4fa5412a47b21c6fa1709116b85f9`。
- NVIDIA CUDA 12.4 库 ZIP：391,443,627 bytes；SHA256 `8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6`。
- CPU 基础包约 756 MB（721 MiB）；CUDA 另需约 645 MB，完整下载合计 1,401,293,979 bytes。实际内存和准确度以测试结果为准。
- 模型与运行时许可证随安装保存。没有复制 PhotoPrism 代码或规则。

模型可以自由生成标签不等于模型会理解任意用户意图；非视觉的业务状态只能由用户管理。小模型的风格识别、近义合并、CPU 耗时需真实素材评测；不以单次 smoke test 宣称产品准确率。

## 验证记录

- 本地分类专项 **11/11**：10 项确定性检查 + 1 项真实模型检查。真实检查复用已下载且逐文件校验的本地包，验证安装/解压、加载、中文自由标签、产品海报正类/野生动物负类、自定义“东方诗意插画”的正负样本，以及视觉正反例输入；推理仅访问随机端口的 127.0.0.1，不上传样本。
- 真实样本为随应用提供的 preset-01/02，不是用户素材库评测。实际发现标签示例“产品、化妆品、护肤”；分类命名仍可能偏宽泛。示例多图测试包含同图正例，只验证机制连通，不能据此宣称偏好泛化效果。
- 小模型初测把内部 ID 写进标签、单候选倾向直接选中。最终改成独立的发现/匹配请求；匹配逐类输出可见证据和 true/false，并用 JSON Schema 约束。自定义分类正负样本复测通过，仍不能等同任意分类准确率。
- React 真实组件 + 合成 IPC 的浏览器检查通过：下载、停止/重开、快速双击幂等、新建并匹配、正反例、错误提示、深浅主题和 540px 窄窗；前端 TypeScript 与 Vite production build 通过。
- 收口复核：标签关联来源在详情页区分本地自动/人工/历史；移除云端固定词表时保留用户自定义命名模板，新增兼容回归通过。Tauri 安装版完整 GUI 链路尚未验收。
- Rust 扩展回归 **318 passed / 4 ignored / 11 filtered**；过滤既有 `media::tools::tests`（全量运行在媒体工具子进程测试中停滞，已清理本轮测试进程）。本地分类使用独立 `target-local-classification` 目录完成复核，没有把这一轮记作全量无遗漏通过。
- 迁移为 `0026_local_classification.sql`；与并行专项的 `0027_independent_visual_profiles.sql` 顺序兼容，真实用户库未用来做迁移演练。新旧 schema 内存库升级与人工保护通过。

## 使用与边界

侧栏「分类标签 → 管理」打开本地分类面板。首次下载 Windows 约 756 MB、Mac 约 749 MB，Windows NVIDIA GPU 加速另需约 645 MB；可先手动「识别未处理素材」，也可打开自动处理。自动开关会扫描当前库中尚未识别的图片，并处理已排队的新增/修改标签；每 15 秒检查一次。关闭面板不终止后台任务，“停止”也关闭自动处理，已完成结果保留；下载重试复用完整且通过校验的文件，未完成的单文件重新下载。无法补齐的分类错误会暂停自动处理，原因在面板保留。

标签名称/说明可编辑，停用后不参与自动匹配但保留已有归属。开启自动处理时保存标签会排队匹配存量；未开启时用「保存并寻找匹配素材」。选中素材后可明确添加正例或排除；单次上下文取至多两个手动正例和一个反例，自动及历史来源不作为训练示例。重新扫描只撤销本地模型自己的、不再匹配的归属，不删除人工或历史标签。

此版本是单 VLM 的动态标签基线，不含向量聚类/相似搜索或模型微调。发现阶段参考最多八个已有标签名，匹配阶段每批八个遍历全部启用标签；语义近义词合并依赖模型复用名称，尚无独立的语义去重索引。当前模型包支持 Windows x64（NVIDIA CUDA / CPU）及 macOS 13.3+ 的 Intel / Apple Silicon（CPU 推理）；其他平台显示不可安装。模型包保存在应用数据目录 `local-classification/qwen35-08b-b10809-v1`，识别记录/标签/纠正在当前库 SQLite 中，与反推 caption 分离。

后续质量验收：用用户实际素材建立独立标注集，测标签精确率、覆盖率、风格区分、近义标签膨胀及 CPU 耗时/内存；若 0.8B 无法达到要求，再对照更大模型或专用向量匹配模型。未发布、未部署 Cloud、未进行付费模型调用。

## macOS 适配（2026-09-16）

复用同一模型、视觉投影与模型目录，按应用进程架构选择 [llama.cpp b10809 官方包](https://github.com/ggml-org/llama.cpp/releases/tag/b10809)。Intel 应用在 Apple Silicon 的 Rosetta 下仍选择 x64 包，原生 arm64 应用选择 arm64 包。运行时分别解压到 `runtime-macos-x64` / `runtime-macos-arm64`，保留包内 `llama-b10809/`、动态库软链接和可执行权限；Windows 原目录及 `runtime.zip` 缓存兼容。

- Intel：`llama-b10809-bin-macos-x64.tar.gz`，11,175,330 bytes，SHA256 `13b34aa8a5d87341a21065a83f54a8167e1aaa6fe0d66065de01632a1ed64be6`；总下载 748,679,682 bytes。
- Apple Silicon：`llama-b10809-bin-macos-arm64.tar.gz`，11,123,196 bytes，SHA256 `7d692df9e1e386e62f1c12b843903218041e6cd74c9415aa39a7ed3176f9eaa2`；总下载 748,627,548 bytes。
- 两包已实际下载并核对官方 digest；Mach-O 架构与所有二进制的最低系统版本均检查：macOS 13.3。低于该版本不可安装，系统版本仅查询一次。
- 使用绝对路径 `/usr/bin/tar` 及包内 `llama-server`，无需 Homebrew / Python / Node。沿用仅回环监听、随机 API key、可取消子进程、权重校验和 CPU 参数；本轮未启用 Metal 加速。

验证日志保存在本地 `.tmp/local-classification-mac/`。真实推理使用随包 preset 图片及独立模型目录，不读写用户素材库；Apple Silicon 原生推理与新版 Tauri/Finder 完整 GUI 尚待对应机器验收。当次未重新构建 app/DMG；后续已纳入 26.9.17 Mac 包，见 `macOS/README.md`。

本轮最终验证：

- `cargo test --offline --lib --manifest-path apps/desktop/src-tauri/Cargo.toml local_classification -- --nocapture`：**13 passed / 1 ignored**（真实模型另跑）。覆盖 Mac 最低版本、平台选择、中文/空格路径、执行权限、动态库软链接、损坏下载及现有标签/人工保护逻辑。首轮沙箱禁止回环监听造成下载校验测试失败，允许本机监听后最终回归通过。
- `node scripts/local-classification-ui.test.mjs`：安装/停止/重开、标签与示例、错误、深浅主题及窄窗通过，新增不支持系统提示与安装禁用检查。`node node_modules/typescript/bin/tsc --noEmit` 通过；pnpm 快捷入口触发依赖自动安装及网络失败，改用已安装的 TypeScript 执行检查，未修改依赖。
- Intel macOS 26.6.2 真实测试：固定文件校验、正式安装器解压与安装状态、加载、五次本机图像推理及停止均完成，总计 111.84 秒；标签发现返回“产品、化妆品、护肤”，该次发现请求耗时 6.56 秒。自定义“东方诗意插画”正负例及视觉示例匹配结果符合既有断言。
- **真实质量断言未全部通过**：产品图同时命中“产品海报”和“野生动物”，后者为误判，`real_local_model_smoke` 因该负例断言失败。保留原断言、权重与提示词，不为单个平台样本调参；这证明 Mac 安装/推理链路可用，不代表分类准确率验收完成，也不能沿用 Windows 旧记录宣称 Mac 真模型测试通过。
