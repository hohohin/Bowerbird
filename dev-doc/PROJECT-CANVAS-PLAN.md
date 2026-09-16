# Bowerbird「项目即画板」开发专项计划

> **2026-09-10 视觉规范边界同步：** 视觉规范独立保存，项目只引用用户所选版本；项目删除不能删除规范或把其来源判为项目独有素材。决策见 [PROJECT.md](../PROJECT.md) 约定 26/47，规范契约见 [AGENT-RUNTIME-PLAN.md](AGENT-RUNTIME-PLAN.md) §8。
> 文档版本：v2.1 · 2026-09-04
> 决策状态：2026-09-04 自动化审计纠偏已收敛；PB0–PB6 的勾选只代表既有实现证据，当前按 PCU0–PCU6 验收，尚待真实 DOM/Tauri、Windows 真机与升级副本验证
> 发布状态：用户已明确放弃旧用户可见会话历史的迁移与保留；禁止执行历史 backfill，正式用户库保持零写入，项目、中央资产、文件、计费与底层执行审计仍必须保留
> 适用范围：桌面端项目、无限画板、画板内创作线程、普通生成、Cloud Agent、项目内详情、任务恢复与旧会话入口退出
> 替代文档：`CANVAS-SESSION-PLAN.md` v0.8；旧文档只保留为实施与测试证据

---

## 0. 一页结论

Bowerbird 的用户侧一级创作对象收敛为“项目”：

> **一个项目 = 一块无限画板；一块画板可以包含多条创作线程。**

画板不再是项目下面需要单独创建、命名和管理的对象。打开项目就是打开它唯一的无限画板；项目素材、所选视觉规范的引用、空间布局、普通生成、Agent Run、版本分支与时间线都在这个工作空间中协作。

“创作会话”不再出现在主导航，也不拥有画板。它降为画板内的 **创作线程**：由一次独立意图开始，并包含该意图的继续修改、重试、跨 provider 交接、Agent 处理和结果分支。普通 provider session、Cloud generation job、Agent `run_id/conversation_id` 仍是更底层的执行与恢复身份，不能冒充项目或创作线程。

```text
中央素材库
├─ canonical assets
├─ 文件夹 / 分类 / 标签 / 收藏夹
├─ 独立视觉规范（任何创作可选用）
└─ 项目 A = 一块无限画板
   ├─ 项目素材池与本次创作选用的规范快照
   ├─ 自由参考、便签、素材组和视口
   ├─ 创作线程 1
   │  ├─ prompt / references
   │  ├─ 普通生成 job / provider session
   │  ├─ Agent Run / 计划 / 审批 / 事件
   │  └─ 结果、继续、重试与版本分支
   └─ 创作线程 2
      └─ 另一组互不相连的执行图
```

首版完成后：

- 侧栏只管理项目，不再另列一份“创作会话”。
- 新建项目后直接进入空白画板；工具栏“新建创作”也是创建项目并进入画板的快捷入口。
- 若入口触发时已有明确选中素材，可将其作为项目初始素材和画板参考；“新建空白项目”始终忽略选择。
- 完全未修改的 provisional 项目退出后不落库，不制造“未命名项目”。
- 在画板空白区域发起新 prompt 时创建新线程；从既有结果继续、重试或启动 Agent 时沿用原线程。
- 时间线默认只显示当前线程，并提供“项目全部活动”；坐标永远不定义执行顺序。
- 拖素材进入画板、分组或移除不改变中央库文件夹、分类、标签或物理文件。
- 2026-09-17 显式例外：项目素材区右键「从库中删除 · 在画布保留」可将已有画板图片设为仅画板展示；素材库列表和数量排除该图片，文件、节点身份和引用关系保留。画板右键可重新加入素材库；最后一个可见画板实例移除后恢复库内可见性，避免孤立文件。实现与验收以 PROJECT.md 同日约定为准。

---

## 1. 决策背景与当前闸门

### 1.1 为什么替代“一画板一会话”

旧模型“项目 → 多个创作会话 → 每个会话一块画板”解决了生成详情、Agent 历史和空间画板三套状态不一致的问题，但仍有四个结构性冲突：

1. 无限画板本来可以在不同区域容纳多条独立创作线程，按会话拆板会把相关探索切碎。
2. 视觉规范选择、项目素材池和生成现场被分到两层，用户需要反复选择上下文；改善入口不代表把规范归属到项目。
3. 真实库副本中有 191 个普通生成来源和 24 个 Agent Run；逐来源建画板会把侧栏变成聊天历史。
4. “新建项目”“新建创作”“新建空白画板”都在表达开始一个工作空间，入口职责重叠。

新模型的代价是单项目可能积累大量节点，因此线程聚焦、定位、项目活动筛选、性能门槛和必要时的视口裁剪必须进入首版，而不是留给未知未来。

### 1.2 旧专项中可复用的成果

`CANVAS-SESSION-PLAN.md` v0.8 的 CS0–CS7 已完成自动实现但尚未发布。以下能力继续复用：

- SQLite 节点、边、素材组、视口、普通 generation link 与 Agent link repository。
- 无边画板、可调素材栏、重复素材实例、边缘吸附、hover 1 秒建组、folder drop 即加入和浅蓝发光。
- ProseMirror composer、普通生成分支、Agent 安全投影、画板/时间线互相定位。
- provider session、Agent Run、FeaturePolicy、积分、审批、TTL 与 Tool Gateway 的独立权威边界。
- 历史 preview、SQLite Online Backup、逐来源账本、幂等重跑、失败隔离和删除后不复活。
- 真实用户库副本曾完成 ordinary 191/191、Agent 24/24、0 失败、二次全部 skipped；正式库未执行。

以下旧结论已失效：

- 一个项目拥有多个用户可见会话/画板。
- `project_id=NULL` 的全局画板是长期正式对象。
- 侧栏“创作”一行对应一块画板。
- 每个历史 conversation/Run 自动生成独立画板。
- 删除项目后把画板转为全局创作。
- `creative_session_id` 同时承担画板根、一级对象和执行归组。

### 1.3 当前发布闸门

PCU0–PCU6 完成前：

- 不得对正式用户库执行任何旧会话 backfill；0021–0023 与 `creative_backfill` 只保留为兼容代码和测试证据。
- 不再以“旧历史是否迁入新画板”作为发布条件，也不得为兼容旧会话继续扩展用户侧路由。
- 不得删除项目、中央资产、原始文件、普通 generation、Cloud Agent、计费记录或底层执行审计。
- 可以在临时开发库验证新建项目后的新链路；不得把复制库验证误写为正式发布完成。
- 顶层路由、项目归属、线程归属、节点身份和终态恢复任一仍存在双重权威时，不得发布。

---

## 2. 对象职责与不可变规则

### 2.1 中央素材库

- 资产文件与 metadata 的唯一权威。
- 文件夹、分类、标签、颜色和收藏夹负责长期整理与检索。
- 同一 `asset_id` 可以被多个项目引用，也可以在同一画板出现多个实例。
- 删除项目不删除中央资产；物理删除资产仍走现有危险确认。

### 2.2 项目

- 用户侧唯一一级创作对象，拥有标题、项目素材、创建/更新时间和一块无限画板；创作可引用独立视觉规范。
- 项目与画板生命周期一致：创建项目即拥有画板，打开项目即进入画板，删除项目即删除画板布局。
- 一个项目恰好一块画板；首版不支持项目内第二块画板、页面或 tab。
- 新项目必须有 `project_id`；不再创建长期 `project_id=NULL` 的画板。
- 项目标题是唯一标题权威，画板根不得再维护一份可漂移的标题。

### 2.3 画板

- 项目的空间主视图，不是独立用户对象。
- 保存节点、边、素材组、视口、编辑草稿和当前选择提示。
- 位置只决定展示，不决定时间、因果、重试父级或 provider resume。
- 画板“文件夹”统一称“素材组”；素材组没有文件系统或素材库归档语义。

### 2.4 创作线程

- 一条线程是一组有明确因果关系的执行图，可以同时包含普通生成、不同 provider 和 Agent Run。
- 在空白区域发送无父结果的新 prompt 时创建线程。
- 从既有结果继续、重试、编辑历史轮、跨 provider 或启动 Agent 时沿用该结果所属线程。
- 单纯拖入素材、写便签、移动节点或分组不创建线程。
- 线程不是侧栏一级对象；默认通过选中节点聚焦，必要时只在项目内部提供轻量索引。
- 已进入执行历史的线程只能归档/隐藏，不能通过画板删除抹掉审计关系。

### 2.5 执行身份

- 普通 `task_queue`、provider session、Cloud generation job 和 Agent Run 保持各自状态机。
- `project_id` 与 `thread_id` 只用于本地创作归属和安全 correlation，不是恢复令牌或计费身份。
- Agent 计划、审批、usage、artifact 和终态继续以云端控制面为权威。
- 普通生成精确 refs、resume、retry 和跨 provider 交接继续以现有 generation 数据为权威。

### 2.6 关系不变量

1. 所有画板节点、组、边和线程属于同一项目。
2. prompt、output、Agent group 等执行节点必须属于线程；自由素材和便签允许 `thread_id=NULL`。
3. execution edge 两端必须同项目；除自由参考输入外，两端非空 thread 必须一致。
4. 一个 generation conversation 或 Agent Run 只能链接到一个线程。
5. 素材组可以整理同项目中不同线程或自由节点，但不会合并线程或改变执行关系。
6. 时间线顺序来自不可变事件时间、ordinal 和稳定 ID，不读取坐标或 DOM 顺序。

---

## 3. 用户路径与交互

### 3.1 创建入口

两个入口底层都创建“项目 + 唯一画板”：

- **新建创作**：工具栏主入口，继续放在导入按钮右侧；快照当前明确选中素材，进入 provisional 项目并把素材铺入画板。无选择时就是空白项目。
- **新建空白项目**：始终忽略当前选择，进入空画板并聚焦 composer。

在首次拖入素材、写入非空草稿、改名、创建组或发送前，项目仅存在于前端；原样退出不落库。首个非空 prompt 可以自动生成项目标题，手动标题始终优先。不再提供独立“新建画板”或“新建会话”。

### 3.2 打开与导航

- 侧栏项目项是唯一工作空间入口，点击直接恢复项目画板和视口。
- 主区默认显示画板，顶部可切换“画板 / 时间线”。
- 运行中、失败和未读聚合到项目项，点击后定位具体线程。
- 资产详情“回看生成过程”打开所属项目并定位节点；同一资产属于多个项目时先列出关联项目。

### 3.3 左侧素材源

- 画板模式下应用主左栏自动收起；收起轨宽约 50px（较原 72px 缩减约 30%），用户仍可手动展开；画板内素材源默认约占主区 1/3，可拖动调整。
- 素材源默认显示项目素材，可切换中央库搜索与筛选。
- 中央素材首次拖入项目时，`project_assets` 与画板节点在同一事务写入。
- 生成结果先进入中央库，再加入项目，并在原线程创建输出节点。

画板默认左键用于选择：单击图片节点同时把该图片加入当前创作输入；节点超过轻微抖动阈值后才进入位置拖动。画板平移仅由按住空格时的左键拖动或中键拖动触发，普通左键点击空白区域只清除选择；触控板滚动与 `Ctrl/Command + 滚轮` 缩放保持可用。

### 3.4 线程与时间线

- 无父 prompt 创建新线程；继续、重试、跨 provider、普通/Agent 互转沿用父结果线程。
- 选中执行节点后聚焦该线程，其他线程降低对比度；“显示全部”只改变视图。
- 时间线默认展示当前线程；未聚焦时展示“项目全部活动”并明确线程边界。
- 时间线点击定位画板节点；画板节点可跳到相同事件。
- 线性时间线不得把版本分支伪装成单链，parent/edge 仍须可见。

### 3.5 拖放与素材组

- 左侧工具栏「辅助」板块提供吸附开关，默认开启并记住本机选择；节点边缘贴靠或隔开一定距离时均可对齐吸附，静止节点保持原位。对齐识别间隔最多 600 屏幕像素，吸附容差为 24 屏幕像素；同尺寸横排/竖排显示上下/左右两条辅助虚线，保持自由方向间隔，尺寸不同仅显示实际对齐边；关闭后自由摆放且不显示吸附线。
- 拖到普通素材并持续 hover 1 秒后显示“松开创建素材组”tooltip；只有在同一目标素材范围内松手才创建透明素材组。提前松手、移出、切换目标或取消拖拽均不成组，重新进入目标需重新计时。
- 拖到已有素材组时无需等待，松手立即加入。
- hover 已有组时轻微放大并显示浅蓝色边缘发光；退出或 drop 后恢复。
- 分组不改变线程、项目素材成员、文件夹或分类。
- 左键点击素材组在画板原位置展开全部成员，浏览/创作模式一致，不再整组加入对话框或直接轮播；展开采用主界面项目的边框、标题栏和图片网格风格，可收起。展开后的单图沿用当前模式的单图操作，右键保留显式整组添加和解散；展开不改变保存的组尺寸或成员关系。

### 3.6 删除语义

| 操作 | 结果 |
|---|---|
| 从画板移除自由素材/便签 | 删除节点，不删除中央资产 |
| 从画板移除已执行节点 | 设置隐藏，时间线、边和审计保留 |
| 删除素材组 | 默认解组保留节点；显式移除整组仍不删资产 |
| 归档线程 | 从默认画板/时间线过滤中隐藏，可恢复 |
| 删除项目 | 删除项目画板、线程和本地 links；中央资产、账单和低层执行审计保留；运行中任务先阻止 |
| 删除中央资产 | 走危险确认；相关节点变 tombstone，不改写历史 prompt 或边 |

---

## 4. 目标数据模型

> 以下是逻辑契约。PB0 必须先确认正式用户库仍停在 v20，再决定最终 migration 编号；未发布的旧 v21–v23 表名不能反向约束产品模型。

### 4.1 项目画板

`project_canvases`：

- `project_id`：主键并引用 `projects(id) ON DELETE CASCADE`，同时就是画板身份。
- `draft_json`：只存版本化 composer 草稿，不存标题、计费或 provider 状态。
- `created_at/updated_at`。

不新增用户可见 canvas id。项目标题和生命周期继续由现有项目表负责；视觉规范独立持久化，生成记录只冻结所选规范的 ID/版本/hash。

### 4.2 创作线程

`creative_threads`：

- `id`、`project_id NOT NULL`。
- `title`：仅用于项目内定位，默认取首个 prompt；不是侧栏一级标题。
- `origin`：`direct | generation_backfill | agent_backfill | merged_legacy`。
- `archived_at`、`created_at`、`updated_at`。

线程状态由 job/Run 与用户可见输出派生，不缓存第二份 `active/completed/failed`。

### 4.3 节点、组、边与视口

`canvas_nodes`：

- `id`、`project_id NOT NULL`、可空 `thread_id`。
- `kind`、`asset_id`、`role`、版本化 `payload_json`。
- `x/y/width/height/z_index/position_locked/hidden_at` 与时间戳。
- prompt/output/intermediate/final/Agent group 必须有 thread；自由 asset/note 可以无线程。
- 同一素材可在同项目出现多次；资产删除后保留最小 tombstone，不保存第二份原图。

`canvas_groups/canvas_group_items`：

- 以 `project_id` 归属；一个节点首版最多一个组，组内 `ordinal` 唯一。
- group 与 node 必须同项目；素材组不存 thread，不改变执行归属。

`canvas_edges`：

- `id/project_id/thread_id/from_node_id/to_node_id/kind/ordinal/created_at`。
- 两端节点同项目；目标执行节点属于 edge thread。`input` 的来源若为 `asset/reference`，可复用同项目其他线程的参考节点，保留原归属与执行身份；其他来源和续作/重试/分支仍须同线程。SQLite 0024 与 Rust 校验保持一致（2026-09-06）。
- SQLite trigger 与 Rust repository 双层拒绝跨项目、非法端点和 DAG 环路。

`canvas_views`：

- 以 `project_id` 为主键。
- 保存 pan、zoom、素材栏宽度、active node、focused thread、view mode 和 timeline scope。
- 视口与聚焦只是 UI hint，不是执行事实；继续沿用现有 clamp 与 debounce。

### 4.4 执行 links

`thread_generation_links(thread_id, generation_conversation_id UNIQUE, created_at)`。

`thread_agent_links(thread_id, run_id UNIQUE, created_at)`。

- 一个线程可以链接多个 ordinary conversation 和多个 Agent Run。
- `GenJob` 与本地 Agent checkpoint 携带 `project_id + thread_id`；旧字段只做兼容读。
- link 缺失时只能从已有本地执行记录补链，禁止重发 provider 或创建第二个 Run。

### 4.5 旧 `creative_sessions` 的处理原则

旧 0021–0023 尚未进入正式用户库，但已经用于开发副本。PB0 必须把两条路径分开：

1. **正式发布路径**：以 v20 为升级源，落干净的 project canvas/thread schema，不把 `creative_sessions` 暴露为正式业务概念。
2. **开发 v21–v23 路径**：提供一次转换，或明确要求从 v20 一致性备份重建；不能为了保留临时开发库而让正式模型继续背负错误语义。

选择标准是正式数据安全和最终 schema 清晰度，不以减少临时代码改动为优先。

---

## 5. 写入、恢复与历史迁移

### 5.1 新项目与执行写入顺序

1. 前端建立 provisional project，不写数据库。
2. 首次有意义修改时，单事务创建 project、project canvas、初始 project assets、节点和视口。
3. 首次发送时先创建/确认线程，写 prompt/reference、edge、local job identity 和 link，再启动 provider。
4. provider 启动失败不删除项目或 prompt，节点显示可重试失败。
5. Agent create 成功后立即 checkpoint project/thread/launch/run，再补 link；崩溃恢复不得创建第二个 Run。
6. 结果和用户可见 artifact 先入中央库与项目，再幂等创建原线程节点。

### 5.2 历史迁移 v2

迁移从原始 ordinary/Agent 历史重建，不能把旧 v0.8 副本中的 215 个 creative session 当新事实源。

已有项目归属的历史：

- 每个现有项目只创建一块画板。
- 每个旧 generation conversation 或独立 Agent 来源创建线程；只有稳定 parent/correlation 能证明连续时才合并。
- 同项目多个旧空间按 `(created_at, stable source id)` 排序，以不重叠网格偏移放入同一画板，来源内部相对坐标不变。

无项目归属的历史：

- 默认创建系统项目“未归档创作”，每个来源成为独立线程和空间区域。
- dry-run 必须报告预计节点数、画布范围、project/thread 数和渲染基线。
- 若节点数超过 PB6 已验证上限，不得生成不可用巨型画板；正式执行前按年份确定性分片为“未归档创作 YYYY”，并把规则写进报告。

共同规则：

- 使用新的版本化逐来源账本；旧 v0.8 完成标记不能冒充新契约完成。
- 资产只引用不复制，坏来源隔离；二次执行全部 skipped。
- 用户删除项目/线程后完成标记保留，来源不自动复活。
- 迁移前后 asset、generation conversation、Agent Run、project、thread、node、edge 和 link 全量对账。
- 正式执行前重新从运行中用户库做 SQLite Online Backup；旧演练副本不能直接晋升。
- 回滚只切 UI/read path，不删新表、不改低层历史、不触发反向 provider 操作。

---

## 6. 组件与代码边界

```text
ProjectCanvasShell
├─ ProjectSourcePanel       # 项目素材 / 中央库，复用 MasonryGrid
├─ ProjectCanvas
│  ├─ AssetNode / PromptNode / AgentRunGroup
│  ├─ CanvasGroup
│  └─ CanvasEdges
├─ CreativeComposer
├─ ProjectTimeline
│  ├─ FocusedThreadTimeline
│  └─ AllProjectActivity
└─ CanvasInspector
```

状态权威：

- SQLite/repository：project canvas、thread、node、edge、group、view、links。
- Zustand：active project、拖拽/框选、临时视口、focused thread 和运行中 UI 镜像。
- `task_queue` / provider：普通生成执行状态。
- Cloud Agent 控制面：Run、审批、usage、artifact、TTL 和终态。
- 中央素材库：资产文件与 metadata。

应复用现有画板纯函数、`MasonryGrid` 拖放、`CreativeComposer`、生成/Agent 安全投影、稳定节点 key、恢复逻辑和 `CreativeTimeline` renderer。

应退出：侧栏 creative session 列表、`CreativeSessionShell` 第二层页面、全局创作 UI、以 `creative_session_id` 路由整个画板的 API、项目删除后 `ON DELETE SET NULL`、逐历史来源创建独立画板的 backfill。

不得强行合并：普通 task queue 与 Agent Run、provider session 与本地 thread、Agent 审批/计量事实与画板快照、项目素材成员与画板节点实例。

---

## 7. 分阶段任务卡

### PB0 — 新契约与迁移路径冻结

- [x] PB0-T1：建立单项目多线程、自由参考复用、普通→Agent→普通、跨 provider 和重试分支 fixture。
- [x] PB0-T2：冻结 project/thread/node/edge/group/view/link enum、payload schema 与大小上限。
- [x] PB0-T3：审计正式库与所有 v21–v23 开发副本；正式库当前为 project-canvas v23、尚无 v2 回填账本。
- [x] PB0-T4：确定正式 migration 落号和开发库转换/重建策略，禁止两套可写事实源。
- [x] PB0-T5：只读统计 project-owned/unscoped 来源分布，生成历史合并 dry-run。
- [x] PB0-T6：证明 legacy flag 仍开启且旧 CS7-T6/T7 已暂停。

验收：fixture 仅凭 project/thread/edges/stable execution id 可重放；迁移输入和目标数量可计算；三层身份无歧义。

### PB1 — Project Canvas 数据层

- [x] PB1-T1：落地 project canvas、thread、node、group、edge、view 和 thread links schema。
- [x] PB1-T2：SQLite/Rust 双层拒绝跨项目关系、非法 thread、端点和环路。
- [x] PB1-T3：实现全部语义 CRUD 和 project canvas 一对一约束。
- [x] PB1-T4：实现 provisional project 的事务性 materialize。
- [x] PB1-T5：实现项目删除保护、线程归档、执行节点隐藏和资产 tombstone。
- [x] PB1-T6：迁移/复用稳定 node/edge key，证明 replay 不重复。

验收：fresh v20 与选定开发兼容路径通过；一个项目无法创建第二画板；删除项目不删资产、账单或执行审计。

### PB2 — 命令与前端状态改为项目中心

- [x] PB2-T1：新增 project canvas commands/types，旧 creative-session commands 退出可写与导航面，仅保留旧 payload 兼容读。
- [x] PB2-T2：Zustand 改为 `activeProjectId/focusedThreadId`，移除平行 active session。
- [x] PB2-T3：切项目前 flush 视口/草稿；后台 job/Run 不因切换取消。
- [x] PB2-T4：实现线程聚焦、显示全部、未读和项目聚合状态的纯函数测试。
- [x] PB2-T5：asset detail、通知和后台完成事件定位 project + node。
- [x] PB2-T6：旧 payload 兼容读；所有新写入必须带 project + thread。

验收：重启、切项目、后台完成和资产反查只定位项目画板；前端不存在两套 active id。

### PB3 — 项目即画板的入口与导航

- [x] PB3-T1：侧栏移除“创作”一级列表；项目项直接打开 `ProjectCanvasShell`。
- [x] PB3-T2：实现带选择的“新建创作”和忽略选择的“新建空白项目”。
- [x] PB3-T3：未发生有意义修改不落库；首 prompt 自动标题且手动标题优先。
- [x] PB3-T4：复用可调素材栏、无边画板、吸附、hover 建组和 folder drop 动效。
- [x] PB3-T5：项目素材/中央库切换明确，首次拖入时成员与节点原子写入。
- [x] PB3-T6：统一画板/时间线/项目设置；当时的“视觉设定归项目”已由 2026-09-10 独立规范决策取代。
- [x] PB3-T7：删除项目提示节点、线程和运行任务影响。

验收：所有创建路径只得到一个项目和一块画板；界面不存在“项目下面再选画板”。

### PB4 — 多线程生成、Agent 与时间线

- [x] PB4-T1：无父 prompt 新建线程；继续、重试、历史轮编辑和跨 provider 沿用原线程。
- [x] PB4-T2：ordinary job/link/recovery 改带 project/thread，执行协议不变。
- [x] PB4-T3：Agent create/checkpoint/link/artifact 投影改带 project/thread，故障窗口幂等。
- [x] PB4-T4：普通→Agent→普通保持同线程和明确父输出。
- [x] PB4-T5：线程聚焦不影响拖动、组、选择、输入引用或节点命中。
- [x] PB4-T6：时间线实现当前线程/项目全部活动，并与画板双向定位。
- [x] PB4-T7：项目 active/failed/unread 从线程子执行派生。
- [x] PB4-T8：FeaturePolicy、积分、审批、TTL、Codex 互斥和 DSH/Tool Gateway 回归。

验收：同项目多线程并行不串数据；跨 provider、普通/Agent 互转不串 thread；画板与两种时间线数量一致。

### PB5 — 历史合并 backfill v2

- [x] PB5-T1：实现新的 versioned backfill 与逐来源账本。
- [x] PB5-T2：同项目来源合并到同一画板，每来源建线程并稳定错位布局。
- [x] PB5-T3：无项目来源进入未归档项目，超门槛时按 preview 规则分片。
- [x] PB5-T4：只用确定性 correlation 合并 ordinary/Agent 线程，不猜 prompt 相似度。
- [x] PB5-T5：全量数量对账、二次全 skipped、删除后不复活、坏来源隔离。
- [x] PB5-T6：使用重新生成的 Online Backup 副本演练，正式库零写入。

验收：每个旧来源可从项目画板/时间线定位；同项目只有一块画板；0 资产复制、0 重复 link、0 未解释差异。

**2026-09-03 演练记录：** 正式库只读 preview 识别 191 条 ordinary generation、24 条 Agent Run、190 个中央资产、111 个 conversation、4 个已有项目；预计 4 块目标画板、202 条线程、846 个节点，14 条确定性 correlation 形成 13 次有效合并。使用 SQLite Online Backup 新建 `.tmp/project-canvas-backfill-copy-20260903-173123/library.db` 后执行 v2：191 + 24 来源全部完成、0 失败，资产保持 190→190，项目 4→5，线程 0→202，节点 0→803，边 0→591，ordinary links 0→191，Agent links 0→24，资产复制 0、未解释差异 0；第二次执行 215 条全 skipped 且所有数量不变。演练期间正式库未执行 v2 回填。

### PB6 — 性能、恢复与人工验收

- [ ] PB6-T1：测量 300/1000 节点、多线程长时间线的加载、平移、缩放、聚焦和内存。
- [ ] PB6-T2：只针对实测瓶颈做 viewport culling、延迟加载或缩略层级。
- [ ] PB6-T3：覆盖拖动未 flush、provider 已启动未 link、结果已入库未建节点、Agent create 未 link、accept 未入库。（ordinary/Agent 投影恢复与幂等重放已自动覆盖；拖动后立即退出留待真机 P5。）
- [x] PB6-T4：覆盖项目删除、资产删除、线程归档、运行任务、项目成员和 tombstone 矩阵。
- [ ] PB6-T5：在真实库新副本执行 P1–P7 人工剧本；真实调用按既有授权报告成本。
- [ ] PB6-T6：Windows dev 与安装包升级各验证一次。

验收：真实副本和真机通过；没有重复 provider 调用、重复扣费、丢资产或跨项目写入。

**自动验证基线（2026-09-03）：** 桌面 Rust 全量 244 passed / 2 ignored；画板逻辑 24/24（含 300/1000 节点 hydration、1000 节点多线程时间线、provisional 有效草稿门）；Agent plan/result/selection 与来源发现 23/23；TypeScript 与 production build 通过。纯数据投影没有达到 culling 门槛；PB6-T1 的真实交互/内存、PB6-T5 P1–P7 和 PB6-T6 Windows dev/安装包仍必须在隔离副本与真机完成，不能用纯函数耗时替代。

### PB7 — 发布收口

- [ ] PB7-T1：复核最终 diff、migration、回填报告、自动测试和人工记录。
- [ ] PB7-T2：正式库按 preview → 备份 → schema → backfill 执行，每步可停回只读 legacy。
- [x] PB7-T3：关闭旧 creative-session 导航和写入，legacy 保留一发布周期只读回退。
- [ ] PB7-T4：验证稳定后删除旧 UI active state 和不可达入口，不删除低层历史。（源码清理已完成，等待真机验证后关闭任务。）
- [ ] PB7-T5：更新 `PROJECT.md`、本专项、Windows 说明和准确测试/部署基线。

验收：用户只看到项目画板；正式库对账通过；回滚 UI 不需删表或恢复资产；文档不再宣称“一会话一画板”。

---

## 8. 总体验收剧本

### P1：带参考创建项目

从中央库选中 3 张素材后点击“新建创作”；进入唯一画板，发送后项目正式落库并自动标题，结果入库并加入同一线程；重启后项目、视口、参考、prompt、provider 和结果保持。

### P2：空白项目与素材组

有多选时点击“新建空白项目”仍为空；原样退出不留垃圾项目。再次创建后拖入同一素材两次，只有一个项目成员、两个节点；hover 普通素材 1 秒建组，drop 到已有组立即加入并显示放大和浅蓝发光；重启后恢复。

### P3：同项目多线程

在两个空白区域分别发送无父 prompt，得到线程 A/B；两者同时生成互不污染。聚焦时只突出目标线程；当前线程时间线不混入另一线程，项目活动包含两者。

### P4：分支与跨 provider

从线程 A 结果继续、编辑历史轮并重试，都留在线程 A 并产生明确边；Provider B 接收显式图片交接，不 resume Provider A session；移动和分组不改变关系。

### P5：Agent

从普通结果启动允许的 Agent Run，沿用项目与线程；计划、审批、事件和用户可见 artifact 正确投影。在 approval/running/feedback 阶段重启均恢复同一 Run；接受后入库且不重复调用或扣费。

### P6：历史迁移

对真实库新副本 preview 并执行：同项目历史成为一块画板内多线程，无项目历史进入明确的未归档项目；每个旧来源可定位，图片/prompt 不丢；二次执行全 skipped。

### P7：删除与审计

移除结果节点不删中央资产和时间线；线程可归档恢复；有运行任务时项目删除被阻止，终态后删除只移除项目画板和 links；中央资产、账单和低层审计仍在；物理删资产后显示 tombstone。

---

## 9. 测试、风险与止损

| 层级 | 必测内容 |
|---|---|
| 纯函数 | 坐标/zoom、吸附、建组、线程聚焦、历史区域布局、分支位置、edge 校验 |
| SQLite | fresh v20/开发兼容、1:1 canvas、thread CRUD、FK/trigger、delete/tombstone、幂等 link |
| Rust command | provisional materialize、成员 + node 原子写、运行中删除阻止、backfill/recovery |
| 前端 store | active project、focused thread、多 job、未读、flush、错误 prompt 保留 |
| 普通生成 | 首轮、续轮、重试、精确重放、跨 provider、后台完成与恢复 |
| Agent | create/checkpoint/link、审批、artifact、accept、TTL、FeaturePolicy 与故障恢复 |
| 兼容/性能 | v20 历史、旧 payload、300/1000 节点、长时间线、Windows 升级 |

| 风险 | 预防/止损 |
|---|---|
| 项目、线程、provider session 混淆 | 三层独立 ID；跨 provider/Agent fixture 为硬门槛 |
| 多线程互相污染 | 执行节点与 edge 强制 thread；自由素材只经明确 input edge 使用 |
| 巨型画板卡顿 | dry-run、300/1000 节点基线、viewport culling、未归档历史超门槛分片 |
| 历史节点重叠 | 按来源 bounding box 稳定偏移，保留内部相对坐标 |
| 错误合并历史 | 只用稳定 parent/correlation，不用 prompt 相似度 |
| 项目删除误删资产/审计 | 中央资产与低层执行独立；事务测试和运行中阻止 |
| create/link 崩溃重复 Run | checkpoint 后补 link，禁止因 link 缺失重发 create |
| 画板/时间线双写 | 同一 repository 投影，时间线不存第二份事实 |

止损条件：

- fixture 无法表达项目内普通/Agent 多线程时，不进入 UI 改造。
- 历史合并无法幂等、对账或稳定布局时，不运行正式 backfill。
- 出现 provider/Agent 重复调用、扣费或错误 resume 时，保持 legacy 并停止发布。
- 未归档历史超过性能门槛且分片规则未通过 preview 时，不写正式库。
- 项目删除不能证明资产与低层审计保留时，不开放删除入口。

真实 provider 测试继续沿用现有授权和事后透明报告，必须记录调用次数、token/图片、credits、provider cost 与失败/unknown；UI 重放、补链和迁移不得产生调用。

---

## 10. 执行顺序与交付

```text
PB0 契约 / migration 决策
  ↓
PB1 Project Canvas 数据层
  ↓
PB2 commands / store
  ↓
PB3 项目即画板 UI
  ↓
PB4 多线程 generation / Agent / timeline
  ↓
PB5 历史合并 backfill v2
  ↓
PB6 性能、恢复与人工验收
  ↓
PB7 正式迁移与 legacy 收口
```

首版交付包括：一项目一画板、多线程与执行 links、项目直达画板、provisional 创建、可调素材栏与素材组交互、线程聚焦与两种时间线、普通/Agent 全链路、历史合并与对账、删除/恢复/性能/Windows 验收、legacy 回退与退出路径。

---

## 11. 文档维护规则

1. 本文是“项目即画板”专项当前执行权威；`CANVAS-SESSION-PLAN.md` v0.8 只作为旧实现证据。
2. 项目定位、当前进展、关键约定和踩坑仍只写 `PROJECT.md`。
3. 每完成一个 PB 阶段，更新本文任务状态、准确测试基线和剩余门槛。
4. 涉及 provider、Agent、计费或云端边界时，同时核对 `AI-PROVIDERS.md`、`AGENT-RUNTIME-PLAN.md`、`UNIFIED-AGENT-HARNESS-PLAN.md` 与收费化文档。
5. 只有用户说“存档”时才按仓库规则执行 git commit；单纯更新计划不自动提交。

---

## 12. 2026-09-04 审计纠偏与收敛计划（当前执行顺序）

本节覆盖前文中与它冲突的发布顺序、历史迁移和完成状态。前文 PB0–PB7 保留为设计演进与已实现代码的证据；从本节开始，以 PCU0–PCU6 的验收结果判断功能是否完成。

### 12.1 本轮边界

必须保留：

- 中央资产、物理文件及其分类、标签、收藏夹等 metadata。
- 项目记录、项目素材关系，以及独立保存的视觉规范和已冻结的生成引用。
- 普通生成、Cloud Agent、计费、额度和 provider 调用所需的底层审计记录。
- 新架构下能够证明项目、线程、节点和执行归属的稳定 ID。

本轮明确不再保留或迁移：

- 旧 `creative_session` 的用户侧列表、独立页面、标题和导航位置。
- 把旧 conversation/Run 逐条回填成新画板节点的 backfill v2。
- 为兼容旧会话而维持的第二套 active state、全局创作入口和 `project_id=NULL` 正式画板。

删除旧表或旧派生记录仍是最后阶段的 schema 清理，不在前置修复中执行；这避免把“无需迁移旧会话”错误扩大为删除资产、项目或审计事实。

### 12.2 目标信息架构与 UI

```text
应用
├─ 素材库（顶层）
│  ├─ 全部素材 / 文件夹 / 分类 / 标签 / 收藏夹
│  └─ 新建项目 → 立即进入 provisional 项目工作区
├─ 项目工作区（顶层，唯一 projectId）
│  ├─ 顶栏：返回、项目标题、画板/时间线切换、项目操作
│  ├─ 左栏：项目素材 / 中央素材切换、筛选、拖入画板
│  ├─ 中区：无限画板 或 项目时间线
│  ├─ 右侧检查器：节点详情、生成详情、Agent 详情
│  └─ 单一创作器：新线程 / 继续当前结果
└─ 任务中心（全局临时层，不是顶层页面）
   ├─ 只显示运行中、等待审批、失败待处理的任务
   └─ 点击任务 → 跳到所属 projectId/threadId/nodeId 并打开检查器
```

UI 规则：

1. 侧栏一级入口只允许素材库和项目；不再列普通 generation session 或 Agent session。
2. 顶层内容只能处于 `library` 或 `project(projectId)`，不存在独立的 canvas mode、session page 或全局 generation page。
3. 画板与时间线共享同一项目上下文。切换视图不改变项目、线程选择或检查器定位。
4. 左侧素材源默认“项目素材”，可切到“中央素材”；拖入只新增画板引用，不改变中央库归档。
5. 线程聚焦时，画板中其他线程仍可见但弱化；时间线默认显示当前线程，并提供“项目全部活动”。
6. 普通生成和 Agent 共用一个右侧检查器外壳；结果、输入、活动、成本为共享信息，审批和计划为 Agent 专属信息。
7. 一个项目工作区只挂载一个创作器。空白发起创建线程；从节点继续时必须携带完整节点定位。
8. 检查器与创作器使用停靠/覆盖层，不改变画板真实中心，也不制造第二套页面返回栈。
9. 任务中心的终态成功任务自动退出全局列表；其结果永久归入项目时间线。失败或等待用户处理的任务保留到处理完毕。
10. 退出项目必须原子清空项目内临时 UI 状态并回到素材库；provisional 项目按既有“无修改不落库”规则处理。

### 12.3 前端状态模型

目标不是继续给布尔变量打补丁，而是让非法组合无法表达：

```ts
type WorkspaceRoute =
  | { kind: "library" }
  | { kind: "project"; projectId: string };

type ProjectView = "canvas" | "timeline";

type ProjectInspector =
  | { kind: "asset"; projectId: string; nodeId: string }
  | {
      kind: "generation" | "agent";
      projectId: string;
      threadId: string;
      nodeId: string;
      executionId: string;
    }
  | null;

type ComposerContext = {
  projectId: string;
  threadId?: string;
  parentNodeId?: string;
};
```

收敛规则：

- `WorkspaceRoute` 是页面渲染的唯一权威。过渡期可由 `activeProjectId` 推导，但不得再同时维护 `canvasMode`。
- `ProjectView`、`ProjectInspector` 与 `ComposerContext` 只在 route 为当前项目时有效；项目变化时统一清理。
- `assetId` 仅表示内容身份，不能表示画板实例。选择、继续、重试和详情定位一律使用 `nodeId`，并校验 `projectId/threadId`。
- `activeJobId` 或 `runId` 只能定位执行，不得单独决定页面；所有任务跳转先解析完整 owner locator。
- 普通生成与 Agent 不再各自注册全局打开/关闭事件；由项目工作区持有唯一检查器和创作器状态。

### 12.4 后端边界与数据不变量

```text
UI command
  → Project workspace service（校验 owner locator）
    → 单事务写入 canonical 表
      → project / canvas / thread / node / edge / execution link
    → task worker 只更新 execution 状态与结果
  → 单读事务组装 ProjectCanvasSnapshot
```

必须建立以下不变量：

1. `thread.project_id` 必须等于其 canvas 所属项目；node、edge、execution link 不得跨项目悬挂。
2. job/run 一旦绑定项目和线程，普通 upsert 不得悄悄改绑；如需迁移，必须走显式命令和审计。
3. `task_queue.status` 是队列运行状态唯一权威；payload 保存请求和 provider 结果，不得用旧 payload status 覆盖 failed/cancelled/done。
4. 投影重放是幂等补全，不是用户状态重置；不得清空 `hidden_at`、视口、分组或手工布局。
5. layout mutation 只更新布局列，不覆盖包含执行状态的完整 `payload_json`；执行 mutation 同理。
6. Agent 引用节点必须有稳定 execution owner；有执行历史的节点只能隐藏/归档，不能物理删除并级联断边。
7. snapshot 的项目、节点、边、线程、link 与 timeline 必须来自同一 SQLite 读事务。
8. provider session 首次返回后必须写回任务或 execution link，保证重启后的继续操作仍能恢复。
9. 所有继续操作使用 `projectId + threadId + nodeId` 查找上下文；`assetId + LIMIT 1` 不再参与归属决策。
10. schema 约束、service 校验与测试 fixture 至少有两层共同保护这些不变量。

### 12.5 分阶段任务卡

#### PCU0 — 契约冻结与基线

- [x] PCU0-T1：完成前端、后端、测试和文档四路冲突审计。
- [x] PCU0-T2：冻结本节的信息架构、状态模型、数据边界和不保留旧会话决定。
- [x] PCU0-T3：记录改动前基线：canvas 纯函数测试 26/26，TypeScript 编译通过；本轮收敛后为项目画板/路由/任务/runtime 契约 86/86、其余桌面前端契约 23/23、Rust 262 passed + 2 ignored，production build 通过。
- [ ] PCU0-T4：为每个 P0 冲突建立能先失败、修复后通过的回归测试。（owner、恢复、layout、路由 epoch、一次性 launch、FIFO 写日志、runtime 入库与 inspector 定域已有回归；仍缺真实 DOM + Tauri IPC 的整链路故障注入。）

验收：团队只引用一套顶层路由和对象职责；旧 PB 勾选不再被当成发布证据。

#### PCU1 — 唯一工作区路由

- [x] PCU1-T1：删除 `App` 本地 `canvasMode`，由唯一 route/`activeProjectId` 推导素材库或项目工作区。
- [x] PCU1-T2：统一侧栏、项目标题、返回按钮、项目删除后的退出行为。
- [x] PCU1-T3：provisional 项目创建后可立即进入；悬空项目 ID 必须安全回库而非渲染伪画板。
- [x] PCU1-T4：增加 enter/exit/delete/provisional/reload 路由测试。

验收：任何入口和退出顺序都不能产生 `projectId=null` 的项目画板，也不能让侧栏与主区显示两个不同项目。

#### PCU2 — 项目内检查器、任务中心与单一创作器

- [x] PCU2-T1：将普通生成与 Agent 详情统一到项目内检查器外壳。
- [x] PCU2-T2：任务中心只保留 active/attention 项，并用完整 owner locator 导航。
- [x] PCU2-T3：移除 SidebarStatus 的会话式历史导航和跨项目悬浮详情。
- [x] PCU2-T4：只在项目工作区挂载一个 composer，合并重复全局事件监听。
- [x] PCU2-T5：重启恢复更新项目投影，不自动劫持当前页面；仅待审批任务可给出非侵入提示。
- [x] PCU2-T6：复用生成提示词改为 project-scoped、带 request identity 的显式 composer load；项目内复用关闭检查器后交还同项目创作器，素材库复用先创建 provisional 项目，只有编辑器实际载入后才确认成功。
- [x] PCU2-T7：生成/Agent 详情改为画板右侧非模态检查器，不再给画板兄弟节点设置 `inert` 或使用模态焦点陷阱；普通查看时画板与时间线让出检查器宽度，进入生成编辑坞时才切换为透明全画板 overlay。

验收：一个动作只打开一个详情面板、一个创作器；跨项目任务点击总是先进入正确项目，再定位线程和节点。

#### PCU3 — 身份、恢复与并发一致性

- [x] PCU3-T1：投影重放保留 `hidden_at` 与其他用户编辑状态。
- [x] PCU3-T2：以 task queue 列状态修复投影，覆盖 failed/cancelled/done 重启场景。
- [x] PCU3-T3：snapshot 改为单读事务；拆开 layout 与 execution 的 payload mutation。
- [x] PCU3-T4：Agent reference 建立 execution owner，删除改为 hide/archive。
- [x] PCU3-T5：continuation 改用完整 node locator，移除 `assetId + LIMIT 1`。
- [x] PCU3-T6：禁止 job/run 通过通用 upsert 改绑项目或线程。
- [x] PCU3-T7：首次 provider session ID 持久化并通过重启恢复测试。
- [x] PCU3-T8：画板按 snapshot 中的精确 asset id 集合补水，不受瀑布流 500 条上限、组图折叠或当前筛选影响；过期补水响应不得覆盖新 snapshot。
- [x] PCU3-T9：启动恢复列表与实时事件按稳定 ID 合并；Cloud Run 以 `updatedAt` 较新者胜，generation 占位按字段补齐且不回退实时 turns/status。
- [x] PCU3-T10：继续/重试选择唯一父节点；普通与 Agent 提交冻结 project/thread/node、provider、视觉设定和 continuation token，跨组件重挂仍只有一个 project-scoped submission claim。
- [x] PCU3-T11：Agent 接受结果只有在全部 artifact receipt、画板投影与整组 fingerprint checkpoint 持久化后才退出待处理；启动恢复可补齐 receipt 已提交而 checkpoint 未写的崩溃窗口。

验收：并发更新不丢字段；隐藏节点不复活；终态任务不复活；同一资产多次放置也总能继续正确分支。

#### PCU4 — 项目 UI 完整化

- [x] PCU4-T1：左栏加入“项目素材 / 中央素材”切换与明确拖放反馈。
- [x] PCU4-T2：实现线程聚焦的其他线程弱化、项目全活动切换和稳定选择恢复。
- [x] PCU4-T3：统一普通/Agent 节点打开行为、loading/error/empty 状态与键盘关闭规则。
- [ ] PCU4-T4：验证检查器和 composer 对画板中心、缩放、选择与快捷键无冲突。（挂载互斥、非模态右栏、Escape 优先级和路由 loading gate 已落地；真实画板中心/缩放仍待 Windows 视觉验收。）
- [ ] PCU4-T5：补齐键盘、可访问名称、焦点回退和窄窗口布局。（检查器使用 complementary 语义并保留关闭后的焦点回退，节点为原生按钮；窄窗口与完整键盘漫游待人工验收。）
- [x] PCU4-T6：画板素材栏以三档缩略图尺寸滑块替代冗余拖放提示；尺寸偏好全局持久化，只调整素材瀑布流列密度，不影响画板节点尺寸或画板缩放。
- [x] PCU4-T7：画板素材左键行为与创作模式统一：模式激活/生成编辑坞中点击加入编辑器，浏览模式点击打开原图预览；项目 composer 不再空项目自动聚焦且提供显式退出创作模式入口。浏览模式按住空白并拖动即按系统框选阈值进入选区，支持缩放坐标、反向框选、Shift 追加与选中反馈。
- [x] PCU4-T8：强化画板创作模式的全局状态提示：画板整体显示品牌蓝边框与顶部居中“创作模式”刘海，底部自由创作/会话编辑对话框保持激活蓝边框；退出创作模式后整套视觉提示同步撤销。
- [x] PCU4-T9：框选集合升级为真实多选：拖动或键盘移动任一已选节点时按同一位移量保持相对布局，且多选拖动不触发悬停建组；画板素材右键复用全局素材菜单，并在画板上下文中提供“移除所选”；工具栏、节点移除按钮及 Delete/Backspace 同样支持批量移出画板，不物理删除中央素材。

验收：用户无需理解 session/job/run 就能完成新建线程、继续、重试、查看过程和回到结果。

#### PCU5 — Legacy 与 schema 收口

- [ ] PCU5-T1：关闭并删除旧用户侧 session 路由、active state、命令与不可达组件。
- [ ] PCU5-T2：删除 history backfill 的发布入口；保留底层执行/计费审计读取能力。
- [ ] PCU5-T3：在全新 profile 和升级副本上验证后，编写最小 schema migration 清理仅属派生 UI 的 legacy 数据。
- [ ] PCU5-T4：删除旧项目删除策略实现，只保留“删项目不删中央资产/审计”的一条路径。
- [ ] PCU5-T5：清理冲突文档、feature flag 和只保护旧契约的测试。

验收：代码中不再存在能重新打开旧会话页面的路径；升级不依赖历史 backfill，且资产、项目、文件、计费和执行审计对账不减少。

#### PCU6 — 发布验证

- [x] PCU6-T1：现有前端 unit、Rust unit/integration、TypeScript 与 production build 全绿；真实 DOM + Tauri IPC 故障注入仍归 PCU0-T4。
- [ ] PCU6-T2：Windows 真机逐项走完 12.6 验收剧本并保存证据。
- [ ] PCU6-T3：对复制库做升级 dry-run 与资产/项目/审计数量对账；不做旧会话节点对账。
- [x] PCU6-T4：300/1000 节点画板、1000 节点时间线预算，以及并发字段隔离/任务重启恢复自动回归通过。
- [ ] PCU6-T5：经用户确认后再执行正式发布与 legacy schema 清理。

### 12.5.1 2026-09-04 实现检查点

本轮已把架构从“多个组件各自维护会话与异步状态”收敛为以下边界：

1. 项目路由由串行 controller 管理 `activeProjectId + routeRevision + pending`；进入、退出、删除和缺失修复共用一条队列，后端 active scope 成功后才提交前端 route，异步生成/导入完成前后都复核 project 与 revision。
2. 项目写入采用“工作区同步 `inert`/失焦 → 编辑器同步 flush → 严格 FIFO write journal → 视口 flush”的离开屏障；首项失败会阻止后续项越过，也阻止项目切换。后台快照只在 journal 完全成功后才能替换本地投影。
3. 初始素材 launch 与任务 locator 都是绑定 `projectId` 的一次性命令，按 request identity 条件 ack；`threadId` 即使暂时没有 node 也会在 snapshot 恢复后覆盖旧视图焦点，node locator 则等待精确投影且拒绝跨线程命中。手动 route 会清理旧检查器，较新的任务 locator 不会被排队中的旧 route 覆盖，未归属旧任务只在安全退出到素材库后打开。持久项目 snapshot 读取失败进入不可编辑的重试页，绝不降级为空白 provisional 画板。
4. 普通生成和 Agent 共用严格按 `projectId + threadId` 定域的项目检查器；任务中心只保留 active/attention，始终打开当前行最新执行并只用最新 turn 的 node locator；composer 与检查器互斥挂载。Agent 提交与普通生成一致留在画板，只有用户显式查看或需处理状态才进入检查器。
5. Cloud Agent 轮询、local task、整组产物入库与终态 reconcile 由常驻 runtime coordinator 持有，关闭详情或切换项目不会中断；同一 Run 的前端命令共用串行 lane，后端记录使用 CAS + 单调 merge，终态、`final_asset_id` 与 `downloaded_at` 不可被慢响应回退。入库只有在本地资产、整组 `artifact_received`、画板投影与匹配当前 artifact fingerprint 的 durable checkpoint 都持久化后才成功；重启列表会修复 receipt 后、checkpoint 前的崩溃窗口，并保持失败可退避/手动重试。
6. 后端 snapshot 使用单读事务；layout DTO 不可覆盖 execution payload；generation/Agent owner 不可改绑；继续操作校验精确父节点；投影恢复服从队列表状态并保留隐藏状态和 provider conversation。
7. 项目删除在同一 SQLite 事务内 fail-closed 检查 generation 与 Agent 未完成工作；未知 Agent 状态、等待本机/反馈/取消，以及已接受但尚未完成本地入库的成功 Run 都阻止删除，终态审计和中央资产继续保留。
8. 画板素材不再借用当前瀑布流列表：snapshot 中全部 asset id 通过精确查询补水，同一资产多节点不折叠，超过 500 条也不丢；snapshot、素材补水和后台刷新各自带 epoch，旧响应不能覆盖新项目或新图。
9. App/store 中项目级 assets、caption、prompted assets、auto tags、palette 与生成历史读取都冻结 `projectId + routeRevision + latest request`；A 的迟到响应不能写入 B。启动恢复同样 merge 当前内存：新 Run 不会被旧列表删掉，`recover_started` 稀疏 generation 占位会补齐 session/references/ratio 等持久字段而不回退实时状态。
10. 提交边界冻结 prompt/refs/ratio/provider/视觉设定与精确父节点；同项目 submission claim 位于 React 组件之外，检查器导致 composer 卸载/重挂也无法重复创建 job/Run 或重复消费 continuation。会话编辑坞的 revise 以显式 job id 寻址，异步 Agent compile 不能写进后来打开的会话。
11. “复用生成提示词”不再向可能尚未挂载的编辑器广播一次性 window 事件：store 冻结 prompt、参考图、维度源图和目标项目，App 完成项目路由，目标 composer 按 request id 一次性载入并确认。中心素材的生成来源读取不按当前 `project_assets` 过滤，避免迁移/恢复节点被误判为“无可复用记录”。
12. 画板边使用“规范执行图 + 当前 UI 布局”的即时投影：素材拖拽和键盘移动的每帧都直接更新边端点，组内素材边锚定到素材组；生成/Agent 详情停靠到右侧非模态检查器，画板按钮不再因旧全屏 dialog 的 `inert` 处理失效。
13. 画板素材栏右上角使用带减号/加号语义的三档缩略图滑块，按“小图三列 / 中图两列 / 大图一列”映射 Masonry 密度，并通过本地 UI 偏好跨项目记忆。
14. 项目画板复用素材库的创作模式边界：编辑器 focus 才激活，显式退出后恢复浏览；浏览态素材点击打开 Lightbox，创作态点击投递 `BOARD_ASSET_PICK_EVENT`。浏览态在空白处按下并越过系统式拖动阈值后立即进入框选，不再等待定时器或切换十字光标；框选命中在画板坐标中计算，不受 pan/zoom 与拖动方向影响。创作态同时显示画板蓝色边框、顶部刘海和对话框蓝色激活边框。

当前验证：项目画板/路由/任务/runtime 86/86，其余桌面前端 23/23，Rust 262 passed + 2 ignored，`cargo fmt --check`、`cargo check --lib`、TypeScript、production build 与 `git diff --check` 通过。全程未写正式素材库、未调用 provider、未部署、未执行 legacy schema 清理。下一阶段只按 PCU0-T4、PCU4-T4/T5、PCU5 与 PCU6-T2/T3/T5 继续，不回头恢复旧用户会话。

### 12.6 自动化与人工验收清单

1. 从素材库新建空白 provisional 项目，立即看到该项目画板；不编辑退出后不产生项目记录。
2. 从任意项目通过侧栏、顶栏返回、删除项目或重载后退出，主区都稳定回到素材库，不出现空 ID 画板。
3. 同一资产在一个或多个线程放置两次，从第二个节点继续时只沿第二个节点所属线程创建分支。
4. 普通生成与 Agent 各启动一次，任意时刻 DOM 中只有一个 composer 和一个项目检查器外壳。
5. 当前位于项目 A 时点击项目 B 的活动任务，应用先进入 B，再聚焦正确 thread/node；关闭详情仍留在 B。
6. 应用重启时，后台 running 任务继续恢复，但不强制离开用户当前素材库或项目；等待审批只显示提示。
7. 将任务置为 failed/cancelled 后重启，项目节点和时间线保持终态，不重新显示 running。
8. 隐藏普通生成或 Agent 节点后触发投影重放，节点仍隐藏，边和审计 link 仍存在。
9. 并发更新节点位置与 execution 进度，两类字段都保留；snapshot 内不存在边引用本次快照未包含节点的撕裂状态。
10. 左栏从项目素材切到中央素材并拖入节点，中央资产的文件夹、标签和物理文件均不变。
11. 聚焦线程 A 后，B/C 节点弱化但可见；切换“项目全部活动”后时间线恢复所有线程且空间坐标不变。
12. 删除项目仅删除项目 UI/workspace 派生数据；中央资产、物理文件、额度流水、provider 调用和 Agent 审计对账不减少。
13. 在项目检查器点“复用”应回到同一项目并聚焦已填充的创作框；在素材库生成图右键复用应进入新的 provisional 项目并填充同一 prompt/参考图，不能只显示成功 toast，也不能因项目素材 membership 缺失显示“无可复用记录”。
14. 拖动任一带执行边的素材或素材组时，边端点逐帧跟随当前卡片，未释放指针且未刷新 snapshot 时也不得停留在旧坐标；键盘移动后同样立即更新。
15. 点击生成指令卡只在画板右侧打开详情；画板、顶栏和时间线仍可点击且不发生内容重叠，关闭后焦点回到原节点。只有点击“继续对话/重新编辑”进入编辑坞时才允许使用全画板透明 overlay。
16. 调整画板素材栏右上角滑块时，缩略图按三档即时切换大小；切换项目或重启后仍保留选择，画板节点尺寸与缩放值保持不变。
17. 新开空项目时默认处于浏览模式：点击单素材打开原图，点击素材组在画板原位置展开全部成员；聚焦创作框后，素材组仍只展开，单素材按当前单图约定加入创作框或打开维度环，退出创作模式后单图立即恢复预览行为。浏览模式在空白处按下并向任意方向拖动可立即框选多个素材，Shift 拖动框选可追加，普通空白点击清空框选；全程保持系统默认箭头光标，创作模式下不得误触框选。进入创作模式后画板蓝框、顶部刘海和编辑框蓝边应同步出现，退出后同步消失。
18. 框选多个节点后拖动其中任一节点，所有已选节点保持原相对位置同步移动并逐项持久化；多选移动不能触发建组。右键已选素材应保留选区并打开与素材库一致的菜单，菜单顶部可一次移出全部选中节点；Delete/Backspace、工具栏“移除”和任一已选节点的移除按钮结果一致，均只修改画板，不删除中央素材。
