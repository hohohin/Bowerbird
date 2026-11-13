# 对话 provider 实现记录

## 2026-11-13 Agent 建卡与运行（Cloud 已部署，桌面待发包）

`create_canvas_cards` 可用 `triggerMode`、`dailyAt`、`runAt` 和 `count` 配置本批触发卡。`runCard` 指定本批一张生成、H3、循环或手动触发卡，由桌面项目控制器启动。回执区分建卡与启动结果；取回中断的云端会话只读取已保存的结果。桌面与 VPS 使用同一工具定义，聊天网关允许最小回执携带 `run_status`。

## 2026-11-13 云端对话统一为 DSH · Cloud

卡片、创作框和详情共用三个选项：本机 Codex、本机 DSH、DSH · Cloud。旧草稿、工作流和模板中的 `deepseek-cloud` 在读取时按 `dsh-cloud` 处理。SQLite 0059 原位更新会话 provider，保留会话编号、记录与建卡回执。旧任务仍按原请求身份取回，旧消息可在详情查阅；首次使用 VPS 的轮次是新云端上下文的起点。

11:36（北京时间）正式聊天网关切换为只接受 DSH v2 新请求。旧版直连和 DSH v1 新请求返回 HTTP 426 提示更新，登录账号已受理的原单仍可取回。独立 Agent Run 的新建入口此前已强制统一 Agent 与 DSH，旧执行器仅用于旧任务。[服务端发布与验证](../apps/cloud/CHAT.md)

Windows x64 本地测试安装包 26.11.1301 位于 `Windows/dist/DSH-Cloud-26.11.1301-test/`，不在官网更新渠道。已验证 NSIS 包完整性、包内主程序与构建产物哈希一致。安装包 SHA-256 为 `FE364E4682AF4EBFE9AF13EFC09EA816299325B06813D9732A43E9B73D0FB56C`。13 项 Rust 专项、54 项桌面状态/工作流回归、两组 Chromium 界面及完整 TypeScript/Vite 构建通过。Mac 安装包未构建。

## 2026-11-13 DSH · Cloud v2 桌面会话

v2 桌面每轮仅提交一条用户消息，附当轮显式选择的素材别名。手动续聊和直接运行 Agent 单卡复用 `c-<SQLite 会话 ID>`，工作流及循环使用 `t-<本轮 ID>` 独立执行。桌面保留公开历史以供查看，不再将本地历史、旧建卡摘要或素材路径拼入请求。原卡「新对话」及切换服务后，已使用会话的历史身份保存在项目历史，新对话使用新的云端身份。

旧会话首次进入 v2 手动对话时，详情在对应消息前标出云端历史的起点。此前的文字保存在本机，没有自动回填；后续续聊沿该云端会话进行。新建会话无迁移提示。发送检查 `dsh_vps_v2_available`，技能沿用 `dsh_vps_skills_available`。旧 v1 原单仍按既有 job 或幂等键取回、取消与重送已有建卡回执。

Cloud 校验账号归属并串行处理同一会话。Worker 通过 DSH 的原生会话记录恢复上次成功的轮次，历史选取与压缩交给 harness。停止、断线取回或重复提交都沿用原任务身份。与本次发布及验证有关的记录见[云端会话发布记录](../project_logs/2026-11-13-dsh-native-session.md)。

## 2026-11-12：DSH · Cloud 整轮移至 VPS（候选，未部署）

新版桌面把普通对话、手动续聊和选定技能都交给 VPS 上的 DSH。卡片内「新对话」不会跳出应用；首次发送从空历史开始。手动续聊按完整轮次选取公开历史，流程驱动的 Agent 只发本轮输入。Cloud 能力随账号报价在应用启动时读取，并在实际提交时复核；用户不需要在本机安装 DSH 或 Node。旧客户端仍使用原协议，本机 DSH 继续使用用户自己的服务。

桌面、工作流模板和建卡工具只接触用户提供的文字、素材别名、公开技能 ID 与参数，以及最终答复或需要写入画板的建卡内容。文本编辑与 H3 视频提示词由 VPS 根据账号权限加载；技能正文和内部执行步骤不随桌面分发，选用私有技能的轮次不开放建卡工具。用户自己编辑的画板和导出的模板仍然可读；需要保密的步骤应维护在 Worker 的技能中。

普通对话需要建卡时，桌面按原调用 ID 在 SQLite 事务中执行并回传数量。只点「取回回复」不会补建卡；已有事务可重送原回执。停止向云端取消原任务；上游已受理且结果不明时不重发。发布顺序、功能开关、记账与回退见 [Cloud 对话](../apps/cloud/CHAT.md)。

隔离验收、冻结范围与部署状态见[候选记录](../project_logs/2026-11-12-dsh-vps-chat.md)。桌面前端构建后可执行 `node scripts/check-cloud-chat-skill-bundle.mjs <产物目录>` 核验私有技能正文没有进入分发文件。

2026-11-11 桌面源码支持在「对话」创作框激活时双击视频。视频和图片按用户选择顺序保存到同一轮，最多八个素材。Codex 的图片输入接收已验证的图片，视频按本地素材引用提供给建卡和 HyperFrames 制作工具。Cloud 和 DSH 沿用文字及建卡别名。对话历史可播放视频附件。行为覆盖在 `scripts/composer-video-reference-ui.test.mjs` 和 `local_chat_attachment_validation_preserves_mixed_media_and_image_input_order`。

## 2026-11-12：本机 DSH 适配 DSH 0.2（源码待发布）

DSH 0.2.2-rc.1 换了本机 HTTP 契约，原桥会把"服务没起"和"契约不匹配"都落到同一句提示。本轮把 `dsh-local` 改成两代并存：

- **探活**：先调 `POST /api/agentPresets/list`（0.2 路由，`payload:{args:{}}`），返回 `presets` 即 0.2；否则退回 0.1 的 `agentPreset.list`（要求 `authorable`）。
- **0.2 会话**：`session/create`、`session/prompt`（`{sessionId,mode:"queue",requestId,content}`）、`session/events`（`{address:{kind:"session",sessionId},maxMessages,throughSeq?}`，返回 `records/cursor/hasMore`）与 `session/cancel`。回复折叠沿用 `turn/start`、`assistant/chunk|message`、`turn/end`，并按 0.2 的 `agent/inbox/spliced` 关联请求身份。
- **preset 安装**：0.2 注册表不扫描目录、也不接受 preset 路径（实测目录 preset 被 `session/create` 回 `agent-preset/not-found`）。连接时把 `bowerbird-chat` preset 作为 profile 补丁写进 `$DSH_HOME/profiles/*/cordis.patch.yml`（带起止标记，可重复执行），工具模块按内容哈希命名并与补丁同目录，按 `./bowerbird-chat-<hash>.mjs` 相对路径引用。`web` profile 即时重载；桌面 profile 无 HMR，重启 DSH 后生效。
- **每轮握手**：preset 常驻，不再每轮生成目录。每轮以会话 ID 为键把 `{endpoint,token}` 写入 `$DSH_HOME/.bowerbird/current.json`（0600），工具执行时按 `exec.agent.id` 取连接，结束后删除；未安装 preset 时用默认 preset 纯文本降级，不静默扩大或缩窄既有工具面。
- **提示**：状态新增 `localNote`，安装需要重启或安装失败时在 DSH 设置里说明，连接本身仍成功。

验证：`cargo check --tests` 通过（仓库内 `tests/pinterest_native_fixture.rs` 的既有失败与本次无关），前端 `tsc --noEmit` 通过。用独立 `DSH_HOME` 启动同版本 `dsh web`（0.2.2-rc.1）核对登录流程、`agentPresets/list`、`session/create|prompt|events|cancel`、补丁热加载与工具模块加载（`ctx.tools.register` 与 `agent/created` 均通过，仅 `presentAs` 已移除）。**未验收**：Rust 用例未能在本机执行（测试二进制启动即 `0xC0000139`，改动前的旧二进制同样失败）、真实模型回合的工具调用、桌面 profile 重启后的实际生效、Windows 正式包。

2026-11-12 实机（`dsh web`）：连接并完成一轮生成。落盘证据：`web` 与 `desktop` 两个 profile 的 `cordis.patch.yml` 均带托管标记，`web` profile 生成 `bowerbird-chat-7209f80d0d2d.mjs`，`$DSH_HOME/.bowerbird/current.json` 在轮次结束后只剩空对象，DSH 侧存在 `session-bowerbird-chat-98653c47…` 会话。会话日志显示 `tools:[{"name":"create_canvas_cards",…}]` 已随请求下发，模型按"仅显式要求才建卡"的指令判断该轮是写提示词、未调用工具——属预期行为，不是桥故障。**仍待验收**：一次显式建卡请求下的 `tool/start`／`tool/result` 与画板落卡。

2026-11-12 失败原因可读化：0.2 的 `turn/end` 可能以 `kind:"error"` 结束。实测循环运行中模型流式输出的卡片工具参数不是合法 JSON，DSH 返回 `MALFORMED_RESPONSE`／`tool input is invalid JSON`；桥原先把它兜成"请检查模型配置"，现改为"本机 DSH 本轮失败：模型返回的卡片工具参数不是合法 JSON（码）；可直接重跑这张卡片"，其他错误码只带 code、不回显上游原文（沿用不泄露主机内部信息的原则）。

定位证据：`dsh-llm-deepseek` 把 `input_json_delta.partial_json` 逐段拼接（`block.json += argumentsDelta`），`content_block_stop` 时整体作为 `arguments`，`message_stop` 再 `JSON.parse`；DSH 不添加任何字符。三例失败（10:17、03:26、03:19）的 `arguments` 全部以 `}}` 结尾，即模型在根对象后多写了一个 `}`，长度分别 1468/3216/2381；同期 9 次工具调用中 3 次坏（约 1/3），与循环项数叠加后几乎必现。属模型侧生成问题，桥与循环调度均不产生该字符。

代码侧规避（2026-11-12）：① 自动 Agent 卡轮次不再由 Bowerbird 回放历史对话（循环逐轮驱动，历史 JSON 会诱导模型续写上一轮工具调用；手动对话仍带历史）；② 建卡工具 schema 去掉 5 分支 `oneOf`，改为单对象 + `kind` 枚举，减少模型需要闭合的嵌套结构；Rust 侧按 kind 丢弃跨类型字段、仍拒绝未知键（`endpoint` 等），`CARD_TOOL_VERSION` 升到 5。不引入自动重试。

2026-11-12 审查补齐：① 本机 preset 升级改为契约同步——连接时比对 profile 补丁里的托管块与当前内容寻址模块，不一致就先移除托管块，靠 `agentPresets/list` 是否消失判断宿主会不会热加载；消失后重写、等它重新出现才判 `Active`，不消失则写回并报待重启；状态里对"已安装但不是当前版本"单独提示。② 自动轮次的 prompt 连 `[近期建卡历史]` 摘要也不带（此前只去掉了历史消息数组）。③ 失败文案去掉 `MALFORMED_RESPONSE` 等下划线码（前端会把含码文本整句替换为兜底）；仅 `tool input is invalid JSON` 说"卡片工具参数不是合法 JSON"，同码其他异常说"模型回复格式异常"；文案改为"重跑前请确认本轮已创建的卡片"，不再承诺干净重跑。④ 宿主明确失败的轮次在流程中按失败终止，不再落到"等待取回原结果"。**未完成**：DSH 解析边界的尾括号规范化必须由 DSH 侧完成——Bowerbird 收到参数时已被拒绝，Rust 无法补救。

循环中的手动重做已在桌面源码实现：对照原请求、会话和轮次核实宿主失败；有已建卡片时先展示，再用同一份输入提交新轮。其余无法确定结果的轮次继续找回原请求。见[循环重试与验收](CANVAS-WORKFLOW.md)。

## 2026-11-13 Agent 卡片运行与切换对话服务（桌面源码待发包）

用户点击卡片右下角「运行」，以现有会话执行指令框的内容。点击卡片打开详情，也可在同一会话续聊。点击对话服务菜单右侧的「新建对话」按钮会开启新对话并显示提示。卡片保留草稿、接线、服务、模型和推理强度，用户点击「运行」后才发送当前指令。自动流程按步骤提交本轮输入。

选择另一项 provider 会在原卡切换到该服务，等待下次运行。已有消息时，`local_chat_new_on_card` 在同一 SQLite 事务中保存旧会话的历史及恢复身份，再把空会话绑定到原卡。当前会话尚未发言时直接复用其 ID。旧对话可在项目历史中读取、取回或独立续聊。卡片或相关流程运行中须等本轮完成或停止后再切换。

## 2026-11-09：Agent 卡片与对话统一（Cloud 已部署，桌面源码待发包）

新 Agent 卡片与创作框对话统一使用 `localChatStore` / `local_chat_send`。首次发送在 SQLite 事务内创建同 nodeId 的 Agent 工作流投影；旧 note 只保留历史外键，画板不重复显示。工作流提交前保存原 requestId，再按 submittedTurnId 交付；停止、续聊、历史恢复与模型控件共用对话实现。旧 ds-inbox／VPS 任务仅恢复，不作为新发送入口。模板 v6 保存模型配置并剥离会话身份。

移除对话链路原有文字字节拦截及按字节丢弃历史的逻辑，避免恢复 Agent 已取消的限制。保留原对话的消息数量、工具闭集、模型参数、媒体约束及计费／身份校验；没有新增图片像素上传或自动生图权限。经用户确认，聊天 Edge v3、VPS Worker、官网网关与 0084 已部署；真实小对话、原请求恢复和大文本完整往返通过。Cloud 现役哈希、部署证据及桌面尚未发包边界见[实施记录](../project_logs/2026-11-09-agent-chat-unification.md)。本文下方日期记录中的两套执行入口和旧文本字节限额仅描述当时状态。

## 2026-11-07：Cloud 对话已上线

DeepSeek · Cloud 与 DSH · Cloud 的共用后端已部署启用，测试 **0 Bcoin**，不要求用户自带 DeepSeek API key。Windows 26.11.601／602 已包含对应桌面入口；当前 602 无须重打包。官网真实用户完成短对话，原请求重放仍只有一任务、一条 confirm(0)，余额不变；非法凭据与图片输入被拒绝。临时 Auth 已清理。仅文本 completion 链路本次做真实验收，桌面 DSH 完整工具轮次与画板建卡未重验。部署、验证和回退见 [Cloud 对话](../apps/cloud/CHAT.md)；下方未部署／未发布是对应开发时点的历史记录。

## 2026-11-06：本机 DSH 与 DSH · Cloud（源码待发布）

- 新增 `dsh-local`／`dsh-cloud`；会话固定 provider，0053 迁移保留原 Codex／DeepSeek Cloud 身份、消息与建卡回执。两条路径共用草稿、对话历史、卡片／时间线及详情面板，Codex 参数仅用于 `codex-local`。
- **本机 DSH** 连接用户已启动的 `dsh web`，使用其登录、默认模型和模型服务配置，不要求在 Bowerbird 重填 DeepSeek API key。设置保存本机服务地址与可选登录链接；只接受 loopback、同源登录链接，凭据不回传前端。未另配时复用既有 Agent DS 的 `BOWERBIRD_DSH_WEB_URL` 与登录文件。
- 每轮建立独立 DSH session 和临时最小 preset，以应用公开历史续聊。复用 DSH host 的模型认证，不读取模型密钥；只开放当前轮次的 `create_canvas_cards`。短期 loopback 工具通道绑定 session／call，复用既有建卡事务、权益与撤销，支持生成、内容、触发、循环、H3 与分区。没有添加自动生成媒体权限或 HyperFrames 工具。
- **2026-11-12：流程驱动的 Agent 卡片轮次不再附带历史 JSON。** 循环卡片逐轮执行 Agent 时，旧实现把此前轮次整体序列化进 prompt；长 JSON 会让上游模型产出非法工具参数（DeepSeek `tool input is invalid JSON`）。现在按轮次记录判断：由流程提交的 Agent 轮次只发送本轮指令与素材别名；用户在 Agent 详情里手动“继续对话”仍按公开历史续聊。其余 DSH 身份、工具闭集、停止与取回契约不变。
- 本机 preset 位于 `DSH_HOME/.agent-presets`（默认用户 `.dsh`）。只新增本轮独立目录；Unix 权限为 0700。正常结束清理本次两份配置文件，保留 DSH 自身会话历史。应用崩溃可能留下失效 preset，工具服务随应用退出失效；不会遍历删除用户 preset。已用实际 DSH 验证删除 preset 后冷读历史不会重新启动模型。
- **DSH · Cloud** 在应用私有目录安装锁定的 DSH `0.1.1-rc.2`，要求 Node.js 24；模型经过现有 `chat-proxy`，平台密钥和账号令牌不传给 Node 子进程。DSH 负责原生 Agent loop，桌面只桥接单次 completion 与卡片事务；未新增 Cloud runner。客户端 system、模型、工具 schema 不能覆盖服务端契约。
- 安装使用随源码冻结的 manifest／lock 和 `npm ci --ignore-scripts --legacy-peer-deps`；固定兼容的 Cordis 依赖。每个桥文件版本使用独立目录，每轮独立临时 DSH_HOME，仅允许受控卡片工具，禁用 shell、用户文件、网页、全局配置、遥测和自动模型重试。自检只初始化 ACP 与会话，不调用模型。
- 托管路径沿现有 `chat_deepseek` 零价报价和预留／结算，测试阶段 **0 Bcoin**，真实上游费用由平台承担；非零报价仍不能静默发送。本机路径不走 Bcoin，外部模型账户费用遵循用户已有配置。两个 DSH 入口本轮均只传文字与建卡图片别名，不上传图片像素。
- 每轮最多 12 次托管 completion；工具调用 ID 和参数须匹配当前模型回复。发送前记录原请求，结果不明不重发。停止关闭工具通道；本机请求 DSH cancel，托管退出本地 DSH 进程树，已被 Cloud 接收的 completion 仍可能完成。显式“取回回复”只读原任务，不重复请求模型或执行工具，旧轮结果不能覆盖新轮。

验证：77 项原生对话回归通过、3 项外部运行时探针默认忽略；另显式通过 Rust 内嵌桥的实际 DSH 自检。62 项前端行为、DSH 界面专项、实际托管 DSH 的 8 项协议／生命周期测试、本机实际 DSH + 模拟模型的工具隔离／冷恢复验证通过。完整 TypeScript 与独立 Vite 构建通过。CUA 合成页面确认入口、连接、换行、详情和回复终态，截图 `.tmp/dsh-chat/dsh-chat-ui.png`。完整旧 chat UI 用例受工作区既有投影 canvas 遮挡影响，未宣称通过；未修改该投影逻辑。详见[行动记录](../project_logs/2026-11-06-dsh-chat.md)。

没有调用真实模型、读取用户模型密钥、迁移用户库、部署 Cloud 或发布安装包。Cloud 仍须按 [CHAT.md](../apps/cloud/CHAT.md) 配套部署和启用；本轮只完成源码接入。macOS 原生安装／进程清理与真实账户联调尚待验收。

## 2026-11-06：Codex 模型与推理强度（源码待发布）

- 新对话及详情续聊共用 `CodexModelSelect`，菜单复用 `TacticalSelect`；CLI `model/list` 返回型号、默认值和支持的推理强度，不硬编码可用型号。目录读取失败可重试，旧默认发送不依赖目录成功。
- `ChatSendInput.codexOptions` 进入原有请求身份；`local_chat_turns.request_json` 另外保存继承后的参数快照，恢复及重放不会受后续选择影响，无需 SQL 迁移。省略参数继承已有选择，显式 `{}` 解析当前目录默认型号／强度并覆盖前轮值。
- `thread/start`／`thread/resume` 传 `model` 和线程推理配置，`turn/start` 明确传 `model`／`effort`。所选组合在发送模型前按目录验证；Cloud 拒绝这些参数，工具权限与全局 CLI 配置保持。
- 草稿保留未发送选择；续聊默认恢复上次选择，更换型号自动调整不兼容强度。发送／回复期间锁定菜单，避免显示与已提交参数不一致。
- 验证：31 项前端行为测试、完整 TypeScript／Vite、65 项 Rust 对话回归通过；2 项真实 CLI 探针按既有规则忽略。CUA 合成 IPC 验证型号联动、参数发送、回复中禁用、刷新后续聊草稿恢复与 Escape 收起菜单。截图 `.tmp/chat-models/chat-models.jpg`，构建 `apps/desktop/.tmp/chat-model-build/`；未调用真实模型，未发布安装包。详见 [行动记录](../project_logs/2026-11-06-chat-models.md)。

## 既有 provider 与工具交付

2026-11-05：本机 Codex 对话增加 `hyperframes_video`，同一模型在对话内编写、检查、预览并渲染视频，成片入库并在对话消息播放。只有此受控宿主工具获得当前视频工程写入／渲染能力，普通 shell、全局 Skill、MCP 与 Cloud 工具范围保持。旧本机对话迁移至工具版本 v4，保留应用历史身份。实现与验收边界见 [VIDEO-SKILL.md](VIDEO-SKILL.md#2026-11-05对话渠道接入源码未发布)。

2026-10-31。产品约定以 `PROJECT.md` 为准；本页记录本轮实现、验证和交付边界。

## 本轮范围

- 新对话可选本机 Codex 或 DeepSeek Cloud；provider 属于会话身份，旧对话继续使用 Codex。
- 共用本地会话、消息、画布投影与受控建卡工具。Cloud 不要求安装或登录 Codex。
- Cloud 使用服务端 Bcoin 报价与账本，测试价格为 0；模型密钥只在服务端。

## 动作与理由

1. 读取 ub-mode、当前项目约定、架构、计费、Harness 与界面规范，核对既有对话身份和云端边界，避免复制一套会话或 Agent。
2. 检查工作区与 Git：当前 `dev` 含其他未提交工作，另有一个既存未推送提交；本轮按文件／增量隔离，不清理他人产物。
3. 分别调查云端协议／计费、Rust provider 分派、前端选择与历史，先确定共同数据契约再实现；各部分先写可观察行为的失败测试。
4. 检查可用工具与仓库入口，未提供 crapper、dryer、mutator；不宣称运行过这些工具，以有针对性的行为回归和差异审查记录替代验证范围。
5. 确认现有 DeepSeek 密钥仅 VPS 持有，采用 `chat-proxy` 异步单次模型请求，由现有 Worker 消费；桌面复用原工具循环，未另建领域 Agent。图片只传本机引用别名的文字说明，不传图像像素，也不宣称 DeepSeek 能看图。
6. 扩展既有官网 Cloud 网关的固定路由。新增本机 HTTP 行为用例先得到预期的 404 失败，再仅开放 `POST chat-proxy`；鉴权、JSON 边界、无重试和 Worker 路由拒绝保持。16 项网关测试通过。沙箱禁止 localhost 连接，改在本机测试环境执行；没有请求线上服务。
7. 复用 Bcoin 账本并仅为 `chat_deepseek` 放开零额预留。测试协议只接受服务端 0 报价；非零价格拒绝创建，正式启价前另行实现用户可见的预算确认，避免工具多次调用产生隐性累计费用。
8. 先复现 provider 字段、草稿选择及请求身份测试失败，再增加会话 provider 和 SQLite 0049 迁移。迁移只替换原先固定 Codex 的列，保留旧消息、工具回执和外键；续聊不能改 provider。
9. Cloud 请求发出前持久化原账号和稳定幂等键；提供显式“取回回复”，只查询原任务。恢复文字不再次执行卡片工具，恢复回执不能覆盖新的对话轮次。停止只结束本机等待，已被 Cloud 接受的单次请求仍可能完成。
10. 审查云端输入和生命周期：不接收客户端 system、模型或任意工具定义；请求放入私有临时对象并校验哈希，24 小时清理正文，保留计费、tokens 与模型元数据。未知结果不自动重发；清理失败不能吞掉已领取任务。
11. 使用独立 17883 端口的合成 IPC 页面验收 provider 菜单、零余额且无 Codex／Pro 的纯聊、同会话续聊、刷新后历史和原轮次取回；没有读取用户素材库、调用真实模型或启动生成。

## 验证与交付

- Rust 对话相关测试：58 通过、2 项既有真实 CLI 探针忽略。覆盖旧数据迁移、provider 固定、原请求取回、重复恢复、账号及工具边界。
- 前端行为 27 项、网关 16 项、Cloud Worker／DeepSeek 18 项、Rust Cloud 配置 4 项通过；加上上述对话 58 项，共 123 项针对测试通过。离线 PGlite 覆盖零价确认、幂等重放与冲突、成本拒绝、未知结果、上传回滚、过期及 usage 保留；完整桌面／Worker TypeScript 与两个 Edge 的 Deno 检查通过。
- 桌面完整 Vite 构建通过（仅既有大包提示）。产物在 `apps/desktop/.tmp/chat-provider-build/`，未替换正式安装包。
- 界面证据：`apps/desktop/.tmp/local-chat/provider-selector.jpg`、`provider-cloud-recovered.jpg`。截图为合成验收数据。
- 未部署 Cloud 迁移、Edge、官网网关或 VPS Worker，未运行真实 DeepSeek 请求。上线必须配套执行 [Cloud 对话部署顺序](../apps/cloud/CHAT.md)；测试开关默认关闭，数据库价格为 0 Bcoin。
- 按 ub-mode 分为 Cloud 单次请求服务与桌面对话选择两批提交；只暂存本轮文件及共享文档中的本轮增量，保留工作区其他改动。未创建临时 worktree；验收服务结束后只停止本轮 17883 端口进程，保留本轮截图与构建证据。
