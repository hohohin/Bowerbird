# FilmCraft 实现调研与 Bowerbird 轻量剪辑建议

调研日期：2026-10-27。对象为 ArtCraft 官方 [storytold/filmcraft](https://github.com/storytold/filmcraft)，核验源码固定在 `10d626ccc4888e0f020f9ca314c2bc9148ded4f4`，工作区版本 `0.13.0`。本文中的 Bowerbird 建议尚未成为产品决策。

结论：值得借鉴 FilmCraft 的剪辑操作模型、拖拽事务、时间坐标转换和音频主时钟。Bowerbird 更适合沿用 React/Tauri/Rust 与本机 FFmpeg，新增独立剪辑工程，按需移植小块纯逻辑。FilmCraft 的完整 egui、渲染和编解码栈会显著扩大集成范围。

本次核验了官方源码、测试代码、官方说明及 Bowerbird 当前工作区。未编译运行 FilmCraft、未执行性能或音质实测；下文明确区分源码事实、静态推断和建议。源码临时检出位于 `.tmp/filmcraft-research/source`，不作为产品依赖。

## 1. 实现层次与复用边界

FilmCraft 的模块协作与数据流大体为：

```text
egui 面板 / CLI / 自动化客户端
          ↓ Session::execute(command, params)
engine：命令、选区、撤销、任务、工程保存
          ↓
edit：纯剪辑操作       project + time：工程与时间模型
          ↓ 产出工程快照，供下层读取
render / audio：序列求值、画面合成、音频混合
          ↓
预览播放器 / export 编码封装
```

`edit` 只依赖时间、项目模型和错误类型；但 `project` 又依赖 `media/geom/color`，不是可直接替换 Bowerbird asset 模型的独立 UI 组件。`engine`、`render` 的范围进一步扩大。建议先复用算法与操作契约，再判断是否值得引入 crate。[架构][fc-arch]、[edit 依赖][fc-edit-cargo]、[project 依赖][fc-project-cargo]

工程以 `Arc<Project>` 保存。`Session::edit` 克隆候选工程与编辑状态，成功后替换并保存旧快照；错误不提交。`edit_merged` 把同一连续操作合并成一步，`edit_group` 支持多操作成组回滚。后台导出拿冻结快照，编辑可以继续。这里的 Arc 共享有利于读者，但 `edit` 明确会克隆工程，不能理解为任意规模修改都零成本。[Session 与历史][fc-session]

导出队列有进度、取消和重试，但注释明确它是会话状态，不随工程保存。不能据此宣称已具备应用退出后的持久导出恢复。[导出队列][fc-export]

## 2. 剪辑交互

### 2.1 拖拽是一笔操作

`timeline_hit.rs` 负责纯几何命中与操作选择；`timeline/interact.rs` 负责交互状态与命令提交：

1. 按下时记录位置、时间，以及由当时工具和修饰键判定的操作对象，区分片段主体、左右边缘、转场、音量线、标尺和空白区域。
2. 超过拖动阈值后建立 `Drag` 状态；移动过程中绘制预览。
3. 松手才转换为移动、裁剪、滑移或速度伸缩命令。
4. Escape 取消预览。需要连续写入的控制使用合并撤销机制。

这使“拖动一次、撤销一次”成为明确契约。Bowerbird 应把 `pointerdown → preview → pointerup → commit` 与画板拖动分开，确保时间线获得指针与快捷键焦点；数值输入、前后移动按钮和键盘微调应覆盖同一操作。[命中逻辑][fc-hit]、[拖动与提交][fc-interact]、[合并撤销][fc-session]

### 2.2 不同工具修改不同关系

| 操作 | 实际语义 | Bowerbird 建议 |
|---|---|---|
| Split / Razor | 在成片时间处分割，正确换算后一段的素材起点 | 首版 |
| 普通 Trim | 修改片段入点或出点；不自动移动后续内容 | 首版 |
| Ripple Trim / Delete | 修剪或删除后移动后续片段，补齐时长变化 | 首版提供明确“删除并补空”等动作 |
| Roll | 两段交界共同移动，总时长不变 | 后续 |
| Slip | 片段在成片中位置与长度不变，移动素材取用区间 | 后续 |
| Slide | 移动中间片段，同时修剪两侧邻片段 | 后续 |
| Rate Stretch | 保持素材取用量，通过拖动时长反算速度 | 恒速成熟后再开放拖动入口 |

FilmCraft 在底层检查轨道锁定、邻片段、源素材边界及链接的音画片段；不能只改可见矩形宽度。音画链接需要同一组时长和位移约束，否则单独裁剪容易失步。[剪辑代数][fc-edit]、[命令实现][fc-commands]

### 2.3 吸附和视口

`Layout::x_of/tick_at` 统一像素与时间换算；视口状态由 `pps`（每秒像素数）与 `scroll` 构成。吸附搜集片段两端、播放头、标记及入出点，按屏幕像素距离选最近候选，并排除正在移动的片段；拖播放头时还排除播放头自身。缩放后手感不会随“固定秒数阈值”剧烈变化。[坐标转换][fc-layout]、[吸附][fc-snap]

Bowerbird 建议保留：鼠标位置或播放头锚定缩放、拖到边缘自动滚动、可见区裁切、明确吸附线与临时关闭吸附、帧级微调。片段内容用 Canvas 绘制缩略图和波形，按钮与可访问操作保留 DOM；不为每个音频样本或视频帧创建元素。

FilmCraft 的连续胶片只申请视口交集内的缩略图，缩放过程中冻结原采样网格，结束后再更新，能避免每一帧缩放都发起解码；值得借鉴。当前吸附仍扫描全序列，自动滚动按每帧固定像素推进。Bowerbird 可按规模增加边界索引，并把滚动速度写为每秒像素乘真实时间差。[缩略图采样][fc-clips]、[交互循环][fc-interact]

### 2.4 不宜照搬的地方

静态代码显示，FilmCraft 的部分拖动预览比最终操作简化：`preview_drag` 对 Trim 没有完整模拟 Ripple 模式的后续移动；Slide 预览主要移动主体；Rate Stretch 的预览与最终最短帧/邻片段约束不完全同路。可能出现松手前后位置变化，这是源码推断，尚未运行复现。[预览与提交][fc-interact]、[实际裁剪约束][fc-edit]

建议 Bowerbird 用同一个纯函数求候选工程：拖动时绘制返回结果，松手提交同一结果。候选需绑定工程 revision、gesture ID 与手势内递增序号，丢弃迟到 IPC 回应，提交核验基准版本。避免维护一份“画矩形的近似逻辑”和另一份真正编辑逻辑，也避免旧快照覆盖新编辑。

## 3. 时间线与时间模型

### 3.1 素材、片段和序列分开

FilmCraft 的 `TrackItem` 是素材在序列中的一次使用，含 `item`、`start`、`duration`、`source_in`、`speed`、`reverse`、链接组与音量等信息。同一素材可被重复引用，各实例独立裁剪。轨道项目按 start 排序，`item_at` 使用 `partition_point` 寻找覆盖当前时间的片段。[片段和轨道模型][fc-track]

正向恒速的关系为：

```text
成片片段长度 D = (sourceOut - sourceIn) / speed
素材时间 S(t) = sourceIn + (t - timelineStart) × speed
```

例如素材 2–8 秒按 2 倍速使用，成片占 3 秒；在成片片段内第 1 秒处分割，对应素材第 4 秒。后半段从素材第 4 秒开始，而不是第 3 秒。

源媒体时间、序列时间、屏幕坐标必须分层：编辑存时间；缩放只改变投影；显示时码只负责表达。倒放还需半开区间与帧边界处理，不能机械把速度乘负数后随意夹到零。[时间类型][fc-time]、[倒放取帧][fc-render]

### 3.2 整数时间值得学，常量不宜直接搬到 JS

FilmCraft 使用 `Tick(i64)`，每秒 `254,016,000,000` ticks，常见帧率以 `num/den` 表示，可精确表达常见音视频采样间隔；范围使用 `[start, end)`。但速度字段仍为 `f64`，速度映射有乘法及四舍五入，不能把它描述成整个系统完全不使用浮点数。[time][fc-time]、[source_time_at][fc-track]

Bowerbird 的权威剪辑逻辑建议放在 Rust，用整数时间、有理数帧率及显式的舍入规则；TS 只负责显示和候选操作。若沿用 FilmCraft 的高精度 ticks，IPC 应用十进制字符串/显式 BigInt 编解码：JS 安全整数只能精确容纳约 9.85 小时的这种 ticks。也可另选时间表示，但微秒也不天然整除所有帧率，仍需基于有理数求位置，不能累计浮点帧时长。

## 4. 变速：已实现与未闭环的边界

| 能力 | 源码核验 | 对 Bowerbird 的含义 |
|---|---|---|
| 固定速度 | 输入速度后重算时长；有邻片段及链接处理；速度对话框的时长仅显示 | 适合作为首版范围 |
| 倒放 | 独立 reverse 状态；视频取帧含帧边界修正，音频也有反向采样 | 需独立验收头尾与音频，优先后置 |
| 速度伸缩 | 拖动长度、保持源区间并反算速度 | 普通 trim 与 rate stretch 必须有清楚的入口区别 |
| 曲线变速 | 有 `time_remap` 的 speed 参数/动画入口；`source_time_at` 明确忽略 remapping，当前渲染/音频路径未见消费该速度曲线 | 不能视为端到端完成 |
| 片段变速保音高 | `raw_channels` 按速度取样并线性插值；这是重采样，会变调 | Bowerbird 应单独实现与验证保调 |
| 正向 shuttle 播放保调 | 有专用处理；0.5–4 倍范围外及反向 shuttle 音频静音 | 不能当成片段导出已保调，也不等于倒放片段没有声音 |
| 慢动作插帧 | 有 Frame Sampling、Frame Blending，以及实际 `flow::interpolate` 光流实现 | 光流成本与质量另验，不纳入轻剪辑首版 |

依据：[速度命令][fc-speed-command]、[速度编辑][fc-speed-edit]、[映射][fc-track]、[音频重采样][fc-audio]、[shuttle][fc-shuttle]、[实际画面渲染][fc-render]、[光流实现][fc-flow]。特别注意：`track.rs` 中 OpticalFlow“暂按混帧”的注释已落后于实际 render 调用，不能只读枚举注释下结论。

Bowerbird 首版建议仅做每片段正向固定倍速，先验证 0.5–2 倍；0.25/4 倍可以在质量验收后扩展。视频导出通过 `trim + setpts=(PTS-STARTPTS)/speed`，音频通过 `atrim + asetpts` 与 tempo 处理，统一重置时间戳和目标规格再拼接。FFmpeg `atempo` 支持链式组合；官方说明单次参数大于 2 时可能跳过样本，扩大范围时应制定分解策略。[FFmpeg setpts](https://ffmpeg.org/ffmpeg-filters.html#setpts_002c-asetpts)、[FFmpeg atempo](https://ffmpeg.org/ffmpeg-filters.html#atempo)

预览里的 `playbackRate/preservesPitch` 可以用于早期适配验证，但其音质、可用速度范围与 FFmpeg 导出并非同一实现；必须对比真机预览与成片。曲线变速需要统一的积分映射 `S(t)=S0+∫v(u)du`、反求、源边界及音频伸缩；仅画一条贝塞尔曲线不构成曲线变速实现。

## 5. 音频波形

这里的“音波”按时间线音频振幅波形理解，区别于调色用亮度 waveform 和频谱图。

### 5.1 FilmCraft 怎样提取和绘制

`source_peaks` 用 48 kHz 输出读取音频，每次 4 秒，每 256 个样本计算一组 min/max（约 5.33 ms）；当前取音频流的第一个声道。`request_peaks` 按 `(itemId, audioStream)` 缓存 `Arc<Vec<(f32,f32)>>`，pending 列表避免重复任务；原生在线程提取，WASM 分支直接运行该闭包。[波形实现][fc-waveforms]

绘制只覆盖视口可见区。每个像素对应一个成片时间范围，再映射回素材的峰值区间，取绝对最大值画柱；因此剪切或恒速变化通常可复用原始峰值，不必重新解码整段音频。显示叠加 clip gain 与 Volume，默认采用 -48 到 0 dB 的对数高度；为了让安静录音可读，源波形可自动增益，最多 +12 dB。它是经过显示处理的波形，不能直接当作严格响度计。[绘制与显示增益][fc-waveforms]

嵌套序列的波形来自混音结果，按音频片段内容 hash、序列长度与采样率判断失效，更新过程中保留旧波形。普通素材峰值使用 item/stream 标识；该缓存实现未见多精度层、磁盘持久化或 LRU 预算。[缓存状态][fc-timeline]、[序列峰值][fc-waveforms]

### 5.2 Bowerbird 应借鉴和补足什么

- 复用“后台解码 → min/max 数据 → 可见区绘制”，而不是截一张波形图片后无限拉伸。
- 缓存按源文件指纹、音轨、声道和算法版本寻址；本地文件可变，仅 asset ID 不足以判断仍然有效。移动路径与内容变化应区别处理。
- 保存基础峰值并逐级合并成较粗层，根据缩放选择层级；只加载视口附近块。缩小时保留瞬态峰，不用平均值代替 peak。
- 立体声可上下显示或明确合并两声道峰值；不要因第一声道静音而把整个片段显示为空。
- 修改裁剪、位置、速度重算映射；修改音量重绘显示；修改文件才重提取源波形。缓存有预算、取消、失败重试及过期结果保护。
- 倒放聚合必须对映射后的区间取 min/max 再遍历。FilmCraft 当前 `s1.max(s0+1)` 在倒放时只会扫到一个 bucket，缩小视图可能漏峰；这是静态推断，未做运行复现。

首版可先做有界的单层峰值缓存，但接口应区分“源数据”和“显示分辨率”，避免后续分级缓存必须重做工程模型。

## 6. 播放同步决定可用性

FilmCraft 原生播放优先以音频输出层报告的已播放样本帧数作为时间源，画面跟随音频；设备不可用或停滞时回退墙钟，并尽量保持连续位置。音频预混到 SPSC 环形缓冲，回调读取数据；预混欠载补静音并同步推进混音位置。视频有预取和来不及时的丢帧策略。[播放时钟][fc-playback]、[音频预混][fc-play-ahead]

Bowerbird 应先验证播放方案再扩 UI：单源拖动定位可沿用 `<video>`；连续多片段播放需要集中调度、有限的播放器池、预热下一段、明确主时钟和迟到帧丢弃。React 状态更新或 `setInterval` 只能刷新显示，不能成为声画的权威时钟。

若加独立 BGM，需同步原声与 BGM，处理 seek、暂停、速度变更及切片边界。WebView2/WKWebView 无法满足要求时，可使用同一编辑计划生成低分辨率预览代理；不能靠持续并行 seek 多个 video 元素承诺无缝播放。真实媒体生命周期与播放质量需要单独 spike。

## 7. Bowerbird 已有基础与缺口

| 模块 | 已有能力 | 需要增加 |
|---|---|---|
| `VideoPlayer.tsx` | 单视频播放、胶片 seek、入出点裁剪；0.1/0.01 秒细调 | 多片段编辑视图、帧率感知；当前细调不等于逐帧 |
| `lib/videoFrame.ts` | 串行 12 张缩略图、当前帧/尾帧 PNG | 分块缓存、按缩放采样、任务预算 |
| `commands/video_trim.rs` | FFmpeg 裁剪、另存/覆盖、入库、文件归属 | 统一编辑计划、多片段编译、速度与混音 |
| `media/probe.rs` | 尺寸、时长等基本元数据 | 帧率/时间基、VFR/时间戳、音轨/声道/采样率 |
| `media/tools.rs` | 统一 FFmpeg/ffprobe 发现、缓存、隐藏子进程 | 面向剪辑用户的工具可用性与交付方案 |
| `CanvasWorkspace.tsx` | 视频入画板、固定发起项目与落点、迟到结果隔离 | 剪辑工程卡片及成片回流 |

当前 `trim_video` 是同步 IPC、进程内 semaphore 与 300 秒超时，没有持久的渲染进度、取消和重启任务恢复。SQLite 0038 的 `creative_file_queue` 是随图资料 JSON 队列，不能复用其名字来宣称视频导出队列已经存在。[裁剪实现](../apps/desktop/src-tauri/src/commands/video_trim.rs)、[资料队列](../apps/desktop/src-tauri/sql/0038_creative_file_queue.sql)

当前 Windows 文档明确不随安装包附带或自动下载 FFmpeg。轻剪辑若以 FFmpeg 为执行层，工具发现/安装/交付就是首版可用性的前置问题。[Windows 环境要求](../Windows/README.md)

现有 `CreativeTimeline` 和 `projectTimelineProjection` 是生成与 Agent 执行历史，不是媒体时间轴。画板横坐标也不决定成片顺序，应新增项目内独立剪辑文档。[项目画板契约](PROJECT-CANVAS-PLAN.md)

## 8. 建议的最小形态

入口可放在视频右键“加入剪辑”和画板工具箱；打开专用编辑面板，上部预览、下部时间线、侧边片段参数。工程属于当前项目，画板卡片保存工程 ID；导出后沿现有流程成为新视频素材。源素材保持引用关系，剪辑操作不修改原文件。

首版范围建议：一个主视频轨、关联原声、一个可选 BGM 轨；拼接、分割、两端裁剪、重排、删除补空、吸附、撤销重做；片段恒速、静音、音量与淡入淡出；一个固定成片规格和 MP4 导出。若 BGM 同步未过 spike，可先交付主轨与原声闭环，再开放 BGM。曲线变速、光流、多层画面合成、复杂转场、混音台和嵌套序列后置。

```text
React 编辑面板
  ├─ 指针/快捷键 → 候选 edit operation
  ├─ 时间线与波形可见区绘制
  └─ 播放适配器
             ↓ Tauri
Rust 剪辑核心
  ├─ EditDocument + revision + undo/redo
  ├─ evaluate(operation) → 同一份预览与提交结果
  ├─ media metadata / thumbnail / peak 缓存
  └─ compile(frozen document) → render plan
             ↓
FFmpeg 导出任务 → 临时成片 → 校验/原子完成 → 入库/原项目画板
```

工程至少区分：`documentId/projectId/revision`、输出帧率与尺寸、轨道、片段 ID、asset ID、素材入出点、序列位置、速度与音频设置。初期建议让 Rust 持有权威纯编辑逻辑，前端持有显示快照和暂存手势；不让 UI 与导出各自解释一套速度/裁剪规则。

导出创建时冻结工程版本和输入指纹；编辑继续进行，结果仍标注原版本。任务保存状态、进度、取消和错误，重启后将未完成任务标为中断并允许重新导出；这与编码过程中途续传是不同能力。先验证临时文件，再原子完成并入库，避免失败留下假成片。

## 9. 建议实施次序与验收

| 阶段 | 可评审交付 | 必须验证 |
|---|---|---|
| A 媒体 spike | 2–3 个真实素材的拼接、变速、音频、预览/导出样本；工具可用性结论 | Windows/Mac 解码、声画同步、长 GOP/VFR、保调质量 |
| B 编辑核心 | 独立工程、split/trim/move/delete、吸附、撤销、保存恢复 | 半开区间、源边界、分割恒速片段、拖动取消、一次手势一步撤销 |
| C 音频与速度 | 峰值缓存、音量/淡变、固定倍速、原声及可选 BGM | 波形与瞬态对齐、左右声道、静音、变速后长度与音高 |
| D 可靠导出 | 冻结工程任务、进度/取消、失败重试、成片回流 | 失败不覆盖源、取消无假成片、重启识别中断、跨项目迟到结果 |
| E 性能和原生验收 | 可见区绘制、缓存预算、播放器释放、双端交互 | 长时间编辑、反复 seek/开关面板、低内存、实际系统 WebView |

测试优先使用带帧号/颜色段的视频和已知时刻的音频脉冲：

- 源 2–8 秒、2 倍速应为 3 秒；切分后合并不重复或漏掉边界帧。
- 23.976/29.97、手机 VFR、旋转视频、混合分辨率、无音轨与立体声都应覆盖。
- 持续单音在开启保调后频率不应随速度倍增；真实人声另听测伪影。
- 缩放和裁剪后峰值位置一致；取消过期抽样任务不污染新素材。
- 波形、预览、导出对同一工程版本和速度映射求值；不能只测试按钮是否可点。
- 多片段连续播放重点测切口处的黑帧、静音缺口和长时漂移。

Bowerbird 现有 `video_trim_tests.rs` 已有长 GOP/三色/音频夹具，前端 `video-trim-ui.test.mjs` 已覆盖保存失败与跨项目迟到结果，可从这些验证方式扩展。本次仅阅读这些测试，没有重新运行，也未修改应用代码。

## 10. 许可与资料

仓库声明 `MIT OR Apache-2.0`；`NOTICE` 单列 ArtCraft 名称和标志不包含在源码许可中，第三方素材另列归属。若后续实际复制代码或发布依赖，应保留所选许可要求的声明并按所用文件核对第三方条目。[Cargo manifest][fc-manifest]、[NOTICE][fc-notice]

## 11. 体积与性能预算（2026-10-27 补充）

估算范围：复用现有 React/Tauri/Rust，新增轻剪辑核心，以本机 FFmpeg 执行媒体处理；一个主视频轨、原声、可选 BGM，1080p30、1–3 分钟、10–30 片段，不引入 FilmCraft 整套渲染与编解码栈。以下增量均为设计预算，未实现、未构建对比或性能实测。

### 安装包与工具组件

- 已发布 Windows 26.10.2401 安装包为 **84,750,683 bytes，约 84.8 MB**，见 [发布证据](DESKTOP-UPDATES.md)。当前本地前端 dist 的 JS/CSS 合计约 2.12 MB，属于已有资源；剪辑界面可以复用 React、Zustand 和 WebView，无需新增浏览器运行时。
- 2026-10-27 读取 [Gyan Windows 构建页](https://www.gyan.dev/ffmpeg/builds/)：当时 essentials 7z 整包标为 34 MB。另只读取 `ffmpeg-9.0.2-essentials_build.zip` 末尾 128 KiB 的中央目录，核实 ffmpeg.exe 为 **105,423,872 bytes**，ffprobe.exe 为 **105,221,120 bytes**，两者合计 **210.6 MB**；ffplay 不属于本方案运行必需组件。未下载或执行这些二进制。
- 同一 ZIP 中这两个 exe 的压缩条目合计 74.7 MB；完整 ZIP 为 114.8 MB。7z、ZIP 和 NSIS 压缩结果不同，不能用“34 MB 下载包”代替“211 MB 安装后占用”。

| 交付策略 | Windows 主安装包预计增量 | 使用剪辑后额外磁盘占用，不含素材/缓存 |
|---|---|---|
| 复用用户已安装的 FFmpeg | 约 1–5 MB | 约 3–15 MB；用户已有工具不重复计算 |
| 首次使用下载媒体组件（建议） | 约 1–5 MB；另预留 30–60 MB 的 7z/LZMA 组件下载预算 | 约 210–230 MB；媒体组件独立缓存和更新 |
| 通用 FFmpeg 随主包附带 | 约 30–65 MB | 约 210–230 MB |

因此，以当前已发布 Windows 包作参照，按需下载方案主包可先预算 **86–90 MB**；随包内置方案约 **115–150 MB**。这是只叠加轻剪辑的情景计算，不包含其他未发布增量。最终要以相同 release 配置、相同压缩器的前后两份构建核验。自定义裁剪 FFmpeg 或共享库打包有进一步减小体积的空间，但未编译前不计入预算收益；Mac 每个架构需要独立测量，不能直接套用 Windows 文件大小。

### 运行资源

按只保留当前和下一段、最多 1–2 个活动解码器估算；内存为相对同一 Bowerbird 基线的额外占用。

| 状态 | 初始资源预算与影响 |
|---|---|
| 未打开剪辑 | 按需加载，不运行解码/抽波形任务，不应有持续 CPU/GPU 负载 |
| 打开后暂停 | 额外约 50–150 MiB 内存 |
| 1080p 连续预览 | 额外约 150–400 MiB 内存，GPU 资源约 50–200 MiB |
| 导出 | FFmpeg 子进程再预留约 0.3–1 GiB 内存；编码显著使用 CPU/GPU，不能视为后台无成本 |
| 关闭编辑器 | 停止播放器、音频上下文、抽样任务和刷新循环，释放大缓存；仍在导出的任务继续消耗资源 |

集显和 Apple Silicon 的共享/统一内存可能在不同统计项中重复出现，RAM 与 GPU 数字不能机械相加。上述预算也不是硬上限；输入编码、长 GOP、分辨率、硬件解码支持和同时活动的 decoder 数量都会改变结果。释放资源后操作系统/WebView 工作集也不一定立即下降。

量级依据：1080p RGBA 一帧约 7.91 MiB，4K 一帧约 31.64 MiB；8 帧缓冲分别约 63/253 MiB。48 kHz 立体声 float32 的 3 分钟 PCM 约 65.9 MiB，应流式处理；同样长度、每 256 samples 一组双声道 min/max 波形仅约 0.515 MiB，二倍递减的完整多级峰值缓存小于 1.03 MiB。100 张 320×180 解码缩略图约 22 MiB。波形绘制本身很轻，首次音频解码与快速 seek 才是主要成本。

普通短工程的缩略图和波形磁盘缓存可先预算数 MB 至数十 MB。代理视频按 2–4 Mbps 计算，每分钟约 15–30 MB，3 分钟约 45–90 MB，另加音频/封装。缓存应按去重后的源素材时长估算：30 分钟原片剪成 1 分钟，若全源抽样仍需处理 30 分钟素材。

性能控制建议：编辑器独立懒加载；播放器池限定 1–2 个；只绘制可见片段；缩略图/波形任务限并发；导出单任务并限制线程，不同时打开全部源文件的解码器；导出或 H3 生成时降低预处理优先级。4K 单帧约为 1080p 的 4 倍、4K60 像素吞吐约为 1080p30 的 8 倍，宜先用 720p/1080p 代理预览。CPU 百分比、导出耗时与播放是否稳定必须用指定设备和媒体实测，当前不给无依据的固定值。

下列 FilmCraft 链接全部固定到本次研究 commit，避免 main 变化导致结论与源码错位。

[fc-arch]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/docs/architecture.md
[fc-manifest]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/Cargo.toml
[fc-notice]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/NOTICE
[fc-edit-cargo]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/edit/Cargo.toml
[fc-project-cargo]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/project/Cargo.toml
[fc-session]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/engine/src/lib.rs#L890
[fc-export]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/engine/src/export_tools.rs#L13
[fc-hit]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/ui-egui/src/panels/timeline_hit.rs
[fc-interact]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/ui-egui/src/panels/timeline/interact.rs
[fc-edit]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/edit/src/lib.rs
[fc-commands]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/engine/src/commands.rs
[fc-layout]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/ui-egui/src/panels/timeline/layout.rs#L24
[fc-snap]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/ui-egui/src/panels/timeline/snap.rs
[fc-track]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/project/src/track.rs#L50
[fc-time]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/time/src/lib.rs
[fc-render]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/render/src/lib.rs#L564
[fc-speed-command]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/engine/src/commands.rs#L1884
[fc-speed-edit]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/edit/src/lib.rs#L1158
[fc-audio]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/render/src/audio.rs#L377
[fc-shuttle]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/ui-egui/src/shuttle.rs
[fc-flow]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/render/src/flow.rs
[fc-waveforms]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/ui-egui/src/panels/timeline/waveforms.rs
[fc-timeline]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/ui-egui/src/panels/timeline.rs#L100
[fc-playback]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/ui-egui/src/app/playback.rs#L193
[fc-play-ahead]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/ui-egui/src/play_ahead.rs
[fc-clips]: https://github.com/storytold/filmcraft/blob/10d626ccc4888e0f020f9ca314c2bc9148ded4f4/crates/ui-egui/src/panels/timeline/clips.rs#L124
