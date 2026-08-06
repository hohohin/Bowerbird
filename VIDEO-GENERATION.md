# 生成系统总规划（并行生成 + 视频生成 v1）

> 状态：**规划定稿（待实现）**，2026-08-06。基于两轮 grill + dreamina CLI 真机 spike（实测，非文档推测）。
> 定位：**生成系统下一步的实现权威源**。整合两件事——① 视频生成（用户主线诉求）；② 并行生成（视频的前置架构，图片也受益）。开工前必读。
> 关系：与 [PROJECT.md](PROJECT.md)（活文档）、[AI-PROVIDERS.md](AI-PROVIDERS.md)（provider 抽象）互补。provider 抽象/即梦图片链路细节见 AI-PROVIDERS.md，本文只讲并行 + 视频新增面。
> 分支：**基于 `dev`**（即梦图片 provider 已在 `dev`；`origin/main` 仍是 codex-only）。

---

## 1. 背景与目标

图片生成全链已通（创作板 ProseMirror → `codex_create_image` → `GenProvider{codex|jimeng}` → `ingest_generated` → `generation_meta` + `generation_session_id` → `GenerationPanel`）。本规划交付两件相互耦合的事：

| 诉求 | 内容 |
|---|---|
| **视频生成**（主线） | 复用创作板，点图+打字生视频，体验同生图；走即梦 dreamina CLI（无其它 provider）；工具栏有时长/比例/模型 options；入库回看同图片 |
| **并行生成**（前置） | 把当前「单任务单槽」生成重构为「多 job + 队列 + 持久化 + 恢复」模型，用户可同时发起/迭代多个生成任务，互不阻塞 |

**为什么并行生成是视频的前置**（spike 实证驱动，见 §2/§3）：
1. 视频生成慢（分钟级 + 长队列），单槽模型下用户发起一个视频后被完全锁死，无法同时生图或迭代。
2. **即梦视频同账号并发上限 = 1**（spike 实测 `ExceedConcurrencyLimit`）→ Bowerbird 侧必须做提交队列，用户感知「并行排队」。
3. 视频任务必须持久化 `submit_id` 以便取消/重启后取回（spike 实证「孤儿任务」）——这与多 job 模型共享同一套数据结构。
4. 多 job 模型对图片也有独立价值（并行迭代多组图）。

→ 结论：先做并行生成 MVP（Phase A），再在其上做视频（Phase B）。Phase A 不做也是技术债，做了图片直接受益。

---

## 2. 真机 spike 实证（2026-08-06）

环境：dreamina `a857341-dirty`（构建 2026-07-31，spike 中途由 `b5ccc5d` 升级；**seedance2.5 需 a857341+**）/ Win11 / maestro 余额 10969。**全部实测，非文档推测。**

### 2.1 五个视频命令参数（`-h` 实测）

| 命令 | 必需参数 | model 可选值（默认） | duration | ratio | video_resolution |
|---|---|---|---|---|---|
| `text2video` | `--prompt --video_resolution` | 2.0/2.0fast/2.0_vip/2.0fast_vip/2.0mini/**2.5**(默认,VIP) | 4-15s；2.5→4-30s（默认5） | **可设** 6 档 | 必需；2.5→480p/720p，_vip→720p/1080p/4k，其它→720p |
| `image2video` | `--image --prompt --video_resolution` | 1.0fast/1.5pro/2.0 family/**2.5**(默认,VIP) | 1.0fast 5-10/1.5pro 5-12/2.0 family 4-15/2.5 4-30 | **不可设**（从图推断） | 同上 |
| `frames2video` | `--first --last --video_resolution` | 1.5pro/2.0 family/**2.5**(默认,VIP) | 1.5pro 5-12/2.0 family 4-15/2.5 4-30 | **不可设**（从首帧推断） | 同上 |
| `multiframe2video` | `--images(2-20) --video_resolution` | **固定不可配**（不含 2.5） | 分段：每段 1-8s，总≥2（默认3/段） | **不可设**（从首图推断） | 720p 或 1080p |
| `multimodal2video` | ≥1 个 `--image`/`--video` + `--video_resolution` | 2.0 family+mini+**2.5**(默认,VIP) | 4-15s；2.5→4-30s | **可设** 6 档 | 同 text2video |

- **ratio 只有 6 档**：`1:1 / 3:4 / 16:9 / 4:3 / 9:16 / 21:9`（图像 7 档多 `2:3`/`3:2`，视频不支持）。
- **图生视频类（image/frames/multiframe）ratio 从输入图推断，不可设** → 工具栏 ratio 仅对 `text2video`/`multimodal2video` 有效。
- `multiframe2video`：2 图用简写 `--prompt`+`--duration`；**3+ 图用 `--transition-prompt`（N-1 个）+ `--transition-duration`（N-1 个）** 描述相邻帧间过渡。
- `multimodal2video` 输入上限（2.0 family）：image≤9/video≤3/audio≤3，audio 2-15s；**2.5 下大增**：image≤30/video≤10/audio≤10/total≤50，且支持纯音频输入。
- **seedance2.5**（dreamina `a857341+`，2026-07-31 升级后）：text2video/image2video/frames2video/multimodal2video 支持，**multiframe2video 不支持**（模型固定）；统一约束 **480p/720p、4-30s、VIP-only**；非 VIP 回退 `seedance2.0fast`。
- 所有命令有 `--session int`（默认 0「默认对话」）→ **即梦原生支持任务归组**，可直接用于 job/session 管理。
- `--poll N`：submit 后每秒轮询、最多 N 秒，超时 CLI 退出保留 `submit_id` 事后 `query_result` 续查。

### 2.2 行为实测

| 项 | 实测结果 | 影响 |
|---|---|---|
| text2video（fast/5s/16:9/720p） | 提交即扣 **10 积分**，5min+ 仍 `querying`（`queue_length 570220`） | 视频远慢于图像；**提交即扣分** |
| 同账号并发第二个任务 | `gen_status=fail`，`fail_reason=api error: ret=1310, message=ExceedConcurrencyLimit` | **即梦视频并发上限=1**（同账号同时只 1 个进行中） |
| fail 是否扣分 | **不扣**（image2video fail 后积分不变） | 失败/被拒任务无成本 |
| 图像生成积分 | `credit_count=0`（maestro 免费，历史 image2image 实证） | 图像与视频成本模型不同 |
| 排队速度 | queue_idx ~19 位/1.5min（极慢） | 单视频从提交到完成可能十几分钟到更久 |
| `list_task` 实证 | 发现一条 Bowerbird 历史即梦图片任务卡在 `querying`（本地超时退出、远端仍在） | **孤儿任务**实证 → 必须持久化 + 恢复 |

### 2.3 stdout JSON 结构（实测）

提交/查询（querying）：
```json
{ "submit_id": "...", "logid": "...", "gen_status": "querying",
  "credit_count": 10,
  "queue_info": { "queue_idx": 24200, "priority": 1, "queue_status": "Queueing", "queue_length": 570220 } }
```
`list_task` 单项（含来源标签）：
```json
{ "submit_id": "...", "prompt": "...", "gen_task_type": "text2video|image2video|image2image|...",
  "gen_status": "success|querying|fail", "fail_reason": "...",
  "result_json": { "images": [{"width":..,"height":..}], "videos": [] },   // success 时仅尺寸，无 url
  "commerce_info": { "credit_count": 10,
    "triplets": [{"resource_type":"aigc","resource_id":"generate_video","benefit_type":"dreamina_seedance_20_fast"}] } }
```
- `success` 的 `result_json` **只含尺寸，不含 url/path** → 下载必须 `query_result --submit_id=<id> --download_dir=<dir>`。
- `query_result -h`：仅 `--submit_id` + `--download_dir`。
- `list_task -h`：`--gen_status` / `--gen_task_type` / `--limit` / `--offset` / `--submit_id`。

### 2.4 待确认（后台 spike 进行中）

- [ ] **视频下载文件命名与容器/编码**：后台轮询 25min（50 次，queue_idx 24219→23775，~18 位/min）仍 `querying` 超时，**未取得 success 样例**；留待 Phase B0 真机跑通确认。按图像命名规律（`{submit_id}_image_N.png`）推测为 `{submit_id}_video_N.mp4`。该 submit_id `6cfdfc1f-a21e-4a8b-b662-a4deb95d56b9` 远端仍在排队（已扣 10 积分），可在即梦 Web 端查看最终结果。
- [ ] 各模型积分差（vip/fast/3.5pro、720p/1080p/4k、5s/10s）。
- [ ] `multiframe2video` 分段语义真实样例（需准备多图素材）。
- [ ] 即梦**图片**是否也有并发上限（未测；图像免费但可能仍受并发约束）。

---

## 3. 关键架构约束（spike 推导）

1. **即梦视频并发 = 1** → Bowerbird 侧必须串行提交视频任务（队列），用户感知「我发起多个，它们排队跑」。codex 不受此限；即梦图片并发待测。
2. **提交即扣分 + 排队长** → 任务必须异步、持久化、可恢复；UI 不能阻塞等待，必须显示队列/状态。
3. **fail 不扣分 + 并发限制可恢复** → 遇 `ExceedConcurrencyLimit` 应自动重试（排队等名额），而非直接报错给用户。
4. **孤儿任务存在** → app 启动需扫远端未完成任务（`list_task` + 本地 job 表）续查/取回。
5. **取消 ≠ 远端取消** → 本地 kill 后远端可能仍在运行/已扣分；UI 须诚实明示。
6. **ratio/model 随命令变化** → UI 选项须按当前视频命令（由输入图数量决定）动态约束。

---

## 4. 关键决策（grill + spike 修正）

| # | 决策 | 选择 |
|---|---|---|
| 1 | 视频输入模式 | 全部 5 种命令 |
| 2 | 创作板承载 | 同一块板，工具栏加 **图片/视频** 切换 |
| 3 | 视频多轮 | 即梦无视频会话 resume → 续轮 = `image2video`/`multiframe2video` 把上轮结果作输入重新提交（与图片 `image2image` 对称，复用现有续轮） |
| 4 | 取消策略 | 停本地 CLI + **持久化 submit_id** 可事后取回；UI 明示远端可能仍在/已扣分 |
| 5 | 工具栏 options | **时长 + 比例 + 模型**（比例仅 text2video/multimodal2video 可用；模型按命令过滤；不暴露分辨率/张数） |
| 6 | 入库时机 | 自动入库（同图片，`source="jimeng"`） |
| 7 | 音频 | 含 multimodal2video 但**不上传音频**（只图/视频参考） |
| 8 | 默认值 | 时长 5s；模型默认 `seedance2.5`（a857341+，VIP-only，480p/720p、4-30s；**非 VIP 或 2.5 不可用回退** `seedance2.0fast`）；multiframe2video 模型固定不可选；比例复用现有 |

> **s2 修正**：①「比例工具栏对视频普遍有效」错误——图生视频类 ratio 从图推断，工具栏需按命令动态置灰；② 默认模型统一 `seedance2.5`（dreamina `a857341+`，VIP-only，480p/720p、4-30s；非 VIP 回退 `seedance2.0fast`），覆盖即梦各命令默认的 `_vip`；③ multiframe2video 模型固定，2.5 不适用。

---

## 5. 前置：并行生成设计（Phase A）

### 5.1 现状（单任务单槽）

- 前端 [store.ts:530](apps/desktop/src/store.ts#L530)：`if (get().generating) return`；单会话状态 `genTurns/genSessionId/genStreaming`；`applyGenChunk` 只服务当前会话；`viewGenerationHistory`/`retryLastGenTurn` 均被 `generating` 阻塞。
- 后端 [codex.rs:455](apps/desktop/src-tauri/src/commands/codex.rs#L455)：全局 `GENERATE_CANCEL: Mutex<Option<oneshot::Sender>>`，**无 job id**；`codex://chunk` 事件不带 job 区分；命令 invoke 后阻塞到完成/取消。
- [task_queue.rs](apps/desktop/src-tauri/src/core/task_queue.rs)：只有 `enqueue/next/mark_*/count` 原语，**无 worker、无 cancel、无 submit_id 字段、无并发控制**（`payload` 是 JSON 可塞）。

### 5.2 目标模型：多 job

```
GenJob {                          // 一个生成任务（首轮；续轮是 job 内的 turn）
  id: ulid,
  media: image|video,
  provider: codex|jimeng,
  status: queued|submitting|running|downloading|ingesting|done|failed|cancelled_local,
  submit_id?: string,            // 即梦异步任务 id（提交后立即落库）
  remote_status?: querying|success|fail,
  prompt, references[], video_options?, session_id?,
  turns: GenTurn[],              // 复用现有轮次
  error?, created_at, ...
}
```

### 5.3 设计要点

- **前端**：`generating: boolean` → `genJobs: Record<id, GenJob>`；GenerationPanel 渲染多 job 列表（每个独立状态/取消/结果）；创作板「发送」创建新 job 不阻塞。
- **后端**：全局单 cancel slot → `Mutex<HashMap<job_id, oneshot::Sender>>`；`codex_create_image` 改为「submit 后尽快返回 job_id」（即梦：提交拿 submit_id 即返回，后台 query；codex：仍 spawn 流式但带 job_id）。
- **事件**：`codex://chunk` payload 增 `job_id`；前端按 job_id 分发（保留事件名，最小侵入）。
- **即梦侧串行队列**（应对并发=1）：一个 worker 按 FIFO 提交即梦视频 job；遇 `ExceedConcurrencyLimit` 自动退避重试（不是错误）。codex/即梦图片可并行（图片并发待测，先保守串行即梦、codex 自由）。
- **持久化**：复用 `task_queue` 表（`payload` 塞 `{media, provider, submit_id, prompt, video_options, ...}`）；启动恢复：扫 `running/queued` 的即梦 job → `query_result` 续查 → 成功入库 / 仍 querying 则保持后台轮询。
- **孤儿任务清理**：启动时调 `list_task` 比对本地 job 表，发现本地无记录但远端 querying 的（如 spike 实证那条）→ 可选「取回」入口。
- **图片受益**：Phase A 完成后图片也能并行迭代多组，GenerationPanel 变多任务时间线。

> 范围控制：v1 只做「多 job 状态 + per-job cancel + 即梦串行队列 + 持久化恢复」；**不做**完整 retry/backoff 调度策略、跨 provider 智能路由（技术债，见 §10）。

---

## 6. 视频生成设计（Phase B，建立在 Phase A 之上）

### 6.1 协议泛化：image → media/artifact

- Rust `codex/types.rs`：`GenOutcome.source_images` → `source_artifacts: Vec<Artifact{path, media_type}>`；`CodexResult.images` 同理。
- TS `lib/types.ts`：`GenTurn.images` → `artifacts`（或保留 `images` 名内部按扩展名判渲染，最小侵入）。
- 命令/事件名保留（`codex_create_image`/`codex://chunk`），增 `media` + `video_options` 字段（§4 决策 8）。
- `GenProvider`（`codex/mod.rs`）增 `generate_video(req, tx) -> GenOutcome`，默认 `Unsupported`；`CodexCliProvider` 不实现（codex 不做视频），`DreaminaCliProvider` 实现 5 命令映射。

### 6.2 创作板视频模式（`CreationBoard.tsx` + `creation/`）

- 工具栏增 **图片/视频** 切换（`genMedia`，localStorage `bowerbird.boardMedia`）。
- 视频模式工具栏：**时长**（默认 5s；2.5 可至 30s、其它至 15s）+ **模型**（按命令过滤，默认 `seedance2.5`：text2video/image2video/frames2video/multimodal2video → 2.5(默认,VIP)/2.0fast/2.0/2.0_vip/2.0fast_vip/2.0mini（image/frames 另含 1.0fast/1.5pro）；multiframe → 固定不显示；非 VIP 默认 `seedance2.0fast`）+ **比例**（仅 text2video/multimodal2video 可用，6 档；图生视频类置灰并提示「比例由输入图决定」）。
- 视频模式 provider 锁定 jimeng（`ProviderSelect` 置灰 codex）。
- **输入图数量 → 命令自动映射**（无需用户选命令）：
  - 0 图 → `text2video`
  - 1 图 → `image2video`（首帧）
  - 2 图带首/尾标记 → `frames2video`；2 图无标记 → `multiframe2video`（2图简写）
  - 3+ 图 → `multiframe2video`
  - 「旗舰多模态」开关 → `multimodal2video`（首版只图参考）
- **首/尾帧**：image chip 增 `role: first|last|ref`（`schema.ts`），序列化（`serialize.ts`）派生 `--first/--last`。
- **multiframe2video 分段**（漂亮映射）：创作板「图chipA 文字 图chipB 文字 图chipC」中，**相邻图之间的文字天然就是 transition-prompt**（N-1 段）；duration 分段首版用默认（3s/段），不暴露分段时长。

### 6.3 即梦视频 provider（`codex/jimeng.rs`）

复用现有：二进制发现、`spawn`（`CREATE_NO_WINDOW`）、pretty JSON 解析、`submit_id`/`gen_status` 判据、临时下载目录。新增：
- 命令映射（§6.2）→ 正确子命令 + 参数（`--duration --video_resolution --model_version --ratio`(仅适用时) --poll`，不传 `--audio`）。
- 提交后立即返回 `submit_id`（不阻塞），轮询交给 Phase A 的 job worker（应对并发=1 + 排队）。
- 下载：`query_result --submit_id --download_dir`，扫**视频扩展**（mp4/mov/webm，新增 `walk_artifacts` 区分图/视频）。
- 超时放宽（图像 180s → 视频按 spike，poll 阶段化；submit 不阻塞所以无单次超时问题）。
- 临时目录清理改 RAII/finally（现有成功路径 best-effort 有泄漏风险）。
- 错误映射：`ExceedConcurrencyLimit`（可重试，交 worker 排队）、`AigcComplianceConfirmationRequired`（提示 web 授权）、积分不足、未登录。

### 6.4 入库与媒体管理

- `ingest_generated`（`core/ingest.rs`）增视频分支：probe（ffprobe 宽高/时长，复用 `media/probe.rs`）→ 复制入库 → ffmpeg 抽 poster（复用 `media/thumb.rs generate_video`）→ 颜色/dHash 从 poster 算（修现有「打开视频原文件」bug）。
- **缩略图健壮性**：抽帧失败写 `thumb_path=None`（修现有「写不存在的路径导致破图」）；短视频退回首帧（修「第1秒抽帧对 <1s 失效」）。
- 视频资产 `source="jimeng"` + `generation_session_id`，与图片对称。
- 自动命名：视频跳过 `spawn_auto_name_only`（现有把视频原文件传 codex `--image` 会失败）；后续统一改传 poster（普通视频反推也受益，§10）。

### 6.5 媒体感知渲染

| 位置 | 改动 |
|---|---|
| `GenerationPanel.tsx` | 多 job 列表；产物按扩展名 `<img>`/`<video controls preload=metadata>`；文案「图」→「结果」 |
| `MasonryGrid.tsx` | 视频缩略图加播放角标 + duration badge（现 `duration` 字段从未展示） |
| `AssetDetail.tsx` | 已有 `<video>`；补 duration/格式；来源卡 reference 为视频也用 `<video>` |
| Lightbox | 视频用播放器 |

---

## 7. 数据模型与协议泛化

- **MVP 不迁移 schema**：现有 `assets`(ext/width/height/duration/store_path/thumb_path) + `analyses(kind=generation_meta)` + `generation_session_id` 够用。
- `generation_meta` payload 增：`media_type`、`duration`、`model_version`、`video_resolution`、`submit_id`、`video_kind`、`job_id`。
- **复用 `task_queue` 表**承载 GenJob（`kind="generation"`，`payload` 塞完整 job 状态 + submit_id）；新增 `mark_cancelled` + 按 job_id 查询方法。
- **不新建** `generations` 表（与 PROJECT.md 现有决策一致）。
- 后续（非 v1）：`assets.media_type` + `assets.media_meta`(ffprobe JSON) 迁移 `0009`，按 ext 回填，做可靠媒体查询/codec/fps 展示。

---

## 8. 改动面（代表性路径）

**Phase A（并行生成）：**
- `core/task_queue.rs` — 增 `mark_cancelled`、按 id 查询、worker 消费循环（即梦串行队列）、启动恢复
- `commands/codex.rs` — `GENERATE_CANCEL` 单槽 → `HashMap<job_id, Sender>`；`codex_create_image` 提交后尽快返回 job_id；`codex://chunk` 带 job_id
- `store.ts` — `generating` → `genJobs`；多 job 状态机；按 job_id 消费 chunk
- `lib/types.ts` / `lib/api.ts` — GenJob 类型 + job_id
- `GenerationPanel.tsx` — 多 job 列表 UI

**Phase B（视频）：**
- `codex/{types,mod,jimeng}.rs` — media/artifact 泛化 + `generate_video` + 5 命令映射 + `walk_artifacts`
- `commands/codex.rs` — 视频分支 + video_options + 跳过视频自动命名
- `core/ingest.rs` — `ingest_generated` 视频分支
- `media/thumb.rs` / `probe.rs` — 缩略图健壮性
- `creation/{CreationBoard,RatioSelect,ProviderSelect,schema,serialize}.tsx` — 模式切换 + 动态 options + 首/尾帧 chip role + multiframe transition 映射
- `components/{GenerationPanel,MasonryGrid,AssetDetail}.tsx` — 媒体感知渲染 + duration badge

---

## 9. Roadmap

| Phase | 目标 | 验证 |
|---|---|---|
| **A0** | task_queue worker + per-job cancel + 事件带 job_id | 图片可并行发 2 个、独立取消 |
| **A1** | 即梦串行队列（并发=1）+ ExceedConcurrencyLimit 自动排队 + 持久化恢复 + 孤儿取回 | 即梦图片可排队跑多个；杀 app 重启能续查 |
| **B0** | 协议泛化 media/artifact + `generate_video` 骨架（text2video 跑通落库） | 真机 text2video → mp4 入库 → 详情页可播 |
| **B1** | 创作板视频模式 + 时长/模型 options + GenerationPanel 媒体感知 | 点图+打字生视频，面板可播 |
| **B2** | image2video / frames2video（首尾帧 chip role） | 单图/首尾帧可用 |
| **B3** | multiframe2video（transition 映射）+ multimodal2video（图参考，无音频） | 多图故事 / 旗舰可用；5 命令齐 |
| **B4** | 视频素材管理（badge/duration/缩略图健壮性）+ 测试 | 视频在瀑布流/详情正确展示 |

> Phase A 是 B 的硬前置（B 的 job/队列/恢复全靠 A）。Phase A 完成即对图片产生独立价值，可单独发布。

---

## 10. 风险与已知技术债

- **远端任务不可真取消**：本地 kill ≠ 即梦远端取消，可能继续扣分；靠持久 submit_id 取回 + UI 明示缓解。
- **即梦视频并发=1**（spike 实证）：Bowerbird 串行队列；用户发起多个视频会排队，UI 须显示队列位置（`queue_info.queue_idx`）。
- **视频提交即扣分 + 排队长**：用户取消/超时后积分可能已扣；UI 须诚实告知。
- **CLI beta 契约漂移**：dreamina `b5ccc5d-dirty` 仍是 beta，`-h` 为最终事实源；锁版本 + spike 记录。
- **ffmpeg/ffprobe 依赖**：未随包分发、无安装引导/健康检查（既有，视频放大）；v1 沿用「要求用户装」，后续 sidecar/引导。
- **WebView codec 兼容**：mp4/H.264 一般可播，mkv/avi 不行；即梦产物大概率 mp4（待 B0 确认容器）。
- **协议命名债**：v1 保留 `codex_create_image`/`codex://chunk`/`images` 等 wire 名 + 内部泛化；后续可统一 `create_generation`/`generation://event`/`artifacts`。
- **provider 续轮可错误切换**（既有 bug）：会话中途切 codex↔jimeng 混乱 session；建议 Phase A 顺带修（多 job 模型天然隔离，但续轮锁定逻辑仍需补）。
- **GenerationPanel 只查 codexHealth**（既有 bug）：即梦续轮/重试被错误置灰；建议顺带修。
- **完整 worker 调度**：v1 只做 FIFO + 并发限制 + 简单重试；优先级/跨 provider 路由/退避策略是后续技术债。
- **视频反推/自动命名**：v1 视频跳过自动命名；后续统一改传 poster frame（普通视频反推也受益）。
- **即梦图片并发未测**（§2.4）：保守按串行处理，spike 后放宽。

---

## 11. 测试策略

**Rust（源文件内联）：**
- task_queue：多 job 入队/消费顺序/per-job cancel/启动恢复/ExceedConcurrencyLimit 重试。
- jimeng 视频命令映射：输入图数量 + options → 正确子命令 + 参数（5 路径）。
- `ingest_generated(video)`：poster 生成、duration 正确、颜色/dHash 来自 poster、source=jimeng。
- `walk_artifacts`：区分图/视频扩展。
- 视频生成组 collapse/list（复用 generation_session_id 测试）。

**前端（当前零测试，建议本规划引入 Vitest）：**
- 多 job store 状态机 + 按 job_id 消费 chunk。
- 创作板视频模式 options 动态约束（按图数量/ratio 可用性）。
- serialize 首/尾帧 + multiframe transition → video_options。
- GenerationPanel `<img>`/`<video>` 渲染分支。

**真机端到端：** 5 视频命令各跑一次（Phase B0/B2/B3 验证）。

---

## 12. 参考

- dreamina CLI 官方命令速查：https://wiki.hiwepy.com/docs/sglang/sglang-1haebh673uic5
- 官方 SKILL.md（raw）：https://raw.githubusercontent.com/simonjiang99/dreamina-cli/main/skill/SKILL.md
- 第三方 wrapper（参数细节）：https://github.com/yuyou-dev/dreamina-cli-skill
- 即梦官网：https://jimeng.jianying.com
- 本机 spike 原始记录：text2video submit_id `6cfdfc1f-...`（10 积分，排队中）、image2video `b94b34fc-...`（ExceedConcurrencyLimit fail）
