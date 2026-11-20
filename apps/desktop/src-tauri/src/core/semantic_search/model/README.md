# 本机语义搜图模型

语义搜图使用 Google SigLIP 2 Base/224。应用分别加载两个 FP32 ONNX 编码器，使用 ONNX Runtime 1.28.0 CPU，每个会话最多 4 个推理线程。图像转为 RGB，透明像素先合成到白底，再双线性缩放至 224 × 224，并归一化到 `[-1, 1]`。文本统一小写，最多保留 63 个正文 token，尾部加 EOS，补齐到 64 个位置。命令返回是否截断。两个模型都输出 `pooler_output`，要求形状为 `[1, 768]`，随后由搜索层做 L2 归一化。

## 工件来源

原始权重固定在 `google/siglip2-base-patch16-224@75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2`，源模型声明 Apache 2.0。对应 `model.safetensors` 的 SHA-256 为 `612923381c76ec5a9bed335d1c48827e3f2e506ac31b044b63b2031fadee6a0b`。Hugging Face 员工从该 Google 模型发布了 ONNX Community 的分塔导出，固定在 `ba1f3b0843f24bc5417d38e19c37b287d719b2f4`。Google 打包历史在该次导出前只有一次权重上传，其后是分词器、配置和模型卡变化。Google 版本与 ONNX 导出的分词器工件逐字节相同。应用随模型提供原始授权文本及转换归属。 [Google 固定版本](https://huggingface.co/google/siglip2-base-patch16-224/tree/75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2) · [固定 ONNX 导出](https://huggingface.co/onnx-community/siglip2-base-patch16-224-ONNX/tree/ba1f3b0843f24bc5417d38e19c37b287d719b2f4)

| 文件 | 字节 | SHA-256 |
|---|---:|---|
| `text_model.onnx` | 1,129,469,657 | `baf12d941beabafafb14f7b4adb38dc15be18681b964a84410ec53d9d65e6293` |
| `vision_model.onnx` | 371,807,752 | `c0573e3f4140c3a7c4e9cc5912bd6b26a033b46a6a8e8af26cbea262b163bcad` |
| `tokenizer.json` | 34,363,039 | `cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322` |

运行库从 Microsoft 发布的 ONNX Runtime 1.28.0 wheel 提取固定 DLL／dylib、许可证和第三方声明。应用直接调用预编译原生库。Windows x64 新装下载 1,549,395,481 字节，Apple Silicon macOS 14 及以上下载 1,554,782,207 字节。包内文件和运行库均按固定字节数与 SHA-256 校验。完整工件、许可证和通知写入后才提交就绪标记。模型修复可替换同长度的损坏文件。Windows 原生库由进程保持加载，移除模型时保留该运行库。 [Microsoft 官方运行库包](https://pypi.org/project/onnxruntime/1.28.0/)

索引的模型键是 `siglip2-` 后接 SHA-256，输入为文本塔、图像塔和分词器的三个 SHA-256 以及预处理契约，各行用 `\n` 分隔。当前键为 `siglip2-cfb1e19ef6223dd57fe414048afc78ed99f94855e5bb331aabe1cb64d2cc9e95`，由 Rust 用例复算。文本模型使用 32 MiB 的 HTTP 字节范围请求续传。Windows 下载曾在整文件请求中途收到 EOF，固定分段下载后复算得到同一个 SHA-256；隔离 HTTP 用例覆盖偏移恢复与错误的 `Content-Range`。

模型目录创建、下载写入、同步、解压和原子落盘都沿用文件系统提供的错误类型。磁盘容量或配额耗尽时，安装状态返回 `disk_full`。测试注入这两类错误及连接中断，并检查 Windows 的原生盘满／配额错误码。

## Windows 原生验证

2026-11-20 在 Windows x64 上，独立 Rust 进程编译同一份模型与归一化代码，链接桌面应用的同版本依赖。使用验证过的两个 FP32 图、分词器和 Microsoft 原生运行库，验证包准备、两塔加载、有限的 768 维输出和长中文输入截断。两塔均只需本方案列出的 ONNX 文件即可推理。测试在隔离目录中使用应用随附的三张引导图片。

| 中文查询 | 正确图片 | 余弦相似度 | 其余两张最高值 |
|---|---|---:|---:|
| 矿泉水瓶产品摄影 | `asset-007.png` | 0.14716 | 0.00248 |
| 少年和一只小狗 | `asset-011.png` | 0.13245 | 0.04290 |
| 网球运动员挥拍 | `asset-016.png` | 0.13760 | 0.00173 |

三条查询均把对应图片排在第一。Debug 版本的冷态验证、加载与三次图像编码、四次文本编码共 31.84 秒。该样本规模覆盖中文搜索工作链路，真实大库的质量需要独立评估。Apple Silicon 安装工件和内部成员已核对哈希，原生性能需由对应设备测量。

Windows 11 build 26100，Ryzen 7 9700X（8 核／16 逻辑处理器），CPU 线程上限 4。独立优化 Rust 进程复用发布配置的 SHA-256 与相同 CPU 动态库。首次编码总耗时 21.07 秒，其中运行库及分词器验证和加载 2.56 秒，文本塔验证、加载、推理和 L2 归一化 18.51 秒。之后五次文本编码耗时 18.19–21.46 毫秒，中位数 19.68 毫秒。测量在系统文件已有缓存的条件下进行，范围限模型侧，SQLite、分页和界面绘制由各自测试度量。

复验时将固定工件准备到隔离目录，把 `BOWERBIRD_SEMANTIC_MODEL_TEST_ROOT` 指向该目录，然后在 `apps/desktop/src-tauri` 运行下面的命令。

```powershell
cargo test --locked --offline --lib semantic_search_real_fp32_chinese_retrieval -- --ignored --nocapture
```
