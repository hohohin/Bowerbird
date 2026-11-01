# 音频波形独立性能验证

这里只验证音频概览波形、缓存和试听页面的数据接口。没有接入正式素材库、修改应用 Cargo、迁移用户库或发布安装包。测试音频全部合成；现有原件只读，缓存只保存派生峰值。

## 运行

在仓库根目录执行：

```powershell
cargo test --locked --offline --manifest-path spikes/library-audio-preview/Cargo.toml
cargo build --release --locked --offline --manifest-path spikes/library-audio-preview/Cargo.toml
& ./spikes/library-audio-preview/target/release/library-audio-preview.exe ./.tmp/audio-preview-fixtures/chime.wav --cache-dir ./.tmp/audio-preview-fixtures/manual-cache --source-version synthetic-chime-v1 --output ./.tmp/audio-preview-fixtures/chime.peaks.json
```

首次构建需要 Cargo 下载锁文件中的开发依赖。Windows 沙箱若拒绝规范化临时路径或 LTO 临时文件改名，需要在允许该隔离测试目录的环境运行，不能把 OS error 5 当作解码失败。可执行文件不调用 FFmpeg，也不依赖全局音频工具。

`create-fixtures.mjs` 用已有 FFmpeg 合成测试输入；仅此造样本步骤需要 FFmpeg。运行 `node spikes/library-audio-preview/create-fixtures.mjs` 后，可用 `powershell -File spikes/library-audio-preview/benchmark.ps1` 重做一次未命中、五次命中测量。原始结果落在 `.tmp/audio-preview-fixtures/benchmark-*/results.json`。未清空操作系统文件缓存，未命中仅指应用峰值缓存未命中，不代表物理冷盘。

实测数据与复测说明统一见 [PERFORMANCE.md](PERFORMANCE.md)。

## CLI 与页面数据契约

```text
library-audio-preview <input>
  --cache-dir <directory>
  [--output <json-path>]
  [--source-version <verified-revision>]
  [--cancel-file <path>]
```

stdout 和 `--output` 都是完整 JSON；错误输出到 stderr 并返回非零。输出不能指定为原音频；输出和缓存均原子替换，避免中途文件被页面读取。取消文件出现即在下一解码包或发布检查点停止，取消/检测到源变化不发布本次缓存。

| 字段 | 含义 |
|---|---|
| `schemaVersion` | 当前为 1 |
| `duration` | 实际解码帧数 / 采样率，秒 |
| `sampleRate`, `channels` | 源音频采样率与声道数 |
| `peaks` | 最多 2048 组 `[min,max]`，保留所有声道极值，不做声道平均 |
| `framesPerPeak` | 每组覆盖的帧数；最后一组可能不足 |
| `totalFrames` | 实际解码的音频帧数，不乘声道数 |
| `diagnostics.cacheHit` | 本次是否复用磁盘峰值 |
| `diagnostics.decodedFrames` | 热命中为 0；冷请求为本次解码帧数 |
| `diagnostics.sourceBytesRead` | 音频源实际 Read 返回的字节数；可能因探测/seek超过文件大小，热命中必须为 0 |
| `diagnostics.sourceBytes` | 原文件长度 |
| `diagnostics.peakBytes`, `peakCapacityBytes` | 峰值有效负载及固定 16384 字节容量，不代表整个进程内存 |
| `diagnostics.maxDecodedBlockFrames` | 本次最大解码块的帧数；热命中为 0 |
| `diagnostics.timingsMs` | `validation`（初始stat/键）、`decode`（流式解码和归并）、`total`（完整提取/缓存输出对象）；不含CLI进程启动及stdout输出 |

第 `i` 组从 `i * framesPerPeak / sampleRate` 秒开始，结尾取下一组边界与 `duration` 较小值。绘制和指针时间使用真实 `duration`，不能把最后一个不足帧宽的组强行当作完整组。峰值保持线性振幅，不做响度归一化；它不是响度计、频谱或原PCM。

## 提取与缓存

内置 [Symphonia 0.5.5](https://docs.rs/symphonia/0.5.5/symphonia/) 按包解码，开启其格式/codec和SIMD特性及gapless选项。当前固定此成熟API；0.6.1已存在，本验证没有升级生产依赖。每帧合并所有声道的min/max，避免首声道静音和立体声反相抵消。峰值达到2048组时原位两两归并；存储始终有界，时间分辨率随文件长度降低，适合卡片概览，不是编辑器级缩放波形。

缓存键由算法版本/声道策略、规范化原件路径和调用者内容版本构成，同原件的分身共享；不同原件即使恰有相同局部版本也不会串用。没有 `--source-version` 时退回文件大小与纳秒修改时间。热命中只检查stat、读取小型峰值JSON，既不重新读整首音频也不重新解码。读写JSON使用缓冲IO；未变素材重复显示不计算完整SHA。

源stat在解码前后、发布前及缓存读取后核对。**无已验证内容版本时，同大小且人为保留mtime的修改无法检测**；正式接入必须传入已有索引的内容修订。此spike不实现文件监听，也不承诺检测刻意在检查之间修改又恢复的内容。原件移动后路径键改变会重建；尚未做跨路径内容寻址复用。

取消检查按解码包执行；单个解码调用不能即时抢占。并发请求由调用层控制，当前CLI本身没有后台队列或内存播放器。缓存条目单项有界，磁盘目录尚未加入总容量淘汰，不能直接将此spike当作已完成生产缓存服务。

## 验证与边界

`tests/waveform.rs` 有11项行为回归：正常波形/时长、静音首声道、反相立体声、单帧文件、热命中零源读取零解码、源变化和保留mtime的新版本、不同原件版本碰撞、损坏/空音频、合法头部但截断WAV、取消/过期不发布、长短文件峰值及解码块规模、CLI不覆盖原件。其中部分并列场景共用一个测试函数。

先写失败测试，再完成实现；源版本碰撞、截断WAV和CLI覆盖问题均单独见红后修复。最终11/11通过，Clippy所有targets以 `-D warnings` 通过，rustfmt完成。详细操作与失败原因见 [AGENT-LOG.md](AGENT-LOG.md)。

解码器格式支持不等于Windows/macOS WebView可播放格式。当前合成性能样本包含WAV、FLAC、MP3、AAC-LC/M4A；没有宣称已覆盖所有编码。Symphonia 0.5.5没有Opus解码器，AAC支持也不能泛指所有AAC变体。WAV会核对声明长度及解码帧数并拒绝截断；其他容器的损坏检测依赖解复用/解码错误，不承诺识别所有缺少尾部但仍可解码的文件。

浏览器试听必须另行验证自动播放授权、VBR定位和释放；采样缓存不能替代这些验证。Windows/macOS进程内存与冷缓存速度需要使用真实平台数据评估，固定峰值容量不能被表述为固定进程内存。
