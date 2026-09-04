# Bowerbird「画板即创作会话」实施记录（已被替代）

> ⚠️ **本计划的产品契约已由 [`PROJECT-CANVAS-PLAN.md`](PROJECT-CANVAS-PLAN.md) v1.0 替代。** 当前权威模型是“一项目一块无限画板，项目内多条创作线程”。本文只保留旧 CS0–CS7 的实现、测试和迁移演练证据，不得继续执行 CS7-T6/T7，不得据此迁移正式库或关闭 legacy 回退。
>
> 版本：v0.8（历史冻结于 2026-09-03，真实用户库副本仅按旧契约演练通过）
> 状态：**历史实现记录；旧契约未发布、正式用户库未迁移**
> 适用范围：Bowerbird 桌面端的创作入口、无边画板、普通生成会话、Cloud/本机生成、正式 Agent Run、本地历史恢复与项目归属
> 执行方式：不估工期；按阶段、依赖和验收推进。每阶段必须先通过自动化回归，再进入下一阶段；涉及用户交互的阶段另做桌面真机验收。

---

## 0. 一页结论

Bowerbird 不再把“创作板”“空白画板”“生成会话详情”作为三套彼此独立的产品对象。目标模型冻结为：

> **一块画板 = 一个 Bowerbird 创作会话。**

“画板”是创作会话的空间主视图；“时间线”和“节点详情”是同一份创作数据的辅助投影。用户新建一次创作，即进入一块新画板；也可以新建不带 prompt 和参考图的空白画板，从左侧素材栏拖入参考后再开始生成。

目标层级：

```text
中央素材库
└─ canonical assets（文件夹/类别不因画板操作而改变）

项目（可选的上层创作范围）
└─ 创作会话 A = 画板 A
   ├─ 参考素材节点
   ├─ prompt / 用户指令节点
   ├─ 普通生成 job / provider session
   ├─ Agent Run / 计划 / 审批 /事件
   ├─ 生成结果与版本分支
   └─ 空间布局、素材组与视口
└─ 创作会话 B = 画板 B
```

本专项新增的 `creative_session_id` 是 **Bowerbird 本地权威 ID**。它不得等同或依赖 Codex thread、即梦 submit id、Cloud generation job、Agent `run_id`、云端 `conversation_id` 或现有普通生成 provider `session_id`。这些执行层 ID 只作为创作会话的子记录和恢复句柄。

首版完成后：

- 工具栏“新建创作”创建画板并聚焦创作输入；若用户已有明确选择的素材，可作为初始参考铺入画板。
- “新建空白画板”忽略当前选择，以空白空间开始，用户从左侧素材栏拖入参考。
- 普通生成、继续修改、重试、重新编辑、跨 provider 交接和 Agent Run 均留在当前画板。
- 生成结果自动进入中央素材库、当前项目和当前画板；三者使用同一 `asset_id` 引用，不复制第二份资产。
- 原生成会话详情降为同一创作的“时间线”视图；不再维护第二套会话状态。
- 当前只存 `sessionStorage` 的实验画布退出正式架构；画板改为 SQLite 持久化，可重启恢复。

---

## 1. 决策、目标与非目标

### 1.1 已冻结决策

1. 用户侧统一对象叫“**创作**”；进入创作后默认看到“**画板**”。代码和数据库使用 `creative_session`，避免与 provider conversation 混淆。
2. 一个创作只有一块画板；一个项目可以有多个创作。首版不做“一次创作多画板/多页面”。
3. 画板是会话主视图，不是独立 moodboard；时间线、详情和画板读取同一数据源。
4. 一个创作允许普通生成、Agent Run 和不同 provider 的执行记录共存；是否允许某 provider/Agent 组合仍由现有 `FeaturePolicy` 和三层门控决定。
5. 空白画板在用户侧立即可用，但在首次“有意义修改”前可以只是前端 provisional draft；完全未修改即退出不留下“未命名创作”垃圾记录。
6. 画板空间位置只影响展示，**绝不定义执行顺序**。继续、重试、分支、输入和输出关系必须有显式父子/边关系。
7. 画板节点引用中央库 `asset_id`；拖入、分组和从画板移除不改变素材 `folder_id`、类别、收藏夹或物理文件。
8. 当前画板里的透明“文件夹”统一改称“**素材组**”；它只是画板关系，不是资料库文件夹。
9. 创作默认归属创建时的当前项目；全局创建时 `project_id=NULL`。项目删除时创作安全降为全局创作，历史和资产不随项目关系误删。
10. 画板状态只在本机长期保存。本专项不新增画板云同步、多人协作或远端素材库。

### 1.2 目标

- 收敛 `CreationBoard`、`CanvasWorkspace`、`GenerationPanel`、`CloudAgentPanel` 和侧栏生成会话入口的用户心智。
- 建立可持久、可迁移、可重放的创作会话数据模型。
- 支持“带初始意图的新创作”和“空白画板”两条入口进入同一对象。
- 在画板上明确展示参考、prompt、结果、继续修改和版本分支的关系。
- 保留当前普通生成的精确重放、跨引擎交接、多 job、取消和恢复语义。
- 保留 Agent 的计划审批、事件、产物、反馈、计量、TTL 和恢复边界。
- 让历史普通生成会话与历史 Agent Run 能迁移/投影成画板，不丢图片、prompt、provider session 或项目归属。
- 让资产详情页“回看生成对话”改为定位到所属创作并选中对应结果，而不是打开另一套面板。

### 1.3 明确不做

- 不做 LibTV/ComfyUI 式任意节点工作流、自由连线执行器或用户自定义 workflow DSL。
- 不允许用户通过拖线改变已批准 Agent 计划、预算、工具参数或 provider 副作用。
- 不把画板同步到 Bowerbird Cloud，不新增多人实时协作、评论或权限系统。
- 不把文件夹、类别、收藏夹、项目成员关系重新实现一遍。
- 不做无限层级素材组；首版素材只允许加入一个画板组，组内不再嵌套组。
- 不用画板坐标猜测参考职责、父轮次或生成顺序。
- 不借本专项改变收费档位、积分规则、Agent release 门控或 Codex 与正式 Agent 的互斥决策。
- 不在首版提供视频时间线、音轨、剪辑轨或帧级编辑。

### 1.4 完成定义

以下条件全部成立才可把专项标记完成：

- 用户可从全局或项目上下文新建创作/空白画板，并在重启后恢复布局、分组、视口和草稿。
- 同一创作可完成“参考素材 → 首轮普通生成 → 继续修改 → 重试分支 → 跨 provider 图片交接”，关系正确且历史精确可回放。
- 同一创作可发起一个受当前 FeaturePolicy 允许的 Agent Run，完成计划、审批、执行、反馈/接受并把用户可见产物放回原画板。
- 时间线与画板对同一轮次、参考图、输出、provider、视觉设定和状态无分歧。
- 旧普通生成历史、旧 Cloud Agent 本地历史在迁移后可打开；重复迁移不会产生重复创作、节点或资产。
- 从画板移除节点、删除创作、删除项目和删除中央库资产四种操作通过独立破坏性语义测试。
- 旧 `sessionStorage` 画布不再是正式事实源；旧独立会话面板不再写入自己的平行 UI 状态。
- 桌面 Rust 测试、前端 typecheck/build、画板逻辑测试、迁移测试和真机验收全部通过。

---

## 2. 当前状态与主要问题

### 2.1 现有对象

| 现有对象 | 当前职责 | 当前事实源 |
|---|---|---|
| `CreationBoard` | ProseMirror 组稿、参考图、比例/provider/Agent 选择 | 前端草稿与 store |
| `CanvasWorkspace` | 左侧素材瀑布流、自由布局、吸附、透明分组 | 单个 `sessionStorage` key |
| `GenerationPanel` / `GenJob` | 普通生成的轮次、流式状态、继续/重试/版本分支 | `task_queue` + `generation_meta` + 前端 store |
| `generation_conversations` | provider session 到普通生成版本组的映射 | SQLite |
| `CloudAgentPanel` / `cloud_agent_runs` | Agent Run 本地恢复、审批、事件和结果入库 | 云端 Run + 本地最小快照 |
| `projects` / `project_assets` | 中央素材库上的项目范围 | SQLite |

### 2.2 不能直接复用当前 `conversation_id` 的原因

- 普通生成中，`conversationId` 的职责是把“重新编辑/重试”产生的新 job 归入同一版本组；底层仍可能存在多个 provider session。
- Agent 的 `run_id` 和云端 `conversation_id` 是受控执行与 TTL 恢复句柄；当前每个新 Run 都可以独立创建。
- Codex、即梦和 Cloud 的恢复能力与 session 语义不同；跨 provider 续轮靠图片交接，而不是共享同一个供应商会话。
- 空白画板在第一次调用 provider 前就必须存在，但此时没有任何 provider session 或 Agent Run。

因此必须新增上层 `creative_session_id`，并通过显式链接表关联低层执行记录。

### 2.3 当前 UX 冲突

- 用户在创作板组稿，发送后跳到会话详情，再切到独立画布时看不到原会话关系。
- 生成详情擅长按时间阅读，但版本分支只能用左右切换表达；画布擅长表达分支，却没有 prompt、执行和恢复事实。
- 当前画板是全局单例；从全局或不同项目进入都可能读到同一批节点。
- 画板“文件夹”和资料库文件夹同名，但前者不改变 `assets.folder_id`。
- 普通生成和 Agent 虽共享视觉外壳，仍由两套前端 map/order/active 状态管理。

---

## 3. 产品语义与用户路径

### 3.1 入口

工具栏“导入”右侧的现有画布入口改造为主动作“**新建创作**”，并提供次级入口“**新建空白画板**”。两者创建相同实体，只是初始状态不同：

| 入口 | 初始素材 | 初始编辑器 | 适用场景 |
|---|---|---|---|
| 新建创作 | 当前明确选中的素材；无选择则为空 | 展开并聚焦 | 已经知道要做什么 |
| 新建空白画板 | 始终为空，不隐式带入当前多选 | 收起或保持空态 | 先找参考、比较和排布 |

禁止把“当前瀑布流所有素材”隐式带入新创作。只有用户明确选中的素材可以成为初始参考。

### 3.2 空白画板生命周期

1. 点击入口后立即打开 provisional 画板并生成本地 UUID。
2. 以下任一动作视为“有意义修改”：拖入素材、输入非空文字、创建素材组、修改标题、改变已保存视口、发起生成。
3. 首次有意义修改时，在一个本地事务内创建 `creative_sessions` 和首批节点/视图状态。
4. 完全未修改即返回，直接丢弃 provisional 状态，不写数据库。
5. 已持久化但尚无生成的画板显示为“草稿”，可从创作列表继续打开。
6. 默认标题为“未命名创作”；第一条非空用户意图可在用户未手改标题时本地截取首行生成标题，不调用 AI。

### 3.3 带意图的新创作

1. 在当前全局/项目上下文创建 provisional 画板。
2. 明确选中的素材以 `reference` 角色自动布局在左侧；素材顺序保持用户选择顺序。
3. 复用现有 ProseMirror 创作编辑器作为画板底部 composer，不创建第二个 prompt 编辑器。
4. 首次发送先落 prompt 节点和引用关系，再创建普通 generation job 或 Agent Run。
5. 启动失败时 prompt 与参考仍保留在画板，并显示可重试的失败状态；不得因 provider 失败丢草稿。

### 3.4 画板布局

首版默认布局遵循“输入在左、动作居中、结果向右、分支向下”：

```text
[参考组] -> [首轮指令] -> [结果 A] -> [修改指令] -> [结果 B]
                           \-> [重试指令] -> [结果 A2]
```

- 用户可自由移动节点；自动生成的新节点只在首次插入时计算默认位置。
- 同一父结果的多个分支按创建顺序错位排布，用户移动后不再被自动布局覆盖。
- 吸附仅改变坐标，不创建或删除边。
- 素材组只用于视觉整理和可选参考职责，不代表生成关系。
- 画板允许同一 `asset_id` 出现多个节点，满足同一素材在不同分支/参考组中承担不同职责；当前实验画布“全板唯一素材”限制不进入正式模型。

### 3.5 继续、重试与分支

| 用户动作 | 所属创作 | 关系语义 |
|---|---|---|
| 继续修改最新结果 | 当前创作 | 新 prompt/output 接在当前 active branch 尾部 |
| 编辑历史轮次后发送 | 当前创作 | 以当时基图与精确参考重放，创建新分支 |
| 重试某轮 | 当前创作 | 复用该轮实际 prompt/refs/provider 参数，创建同级结果分支 |
| 切换 provider 继续 | 当前创作 | 显式把选中结果作为图片输入，开新的 provider session 子记录 |
| 无选中结果直接发新意图 | 当前创作 | 创建新的根分支；UI 必须明确提示“在当前创作中新开分支” |
| 点击“新建创作” | 新创作 | 不继承当前 active branch 或 provider session |

### 3.6 Agent Run

- 从画板发起 Agent 时，当前 prompt 节点、显式参考节点顺序和已选视觉设定形成 Run 输入。
- Agent 的计划、审批、步骤事件和过程产物可显示为一个可展开的“Agent 执行组”；用户可见图片同时拥有普通资产节点。
- 用户接受、反馈、拒绝或取消仍走现有控制面和状态机，画板只投影状态，不越权改变批准计划。
- 同一创作可先普通生成再以某张结果启动 Agent，也可先 Agent 后直接生成；两者通过明确的父结果边连接。
- 当前 Codex 与正式 Agent 互斥、即梦 Agent 真机 E2E 暂缓、Agent release 门控等约定保持不变。

### 3.7 画板、时间线与节点详情

- 顶部提供“画板 / 时间线”视图切换；两者共享同一 `creative_session_id`。
- 时间线按不可变 `created_at/sequence` 展示用户指令、provider/Agent 状态、图片、错误、审批和计量摘要。
- 选中素材、prompt、结果或 Agent 组时，右侧可折叠详情显示其精确引用、实际下发 prompt、provider、比例、视觉设定、父节点和状态。
- 坐标变化不影响时间线顺序；时间线排序不依赖 DOM 顺序或 `z_index`。
- 资产详情页“回看生成对话”改为打开所属创作，选中该资产节点；若同一资产出现在多个创作，先列出关联创作供用户选择。

### 3.8 项目与中央素材库

- 在项目内新建时记录 `project_id`；后续切换全局/项目视图不改变创作归属。
- 向项目创作拖入尚未属于项目的中央库素材时，事务性新增 `project_assets` 后再落画板节点；失败时两者都不提交。
- 在全局创作中拖入素材只增加画板引用。
- 生成结果继续复用现有中央库 ingest；若创作有项目，结果同时加入该项目。
- 画板素材组不改变文件夹、类别或收藏夹；可在后续专项中提供显式“保存为收藏夹”，本专项不自动转换。
- 删除项目时，所属创作的 `project_id` 置空并转为全局创作；删除提示必须显示将转移的创作数量。

---

## 4. 数据模型

> 表名为计划冻结的逻辑名；正式落地若本地迁移编号已被其他分支占用，应顺延编号，不重写已发布 migration。

### 4.1 `creative_sessions`

```sql
CREATE TABLE creative_sessions (
  id                TEXT PRIMARY KEY,
  project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  title_source      TEXT NOT NULL, -- default | first_prompt | manual
  draft_json        TEXT NOT NULL, -- 未发送 composer 文档、模式、base/refs、比例与 provider 的版本化草稿
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_opened_at    INTEGER NOT NULL
);

CREATE INDEX idx_creative_sessions_project_updated
  ON creative_sessions(project_id, updated_at DESC);
```

不增加云端同步字段。是否正在生成从子 job/Run 派生，不在 session 行缓存第二份状态。`draft_json` 只保存尚未执行的本地编辑状态；发送时必须重新校验 asset/node 归属、FeaturePolicy、provider 可用性和比例闭集，不能把草稿当执行授权。

### 4.2 `creative_nodes`

```sql
CREATE TABLE creative_nodes (
  id                  TEXT PRIMARY KEY,
  creative_session_id TEXT NOT NULL REFERENCES creative_sessions(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL, -- asset | prompt | agent_group | note
  asset_id            TEXT REFERENCES assets(id) ON DELETE SET NULL,
  role                TEXT,          -- reference | output | intermediate | final 等展示角色
  payload_json        TEXT NOT NULL,
  x                   REAL NOT NULL,
  y                   REAL NOT NULL,
  width               REAL NOT NULL,
  height              REAL NOT NULL,
  z_index             INTEGER NOT NULL,
  position_locked     INTEGER NOT NULL DEFAULT 0,
  hidden_at           INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX idx_creative_nodes_session
  ON creative_nodes(creative_session_id, z_index, created_at);
CREATE INDEX idx_creative_nodes_asset
  ON creative_nodes(asset_id);
```

约束：

- `asset_id` 只对资产节点存在；删除中央库资产后节点保留 tombstone，由 `payload_json` 中的最小安全快照展示“素材已删除”，不保留第二份原图。
- `payload_json` 允许保存 ProseMirror JSON、用户可见标题、资产名称/尺寸快照和外部执行 key；不得成为项目归属、计费、provider 状态或执行顺序的权威。
- 同一创作允许多个节点引用同一 `asset_id`。
- 对已进入执行历史的 prompt/output/Agent 节点，“从画板移除”只设置 `hidden_at`，时间线和关系仍保留；尚未执行的自由参考/note 节点才允许真正删除。
- `kind/role` 必须在 Rust 层闭集校验；未知值安全拒绝，不由 UI 任意扩展。

### 4.3 `creative_groups` 与成员关系

```sql
CREATE TABLE creative_groups (
  id                  TEXT PRIMARY KEY,
  creative_session_id TEXT NOT NULL REFERENCES creative_sessions(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  role                TEXT, -- base | style | composition | candidate | rejected | null
  x                   REAL NOT NULL,
  y                   REAL NOT NULL,
  width               REAL NOT NULL,
  height              REAL NOT NULL,
  z_index             INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE creative_group_items (
  group_id TEXT NOT NULL REFERENCES creative_groups(id) ON DELETE CASCADE,
  node_id  TEXT NOT NULL REFERENCES creative_nodes(id) ON DELETE CASCADE,
  ordinal  INTEGER NOT NULL,
  PRIMARY KEY (group_id, node_id),
  UNIQUE (node_id),
  UNIQUE (group_id, ordinal)
);
```

同一节点首版最多属于一个组；`UNIQUE (node_id)` 固定该约束。组内顺序由 `(group_id, ordinal)` 唯一约束保证，不允许同组并列序号。数据库 trigger 与 Rust repository 写入必须双重验证 group 与 node 属于同一创作，禁止跨画板分组或通过节点行再双存一份 `group_id`。

### 4.4 `creative_edges`

```sql
CREATE TABLE creative_edges (
  id                  TEXT PRIMARY KEY,
  creative_session_id TEXT NOT NULL REFERENCES creative_sessions(id) ON DELETE CASCADE,
  from_node_id        TEXT NOT NULL REFERENCES creative_nodes(id) ON DELETE CASCADE,
  to_node_id          TEXT NOT NULL REFERENCES creative_nodes(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL, -- input | produced | continued | retry | branch | agent_step
  ordinal             INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_creative_edges_unique
  ON creative_edges(creative_session_id, from_node_id, to_node_id, kind);
```

数据库 trigger 与 Rust repository 写入必须双重验证两端节点均属于同一创作，禁止跨创作连边。执行顺序由 run/turn 数据与 edge kind 共同重建，不能由坐标推断。

### 4.5 画板视口

```sql
CREATE TABLE creative_views (
  creative_session_id TEXT PRIMARY KEY REFERENCES creative_sessions(id) ON DELETE CASCADE,
  pan_x               REAL NOT NULL DEFAULT 0,
  pan_y               REAL NOT NULL DEFAULT 0,
  zoom                REAL NOT NULL DEFAULT 1,
  source_panel_width  REAL,
  active_node_id      TEXT,
  view_mode           TEXT NOT NULL DEFAULT 'canvas', -- canvas | timeline
  updated_at          INTEGER NOT NULL
);
```

`active_node_id` 仅是恢复选中态的 UI hint，不是关系事实。zoom、panel width 必须复用现有闭集 clamp。

### 4.6 普通生成链接

```sql
CREATE TABLE creative_generation_links (
  creative_session_id       TEXT NOT NULL REFERENCES creative_sessions(id) ON DELETE CASCADE,
  generation_conversation_id TEXT NOT NULL,
  created_at                INTEGER NOT NULL,
  PRIMARY KEY (creative_session_id, generation_conversation_id),
  UNIQUE (generation_conversation_id)
);
```

- 现有 `generation_conversations` 继续负责 provider `session_id -> conversation_id` 的低层归组。
- `GenJob`/`task_queue.payload` 新增可选 `creative_session_id`，恢复时优先使用；旧 payload 缺失时由 link/backfill 查询。
- 一个旧普通生成 conversation 首版只归属一个创作，避免同一执行历史在多块画板被编辑产生双权威。

### 4.7 Agent Run 链接

```sql
CREATE TABLE creative_agent_links (
  creative_session_id TEXT NOT NULL REFERENCES creative_sessions(id) ON DELETE CASCADE,
  run_id              TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (creative_session_id, run_id),
  UNIQUE (run_id)
);
```

- `cloud_agent_runs.run_id/conversation_id` 保持现状；不把本地 `creative_session_id` 冒充云端 conversation。
- 新 Run 成功创建后幂等写 link；若远端 create 失败，创作/prompt 节点仍存在并显示失败，不伪造 run id。
- Agent 产物入库时同时以 `run_id + artifact_id/role` 作为确定性节点 key，重复恢复不新增节点。

### 4.8 标题、状态和派生值

- `draft`：没有任何 generation/Agent link；允许已有素材、分组和 prompt 草稿。
- `active`：存在未终态的本地 generation job 或 Agent Run。
- `completed`：至少有一个用户可见输出，且没有未终态执行。
- `failed`：最近执行失败且当前没有运行中执行；历史成功输出仍保留。

以上均由查询派生，不新增容易漂移的 `creative_sessions.status`。

---

## 5. 写入、恢复与删除不变量

### 5.1 本地持久化

- 拖动中的 pointer move 只更新前端内存；pointer up 后批量提交最终坐标，避免 SQLite 写放大。
- 拖入、分组、解组、删除节点、创建 prompt/run/output 使用语义命令，不允许前端整份 JSON 覆盖数据库。
- pan/zoom/source width 可 150–300ms debounce，窗口隐藏/切换创作/正常退出时 flush；崩溃最多丢最后一次纯视口变化，不丢节点与生成关系。
- 所有节点 mutation 更新 `creative_sessions.updated_at`；只改 `last_opened_at` 不改变用户排序中的“最近编辑”。

### 5.2 普通生成启动顺序

1. 确保持久化 creative session。
2. 事务性写 prompt 节点、输入边和 pending generation link/local job identity。
3. 启动现有 provider command。
4. 收到 `started/done/error` 后按稳定 job/turn key 更新节点状态。
5. 结果 ingest 成功后，幂等写 asset 节点与 produced edge。

provider 启动失败不得回滚用户 prompt；应把待执行节点标为可重试失败。

### 5.3 Agent 启动顺序

1. 确保持久化 creative session 和 prompt/reference 节点。
2. 调用现有 Cloud Agent create/upload/start 链路。
3. 拿到 `run_id` 后幂等写 `cloud_agent_runs` 与 `creative_agent_links`。
4. 事件和 artifact 以云端控制面为权威，映射到本地 Agent 组和资产节点。
5. 云端 TTL 到期不删除本地创作；本地已有资产和安全事件摘要仍可回看。

崩溃发生在 create 成功、link 未写之间时，启动恢复必须通过已有本地 `cloud_agent_runs` 与未关联 run 扫描补 link；不能再向云端创建第二个 Run。

### 5.4 删除语义

| 操作 | 结果 |
|---|---|
| 从画板移除节点 | 自由参考/note 节点可删除；已执行 prompt/output/Agent 节点只标记隐藏并保留边与时间线；中央资产和项目成员不删 |
| 删除素材组 | 默认解组并保留节点；另提供明确“从画板移除整组”，仍不删资产 |
| 删除创作 | 删除画板布局和本地 links；中央库资产保留；有运行中 job/Run 时先阻止并要求取消/等待 |
| 删除项目 | 项目创作转为全局，资产按既有项目删除语义处理 |
| 删除中央库资产 | 走现有危险确认；画板节点变 tombstone 或随用户选择从画板清理，不得静默改变历史 prompt/边 |

删除创作不等于删除 provider 远端历史，也不主动删除已完成 `task_queue` 或账单；本地低层记录按既有保留策略继续用于审计和恢复。

---

## 6. 历史兼容与迁移

### 6.1 普通生成历史

对每个尚未链接的 `generation_conversation_id` 创建一个创作：

1. 标题取首轮 `prompt_raw` 首个非空行，回退实际 prompt，再回退“历史创作”。
2. `project_id` 取该 conversation 下首个非空且一致的 job/project 快照；若历史数据冲突，置空并记录本地安全诊断，不猜测。
3. 从 `generation_history`/`generation_meta` 重建 prompt、reference 和 output 节点。
4. 按轮次与版本创建显式边，并使用确定性自动布局。
5. 写 `creative_generation_links`；重复迁移按 conversation unique 约束直接复用。
6. 不修改原 `generation_session_id`、`generation_conversations` 或 provider resume 句柄。

### 6.2 Agent 历史

- 每个未链接的 `cloud_agent_runs.run_id` 首版创建一个独立创作，不自动与普通生成历史合并。
- 标题取本地 `intent_prompt` 首行；项目取 `cloud_agent_runs.project_id`。
- reference asset、事件、用户可见过程/最终资产从本地 snapshot 和已入库资产重建；云端仍可访问时只补缺，不覆盖本地已确认内容。
- 旧 Run 的 `conversation_id` 保持原样并进入 Agent link，不作为 creative session 主键。

### 6.3 当前实验画布

当前 `CanvasWorkspace` 只存单个 `sessionStorage` key，且尚未形成正式发布数据契约。本专项不为它建立长期 migration 或兼容表：

- 开发版本升级时若同一窗口仍读到非空旧状态，可提供一次 best-effort“保存为未命名创作”；
- 转换成功后删除旧 key；转换失败保留旧 key并提示，不覆盖；
- 新安装与正式发布不得继续写旧 key；不得让它与 SQLite 形成双写事实源。

### 6.4 迁移失败策略

- 数据库 schema migration 只做 additive 建表/索引；历史节点 backfill 使用可重跑 Rust hook 或启动任务。
- backfill 以 link unique key 和确定性 node key 幂等；单个坏历史只标记失败，不回滚已经成功迁移的其他会话。
- backfill 使用独立版本化完成标记和逐来源处理记录；完成后不再因用户删除创作、link 随之删除而把旧会话自动创建回来。只有迁移未完成/显式修复时才继续扫描未处理来源。
- 迁移前后资产数量、生成 conversation 数和 Agent run 数必须可对账；不以“画板能打开”代替数量断言。
- 旧 UI 保留在受限 feature flag 后作为一个发布周期的只读回退；回退不得继续产生新的平行会话状态。

---

## 7. 组件与代码边界

### 7.1 新增/重构职责

建议组件边界：

```text
CreativeSessionShell
├─ CreativeSourcePanel       # 当前项目/全局素材源，复用 MasonryGrid
├─ CreativeCanvas
│  ├─ AssetNode
│  ├─ PromptNode
│  ├─ AgentRunNode/Group
│  ├─ CanvasGroup
│  └─ CanvasEdges
├─ CreativeComposer          # 从 CreationBoard 抽出的 ProseMirror 编辑能力
├─ CreativeTimeline          # 现有 GenerationPanel/CloudAgentPanel 的线性投影
└─ CreativeInspector         # 选中节点精确参数和审计详情
```

状态边界：

- SQLite/repository：session、节点、边、组、视口、links 的长期事实源。
- Zustand：当前打开 session、画板交互瞬态、正在拖拽/框选、未 flush 视口、运行中 job/Run 的 UI 镜像。
- `task_queue` / provider：普通生成执行状态权威。
- Cloud Agent 控制面：Agent Run、审批、计量、artifact 和终态权威。
- 中央库：资产文件与 metadata 权威。

### 7.2 可复用部分

- `canvasLogic.ts` 的坐标换算、zoom clamp、边缘吸附和 hover target 纯函数。
- `MasonryGrid variant="canvas-source"` 的左侧拖拽素材入口。
- `useCreationEditor`、schema、serialize/parse 和维度环形菜单。
- `GenTurn`、精确 refs、provider 切换、续轮与重试命令。
- `TurnView`、Lightbox、视觉设定回看和 provider 标签的展示能力。
- Cloud Agent 的计划卡、审批、事件列表、artifact 下载/入库与恢复命令。

### 7.3 应退出的旧边界

- `CanvasWorkspace` 自己读写 `sessionStorage`。
- `App.tsx` 中独立 `canvasMode` 布尔值作为顶层互斥模式。
- `GenerationPanel` 作为覆盖整个主区的独立会话事实源。
- `CloudAgentPanel` 与普通生成分别维护彼此不可见的“当前会话”概念。
- `CreationBoard` 发送后与结果空间分离的主交互；其编辑器能力保留，外壳并入 creative session。
- 画板内“文件夹”命名和“一块画板同一素材只能出现一次”的限制。

### 7.4 不应强行合并的底层对象

- 普通 `task_queue` 与 Cloud Agent Run 仍是两套执行状态机。
- 本机 provider session、云端 generation job 和 Agent `run_id` 仍使用各自恢复协议。
- Agent 计划/审批不能改造成普通 prompt 节点可编辑字段。
- `generation_conversations` 在旧历史和瀑布流生成图归组中继续存在，直到另有迁移专项证明可删除。

---

## 8. 分阶段任务卡

### CS0 — 契约冻结与回归基线

目标：编码前固定对象、命令和迁移语义，避免先改 UI 再补数据模型。

- [x] CS0-T1：冻结本计划 §1/§3/§5 的用户术语、入口、删除和空白 draft 语义。
- [x] CS0-T2：记录当前普通生成、Cloud Agent、项目删除、资产删除、会话恢复的自动化/真机基线。
- [x] CS0-T3：完成最小 schema spike，验证 `creative_group_items` 的单组归属、顺序、解组和删除语义。
- [x] CS0-T4：定义闭集 node/edge/role enum、版本化 payload schema 和安全反序列化失败策略。
- [x] CS0-T5：写 5 个固定迁移 fixture：单轮、多轮、重试分支、跨 provider、Agent Run。

验收：schema 能表达全部 fixture；不依赖坐标推断顺序；旧测试基线记录完整，尚未改变生产 UI。

**CS0 结果（2026-09-03）：**

- 用户术语、provisional draft、启动顺序、删除语义与本计划 §1/§3/§5 一致；未改生产 UI、provider、Agent 控制面或计费边界。
- 新增 `core/creative_session_contract.rs`：闭集 `node kind / node role / group role / edge kind`；payload `schema_version=1`；按 node kind 严格反序列化，未知字段、缺失/未来版本、kind/payload 错配和超过 64 KiB 均 fail closed。
- 新增非生产 `spikes/canvas_session_cs0.sql`：验证单组归属、唯一组内顺序、解组保留节点、跨 session 分组/连边拒绝、资产删除 tombstone、项目删除转全局；正式 migration 留到 CS1。
- 五个固定 fixture 位于 `src-tauri/fixtures/creative_session/`。每个 fixture 都能写入 spike schema；确定性回放顺序只使用显式 edge、`ordinal`、`created_at` 和稳定 id，fixture 不含坐标。
- 改造前基线：桌面 Rust **223 passed + 2 ignored**；画板纯函数 **9/9**；前端 `tsc --noEmit` 与 production build 通过。普通生成历史/队列、Cloud Agent 独立 Run 恢复与幂等入库、项目删除、资产 Keep/Delete/MoveOut 的既有专项测试均在这 223 项中通过；沿用 2026-08-25 用户确认的桌面会话历史、图片保留和 Agent 主路径真机基线。
- CS0 新增专项测试 **5/5**；改造后桌面 Rust 全量为 **228 passed + 2 ignored**，`cargo fmt --check`、画板纯函数 **9/9**、前端 `tsc --noEmit` 与 production build 均通过。未调用任何真实 provider，未产生 credits 或外部副作用。

### CS1 — SQLite 创作会话与 repository

目标：先建立本地权威，再接画板。

- [x] CS1-T1：新增 local migration（当前候选编号 `0021`，若占用则顺延）和 migrations 索引说明。
- [x] CS1-T2：实现 session create/list/get/rename/touch/delete 与按 project 查询。
- [x] CS1-T3：实现 node/group/edge 的语义 CRUD 和同 session 归属校验。
- [x] CS1-T4：实现 creative view 的 clamp、debounce-friendly upsert 和 flush API。
- [x] CS1-T5：实现 generation/Agent link 的幂等写入与反查。
- [x] CS1-T6：实现项目素材原子加入 + 画板节点写入；禁止只成功一半。
- [x] CS1-T7：覆盖 FK、跨 session 连边、重复 link、资产删除 tombstone、项目删除转全局和创作删除语义。

验收：fresh DB/升级 DB 均通过；所有非法跨 session/group 写入被拒；重复命令不产生重复节点或 link。

**CS1 结果（2026-09-03）：**

- 正式新增 additive migration `0021_creative_sessions.sql`：落地 session、node、group/item、edge、view、generation link、Agent link 八表及索引/trigger；项目删除 `SET NULL`、资产删除 node tombstone、创作删除局部级联均由 FK 固定，既有中央资产与执行历史不被反向删除。
- 新增 `core/creative_session.rs` repository：session、node、group、edge 语义 CRUD；稳定 node id 和语义相同 edge 重放幂等；跨创作 group/edge 在 repository 与 SQLite trigger 双层拒绝，edge endpoint 闭集与 DAG 环路 fail closed。
- creative view 使用单行 UPSERT/flush，zoom 复用 `0.35–2.4` clamp；写入带 workspace width 时，source panel width 复用现行 `42%–55%` 闭集。generation conversation / Agent Run link 全局唯一、同归属重放无副作用并支持反查。
- 项目素材成员关系与画板 node 在同一 SQLite 事务写入，节点 payload 校验或写入失败会回滚成员关系；未执行自由 reference/note 可真删，已执行 prompt/output/Agent 节点默认只隐藏。
- CS1 新增 repository/migration 测试 **7/7**，连同 CS0 契约专项为 **12/12**；桌面 Rust 全量 **235 passed + 2 ignored**，`cargo fmt --check`、画板纯函数 **9/9**、前端 typecheck 与 production build 均通过。未改生产 UI、未调用 provider、未产生 credits 或外部副作用。

### CS2 — 持久化画板与创作列表

目标：把实验画布从全局 session 变成可打开的 creative session。

- [x] CS2-T1：`CanvasWorkspace` 改为接收 `creativeSessionId`，移除正式路径的 `sessionStorage` 读写。
- [x] CS2-T2：实现 provisional draft、首次修改落库、未触碰退出丢弃。
- [x] CS2-T3：实现多创作列表、打开/切换/重命名/删除和按项目过滤。
- [x] CS2-T4：持久化节点坐标、素材组、pan/zoom/source width，并在重启后恢复。
- [x] CS2-T5：允许同一素材在同一画板出现多次；拖入 payload 使用稳定 node id，而不是只按 asset id 去重。
- [x] CS2-T6：把画板“文件夹”改名素材组；保持 1 秒 hover 建组、向已有组直接 drop、浅蓝发光和 tooltip。
- [x] CS2-T7：实现 300 节点 fixture benchmark；先测再决定是否增加空间裁剪，禁止无基线引入复杂虚拟化。

验收：创建两块画板各自保存不同布局，跨项目/重启不串板；连续拖动只在 pointer up 提交最终坐标；旧交互动效保留。

**CS2 结果（2026-09-03）：**

- `creative_session` repository 已包装为 Tauri commands 和前端类型/API；provisional 首次节点、项目成员与初始视口由单事务 materialize，素材组与首批成员也改为单事务提交，校验失败不残留空 session/空组。
- `CanvasWorkspace` 正式路径不再读写全局 `sessionStorage`，按 `creativeSessionId`/项目范围载入 SQLite snapshot；提供多创作切换、新建、重命名和删除。未改标题、节点或视口的 provisional 草稿退出不落库，写失败时当前画面与错误提示保留。
- 节点、素材组、pan/zoom/source width 均落本地权威；pointer move 只更新内存，pointer up/键盘离散动作才语义提交，视口使用 220ms debounce 与切换/卸载 flush。画板 UI 统一显示“素材组”，保留 1 秒 hover、直接 drop、发光和 tooltip。
- 画板节点实例 id 与中央 `asset_id` 分离，同一中央素材可在同一创作出现多次；规范化 SQLite group/member 可稳定投影回当前空间 UI，两个 session snapshot 的布局与视口互不串扰。
- 前端画板测试 **14/14**（原交互 9 + 持久投影 5）；300 节点 snapshot 投影在本机约 **13ms**，未测得需要复杂虚拟化的瓶颈。CS0–CS2 Rust 专项 **13/13**；桌面 Rust 全量 **236 passed + 2 ignored**，`cargo fmt --check`、前端 typecheck 与 production build 均通过。`cargo clippy --lib -- -D warnings` 仍被仓库既有 48 项 warning 阻断，本阶段未扩改无关代码。未调用 provider、未产生 credits 或外部副作用。

### CS3 — 新建创作入口与统一 Shell

目标：让用户从素材库自然进入一块创作画板。

- [x] CS3-T1：导入按钮右侧主入口改为“新建创作”，提供“新建空白画板”。
- [x] CS3-T2：新建创作只带入明确多选素材；空白画板始终不带入。
- [x] CS3-T3：实现项目/全局归属、全局创作“加入项目”与项目删除转全局提示。
- [x] CS3-T4：把 ProseMirror 创作编辑器抽为 `CreativeComposer`，挂在画板底部，维度/参考图/provider/比例能力不回退。
- [x] CS3-T5：画板模式收起全局 Sidebar，左侧使用可调宽素材源；顶部提供返回素材库、创作标题和画板/时间线切换。
- [x] CS3-T6：统一键盘/焦点：Esc 退出拖拽或关闭 inspector，不误删；Ctrl+Enter 发送；画布平移/缩放不抢编辑器滚轮和输入焦点。

验收：用户能从全局和项目分别走完两类入口；空白/带参考的初始状态准确；无修改退出不制造数据库垃圾。

**CS3 结果（2026-09-03）：**

- 工具栏主入口已收敛为“新建创作”分体按钮；默认入口只快照当前明确多选素材，“新建空白画板”始终忽略选择。两类入口均先创建 provisional 草稿，首次标题、画板或编辑器语义修改才单事务落库。
- 画板 Shell 已提供返回素材库、创作标题、画板/时间线切换和项目/全局范围；全局创作可原子加入项目并补齐已有资产成员关系，删除项目时会明确提示相关创作安全转为全局。
- ProseMirror 输入已抽为 `CreativeComposer` 嵌入画板，保留图片 chip、维度 token、provider 与比例能力；会话草稿使用版本化 JSON 保存。带参考入口将初始素材送入画板和编辑器，空白入口不注入；Ctrl+Enter 发送，Esc 只取消当前画板交互。
- 前端画板测试 **17/17**，覆盖入口语义、版本化草稿、重复素材实例、双会话隔离、显式父结果和 300 节点投影；桌面 Rust 全量 **243 passed + 2 ignored**。Agent 计划/结果/选择及来源浏览前端专项另有 **23/23**；前端 typecheck/production build、`cargo fmt --check` 与普通 `cargo clippy --lib` 均通过。CS5–CS7 自动实现没有调用 provider、没有产生 credits；真实 Agent Run 与升级库验收仍待人工步骤。

### CS4 — 普通生成接入画板

目标：普通生成的每轮、输出和分支成为画板关系，同时保持执行协议不变。

- [x] CS4-T1：`GenJob`、task payload、恢复 summary 新增 `creative_session_id`；旧字段保持兼容。
- [x] CS4-T2：首次发送写 prompt/reference 节点、input edge 和 generation link，再启动 provider。
- [x] CS4-T3：`started/done/error/submit` 事件按 job + turn 稳定 key 更新画板节点；失败保留可重试 prompt。
- [x] CS4-T4：结果 ingest 后幂等创建资产节点和 produced edge；当前项目成员关系继续正确。
- [x] CS4-T5：继续修改、轮级编辑、重试、重新编辑首轮映射为 continued/retry/branch 边，保持当前精确 refs 与基图规则。
- [x] CS4-T6：跨 provider 继续显式连接选中输出，不把 creative session id 传成 provider resume id。
- [x] CS4-T7：多 job 并行时每条分支独立更新；切换画板不取消后台任务，完成后回写原画板并显示未读状态。
- [x] CS4-T8：资产详情“回看生成对话”打开创作并定位节点；旧瀑布流同会话轮播保持可用。

验收：普通生成完整五段剧本（首轮、继续、重试、历史轮编辑、跨 provider）在同一画板重启前后关系一致；实际 provider 调用次数不因 UI 重放增加。

**CS4 结果（2026-09-03）：**

- `GenJob`、未完成/终态恢复摘要和 `generation_meta` 已携带独立的 `creative_session_id + turn_key`，旧 payload 通过 serde default 保持兼容；provider 的 `session_id`/submit id/resume 句柄仍沿用原协议，没有把本地创作 id 混入执行层。
- 每轮 provider 调用前先以单事务建立 prompt、reference、input/continued/retry/branch 边和 generation conversation link；确定性 `job + turn` 节点键使 started/submit/error/cancel/recover 重放只更新原节点，失败 prompt 保留可重试。
- 产物入中央库及当前创作所属项目后，output 节点与 produced 边幂等写入；普通继续、历史轮重试/编辑、首轮重试和跨 provider 交接均显式携带父结果，现有 exact refs 与后端基图合并规则未改写。
- 画板可直接显示 prompt 状态卡、关系线和生成结果，生成历史面板暂作为 CS6 前的兼容编辑层嵌在画板内；切换创作只关闭该层、不取消后台 job，原画板通过 `creative://changed` 回写，非当前创作显示未读点。
- 资产详情/右键“回看所属创作”会优先打开本地 creative session 并定位 output 节点；未迁移的旧生成记录继续回退到现有历史面板，瀑布流 conversation 轮播保持不变。
- 自动化基线：前端画板测试 **17/17**，含显式父结果选择；桌面 Rust 全量 **238 passed + 2 ignored**，新增图谱幂等/关系/定位与旧 payload 兼容回归；前端 production build、`cargo fmt --check`、普通 `cargo clippy --lib` 通过（仍为仓库既有 48 项 warning）。未调用 provider、未消耗 credits。

### CS5 — Agent Run 接入画板

目标：Agent 与普通生成共用创作容器，不改写 Agent 控制面。

- [x] CS5-T1：从画板 prompt/reference 节点构建 Agent 输入，创建成功后幂等写 `creative_agent_links`。
- [x] CS5-T2：将计划、澄清、审批、步骤事件和用户可见 artifact 投影到 Agent 执行组。
- [x] CS5-T3：用户可见过程/最终图入中央库后创建资产节点；重复 accept/recover 不重复节点或资产。
- [x] CS5-T4：支持从普通结果启动 Agent、从 Agent 结果继续普通生成，并保存明确父结果边。
- [x] CS5-T5：恢复 create/link 窗口、审批停车、执行中、awaiting feedback、已接受但尚未本地入库等现有故障窗口。
- [x] CS5-T6：统一 Agent/DSH 后续能力仍通过现有 Run/Tool Gateway；画板只做本地创作归属，不新增 Runner 或云端会话事实源。
- [x] CS5-T7：FeaturePolicy、积分、TTL、Codex 互斥和 dev/release 隐藏回归。

验收：一次正式允许的 Agent Run 从画板创建、审批、执行、反馈/接受、入库、重启恢复全通；Run/usage/artifact 数量与改造前一致。

**CS5 结果（2026-09-03，自动实现完成；真实 Run 待人工验收）：**

- 新增 additive migration `0022_creative_agent_projection.sql`，只为本地 `cloud_agent_runs` 增加 creative/launch correlation，并以 `run_id + artifact_id` 映射中央资产；没有新增云端表、Runner、计费或审批事实源。
- 画板发送前创建确定性 Agent prompt/reference/父结果图；远端 create 成功后立即 checkpoint，再上传/入队。列表恢复会幂等补齐“已有 checkpoint、尚未 link”的本地投影，不创建第二个 Run。
- Agent 组只保存有界安全投影：运行状态、当前步骤、进度、预算/实际积分摘要、最多 96 条展示事件、16 个审批、8 个澄清和 64 个用户可见 artifact 元数据；签名 URL、私有 payload 与隐藏思维不进入画板。
- 接受/恢复后的用户可见 artifact 仍先进入中央库，再幂等创建 intermediate/final 节点和 produced/agent_step 边；普通结果启动 Agent、Agent 结果继续普通生成都要求明确父输出。
- FeaturePolicy、Codex/正式 Agent 互斥、原 Run/Tool Gateway、usage ledger、TTL 与云端 control plane 未改写。自动测试覆盖安全快照、独立 Agent 表、checkpoint 补链、图谱/artifact 幂等和历史恢复；尚未执行新的真实 provider 调用。

### CS6 — 时间线、详情与旧 UI 收敛

目标：一份会话数据只保留一个用户入口。

- [x] CS6-T1：将现有普通 `TurnView` 和 Cloud Agent 展示拆成 `CreativeTimeline` 的两类事件 renderer。
- [x] CS6-T2：实现节点 inspector，展示精确 prompt、实际 prompt、references、provider、比例、视觉设定、状态、父节点和安全计量摘要。
- [x] CS6-T3：时间线点击事件定位画板节点；画板选中节点可跳到对应时间线事件。
- [x] CS6-T4：侧栏“生成会话”改为“创作”，一行代表一个 creative session；运行中/失败/未读从子执行派生。
- [x] CS6-T5：旧 `GenerationPanel`/`CloudAgentPanel` 降为 feature-flag 只读回退，停止新写入；验证后移除独立外壳与平行 active state。
- [x] CS6-T6：`CreationBoard` 独立发送外壳退出，保留通用 editor/ring/serialize 模块。

验收：同一创作在画板与时间线中轮次、图片、状态和版本数量完全一致；不存在“一个会话在侧栏出现两行”的普通/Agent 双记录。

**CS6 结果（2026-09-03，自动实现完成；legacy flag 关闭待 CS7 人工验收）：**

- `CreativeTimeline` 完全读取 creative nodes/edges，按事实创建时间展示普通 prompt/产物与 Agent 事件；节点详情显示实际 prompt、参考输入、父结果、provider、比例、视觉设定 id/version/hash、状态、Run/Runtime/Skill、安全计量与明确关系边。
- 时间线与画板共用选中节点：时间线可回到画板居中定位，画板选中后切时间线定位同一记录。Agent 事件展示限制在本地安全投影的最近 12 条，长历史不会无界撑开首屏。
- 侧栏生成页已改为“创作”，新 generation job/Agent Run 只派生到所属 creative session；仅未迁移记录进入 legacy 回退，避免同一创作出现 ordinary/Agent 双行。
- `LEGACY_CREATIVE_SESSION_FALLBACK_ENABLED` 当前保持开启，但非画板的旧 `GenerationPanel`/`CloudAgentSession` 已强制只读，不允许继续、重试、审批、澄清、本机工具、反馈、取消或入库。画板内复用的控制详情仍服务真实 Run，不成为第二份事实源。
- 非画板 `CreationBoard` 独立发送外壳已移除；正式发送只经画板中的 `CreativeComposer`。通用 ProseMirror editor、比例/provider、序列化和已有详情 renderer 继续复用。

### CS7 — 历史迁移、稳定性与发布

目标：证明升级安全并删除双事实源。

- [x] CS7-T1：实现 §6 普通生成与 Agent 历史 backfill，输出迁移数量和异常计数。
- [x] CS7-T2：用真实用户库副本做只读预检与复制库迁移；不得直接以正式库做首次试验。
- [x] CS7-T3：完成崩溃恢复矩阵：拖动未 flush、provider 已启动/未 link、结果已入库/未建节点、Agent create 成功/未 link、accept 后本地未入库。
- [x] CS7-T4：完成删除矩阵和项目归属矩阵。
- [x] CS7-T5：完成 300 节点、多分支、多运行任务、长时间线的性能与内存基线；若需要优化，只针对测得瓶颈。
- [ ] CS7-T6：进行桌面真机人工验收，确认旧会话、图片、prompt、项目归属和 Agent 历史仍在。**人工门槛。**
- [ ] CS7-T7：关闭 legacy UI flag，停止旧 canvas key 和平行会话 UI 写入；保留 additive DB 表使版本回退仍能读取旧核心历史。**依赖 T2/T6 通过。**
- [x] CS7-T8：按仓库规则更新 `PROJECT.md` 进展、关键约定、测试基线和踩坑；发布前另更新 Windows 交付说明。

验收：全量自动化与真机剧本通过；迁移前后 ordinary conversation/Agent run/生成资产数量可对账；回滚旧 UI 不需要回滚数据库或删除新表。

**CS7 实现与真实库副本演练结果（2026-09-03；停在桌面人工门槛前）：**

- 新增 additive migration `0023_creative_history_backfill.sql` 与版本化逐来源账本/报告；普通 conversation 和 Agent Run 使用确定性 session/node key 回填，资产只引用不复制，单坏来源隔离并清理自身部分投影，不回滚其他成功来源。
- `creative_history_backfill_preview` 是零写入预检，报告 schema 版本、generation/Agent 的 discovered/linked/processed/pending 及资产、conversation、Run、creative 基数；独立 `creative_backfill` 开发工具以 SQLite read-only 打开源库，以 Online Backup 为运行中的正式库创建一致性快照，并把执行入口硬限制在 `canvas-session-backfill-copy-*` 演练目录。正式启动仍未调用 backfill。
- 自动回归确认二次运行只 skipped、不增长节点/资产/link；用户删除已迁移创作后完成标记保留，后续不会复活；migration 从 v20 升级保留既有资产。
- 300 节点投影基线低于 200ms 测试闸值，本次实跑约 1ms；Agent 安全事件与各类摘要有硬上限，时间线只渲染安全投影。未测得需要引入空间虚拟化的新瓶颈。
- 真实用户库只读预检为 schema v20：191 个普通生成来源、24 个 Agent Run、190 个中央资产、111 个 generation conversation、0 个 creative session。运行中的正式库经 SQLite Online Backup 生成一致性副本；副本首次 v20→v23 回填为 ordinary **191/191**、Agent **24/24**、失败 **0**，资产仍为 **190**；第二次运行 ordinary/Agent 分别 skipped **191/24**，最终 linked/processed **215/215**、pending **0**、creative session **215**。正式库没有执行 migration 或 backfill。
- 开发态支持 `BOWERBIRD_LIBRARY_ROOT_OVERRIDE` 临时指向演练副本，不修改 `settings.json`，release 构建忽略该变量。下一步只剩 CS7-T6 桌面 E1–E6 人工验收；通过后关闭 legacy flag（T7）。

---

## 9. 总体验收剧本

### E1：带参考的新创作

1. 项目内选中 3 张素材，点击新建创作。
2. 三张图按选择顺序进入画板，composer 聚焦。
3. 发送普通生成，结果入库、加入项目并出现在 prompt 右侧。
4. 修改结果并重试首轮，画板出现两个明确分支。
5. 重启应用，布局、分支、参考顺序、精确 prompt 和 provider 均保持。

### E2：空白画板

1. 存在瀑布流多选时点击“新建空白画板”，画板仍为空。
2. 从左侧分别拖入同一素材两次，形成两个独立节点。
3. 两张素材 hover 1 秒形成素材组；向已有组 drop 立即加入并显示发光反馈。
4. 退出重开，素材组、坐标和视口恢复。
5. 选择素材组发起生成，只有显式选中的参考进入请求。

### E3：跨 provider 与后台任务

1. Provider A 首轮生成后，选中结果切 Provider B 继续。
2. Provider B 得到显式图片交接，不错误 resume Provider A session。
3. 任务运行中切换到另一创作，任务不中断。
4. 完成后原创作出现结果和未读提示，当前创作不被污染。

### E4：Agent

1. 由普通生成结果发起允许的 Agent Run。
2. 计划/审批/事件在 Agent 组中可看，批准前无生图副作用。
3. 接受结果后全部用户可见产物入库并落在原画板。
4. 在 awaiting approval、running、awaiting feedback 三处分别重启，均恢复同一 Run，不重复调用或扣费。

### E5：历史迁移

1. 用包含单轮、多轮、版本分支、跨 provider 和 Agent 历史的升级库启动。
2. 每个旧 ordinary conversation/Agent run 都能打开成画板。
3. 第二次启动 backfill 数量为 0；节点、资产和 link 不增长。
4. 从任一旧生成图详情进入，能定位正确创作和结果节点。

### E6：删除与项目

1. 从画板移除结果节点，中央库图片仍在。
2. 删除创作，中央库与账单历史仍在。
3. 删除项目，创作转全局且可打开。
4. 物理删除中央资产，画板显示 tombstone；历史 prompt 和执行关系仍可审计。

---

## 10. 测试矩阵

| 层级 | 必测内容 |
|---|---|
| 纯函数 | 坐标/zoom clamp、吸附、hover 建组、自动布局、分支位置、edge graph 校验 |
| SQLite | fresh/upgrade migration、CRUD、FK、幂等 link、项目转全局、tombstone、删除语义 |
| Rust command | 事务边界、project member + node 原子写、非法 node/edge enum、历史 backfill |
| 前端 store | provisional draft、切创作、多 job 路由、未读、debounce/flush、错误保留 prompt |
| 普通生成 | Codex/即梦/Cloud 的首轮、续轮、重试、精确重放、跨 provider、恢复 |
| Agent | create/link、审批、事件、artifact、accept、TTL、本地入库、故障恢复、FeaturePolicy |
| 兼容 | 旧 task payload、旧 generation conversation、旧 Agent snapshot、旧资产详情入口 |
| 真机 | 拖放、平移缩放、素材组动效、编辑器焦点、长时间线、重启、Windows 安装版升级 |

所有涉及真实 provider 的测试沿用现有持续授权和事后透明报告约定；必须报告调用次数、token/图片、credits、provider cost 和失败/unknown，不因本专项新增额外无目的调用。

---

## 11. 风险与止损条件

| 风险 | 预防/止损 |
|---|---|
| 把 creative session 与 provider session 混为一谈 | 上层独立 ID + link 表；跨 provider fixture 为 CS0/CS4 硬门槛 |
| 空间自由导致执行关系丢失 | 显式 edge/parent/turn key；坐标永不参与执行 |
| 画板与时间线双写漂移 | repository 单事实源；时间线只投影；legacy UI 改为只读后再删除 |
| 拖动频繁写库造成卡顿 | pointer move 内存化、pointer up 语义提交、视口 debounce；先做 300 节点基线 |
| 历史迁移产生重复资产/会话 | additive schema、unique link、确定性 node key、可重跑 backfill、复制库预检 |
| Agent create/link 崩溃窗口重复 Run | 本地 run 恢复扫描补 link；禁止因 link 缺失直接重发 create |
| 项目删除误删创作历史 | `ON DELETE SET NULL` + UI 数量提示 + 回归测试 |
| 画板成为任意 workflow 产品导致范围爆炸 | 首版只做固定生成/Agent 关系展示；没有任意执行节点或自定义 DSL |
| 旧 UI 一次性删除导致难以回退 | 一个发布周期只读 feature flag；DB 只 additive，最终验收后移除 |

止损条件：

- 若 CS0 无法用统一 graph 表达普通精确重放与 Agent 审批，不进入 UI 重构，先修正数据契约。
- 若历史 backfill 无法做到幂等或数量对账，不关闭旧会话入口。
- 若画板投影导致 provider 调用、Agent usage 或资产入库出现重复，不扩大试用并回退到 legacy 只读入口排障。
- 若 300 节点基线在常规开发机上明显阻塞输入/拖动，先做空间裁剪或简化节点内容，不继续叠加视觉功能。

---

## 12. 推荐执行顺序与依赖

```text
CS0 契约
  ↓
CS1 本地数据层
  ↓
CS2 持久画板
  ↓
CS3 统一入口/Shell
  ↓
CS4 普通生成 ──→ CS6 时间线与旧 UI 收敛
  ↓                    ↑
CS5 Agent 接入 ────────┘
  ↓
CS7 迁移、稳定性与发布
```

- CS4 必须先于 CS5：先用较简单的普通生成验证上层创作容器，再接 Agent 的审批/TTL/计量状态。
- CS6 必须在 CS4/CS5 都有同源事件后收敛，不能先删现有会话详情。
- 本专项首版只需本地 SQLite migration；不要求新增 Supabase 表或修改 VPS Agent Kernel。
- 若 CS5 发现云端 Run 需要透传本地 creative id，只能作为不可授权、不可计费的 correlation metadata，并需先更新 Agent Runtime 契约；不得把它提升为云端业务事实源。

---

## 13. 首版交付清单

- `creative_sessions/nodes/groups/edges/views` 本地 schema 与 repository。
- 普通生成、Agent Run 到 creative session 的显式 links。
- 可持久的多创作画板与项目归属。
- 新建创作/新建空白画板入口。
- 左侧可调宽素材源、无边画板、吸附和素材组交互。
- 画板内统一 ProseMirror composer。
- 普通生成轮次、输出、继续、重试和分支图。
- Agent 计划/审批/事件/产物的可收起执行组。
- 画板/时间线双视图和节点 inspector。
- 历史 ordinary/Agent 会话幂等 backfill。
- 删除、崩溃恢复、项目归属和性能测试矩阵。
- legacy 只读回退与最终退出路径。

---

## 14. 文档维护规则

1. 本文是该专项的执行权威；项目定位、当前进展、关键约定和踩坑仍只写 `PROJECT.md`。
2. 每完成一个 CS 阶段，更新本文状态、任务卡结果和准确测试基线。
3. 开始实现后，在 `PROJECT.md`“近期里程碑”记录阶段变化；关键模型变化同步更新关键约定。
4. 若改变 provider、Agent、计费或云端边界，必须同时核对 `AI-PROVIDERS.md`、`AGENT-RUNTIME-PLAN.md`、`UNIFIED-AGENT-HARNESS-PLAN.md` 与收费化文档。
5. 只有用户说“存档”时才按仓库规则执行 git commit；单纯更新专项计划不自动提交。
