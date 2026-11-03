# 音频素材库实现与验证

产品范围与有效交互以 [PROJECT.md](../PROJECT.md#关键约定) 为准。本文件记录正式实现协议，独立预览和早期 native spike 不能替代正式组件验收。

## 数据与性能边界

- `media::audio` 使用 Symphonia 0.5.5 流式解码，合并多声道 min/max，保留至多 2048 个桶及实际 `framesPerPeak/totalFrames`。不平均相反声道，不保留全曲 PCM。
- 连接扫描只登记原件、指纹和基本属性，不为全目录生成波形。音频跳过图片尺寸、颜色、感知哈希、自动命名与自动图片分类；`audios` 查询独立于 `images/videos`。现有资料身份、手动标签、集合分身沿用原协议。
- `audio_waveform(assetId, expectedVersion?)` 只读取已登记素材。`expectedVersion` 是实际原件指纹，不得传界面刷新序号。后端校验数据库版本、文件状态和冷缓存原件哈希，解码后复查；完成后仅更新时长，不广播无意义的内容变更。
- Tauri 命令最多同时处理 2 项波形任务，同一素材的冷请求合并。缓存位于资料库 `audio-waveforms/`，版本包含算法、原件路径、指纹与纳秒文件状态；单条上限 512 KiB，目录预算 128 MiB。热读取不重新解码或遍历缓存目录，冷写入按最近访问淘汰派生文件。
- 前端 `audioPreviewPeaks` 最多 2 项并发、64 项峰值缓存。仅可见卡片订阅；移出时删除未启动请求，已经开始的至多 2 项允许完成缓存，旧订阅不能更新新卡片。波形画布按实际像素宽度合并桶，DPR 上限 2；只有可见的播放进度使用动画帧。

## 组件与播放归属

- `FileMediaCard` 在图片预览 hook 之前分派到 `AudioFileMediaCard`。音频卡片、详情及旧集合详情共用 `AudioWaveform`，名称和总时长由外层排版。
- 全应用 `audioPreview` 持有一个 `HTMLAudioElement`，第一次点击才建立，`preload=none`。原件用 Tauri asset URL / Range 读取；波形数据与原件播放分离。
- 播放身份为 `assetId + path + sourceVersion`，普通界面 revision 或时长回填不能误停持续播放。同源再次点击只 seek，不重设 src。
- 临时试听随指针离开、焦点离开、滚动、隐藏或卸载结束。持续播放不归单张卡片生命周期所有；滚动、虚拟卸载、切换媒体与关闭详情均保留。新播放替换旧声音，暂停、Escape、页面退出和关联原件操作会释放播放器。
- 原件改名、移动、回收及所在目录操作在文件 IPC 前释放对应播放句柄；其他目录的音频不受影响。只移动项目成员或操作分身不停止原件播放。修改已知源版本会停掉旧播放并重取波形。
- 控件阻止卡片点击／双击冒泡，多选模式让事件回到卡片；波形支持键盘左右定位、Home／End、Enter／Space 播放。
- 2026-11-03 源码增量：项目创作／详情编辑开启时，全部／标签及真实集合中的音频卡片双击或 Enter 调用已有激活入口，将音频原件加入创作描述；普通素材库仍打开音频详情。波形和播放按钮维持原行为。视频自动模式识别为多参考；Seedance 只接受 MP3／WAV，其他格式明确拒绝，不静默丢弃。音频不进入图片生成，也不创建独立画板音频卡片。协议与验证见 [视频音频记录](../project_logs/2026-11-03-video-audio.md)。

## 格式与测试入口

首版扩展名：WAV、MP3、FLAC、M4A、OGG。已覆盖 PCM WAV、MP3、FLAC、AAC-LC M4A、Vorbis OGG 合成样本；容器后缀不承诺任意内嵌编码。未增加转码副本、在线转写、音频生成或声音理解服务。

在 `apps/desktop` 执行：

```powershell
node --test scripts/audio-media.test.mjs
node scripts/audio-waveform-ui.test.mjs
node scripts/audio-library-ui.test.mjs
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build --outDir .tmp/audio-library-build
```

浏览器完整素材库夹具和性能测量复用仓库合成文件目录 `.tmp/audio-preview-fixtures/`。新环境先按 `spikes/library-audio-preview/README.md` 生成合成文件及真实 peaks（`create-fixtures.mjs` 与 `benchmark.ps1`）；FFmpeg 只用于制造测试输入，正式波形运行不依赖 FFmpeg。单组件脚本自行生成小型 WAV。

在 `apps/desktop/src-tauri` 执行：

```powershell
cargo test --lib core::audio
cargo test --lib media::audio
cargo check --locked --lib
```

浏览器夹具挂载正式 React 组件，IPC 由隔离合成资料模拟，但真实 `HTMLAudioElement.play/currentTime` 不替换。Rust 测试使用临时 SQLite、资料库及合成原件，验证原件不复制、媒体查询、源版本保护、热缓存与失败恢复。最终执行结果和测量环境见 [本轮操作日志](../project_logs/2026-11-01-audio-library.md)。未发布安装包，未操作用户资料库或计费接口；Mac 原生验收单独进行。
