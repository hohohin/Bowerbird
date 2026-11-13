# 本机 DSH 建卡工具参数非法导致循环中断（2026-11-12）

> 状态：仅调查报告，未提交代码。工作区有未提交改动，见第 5 节。
> 范围：Bowerbird 桌面「本机 DSH」对话 / Agent 卡片（DSH 0.2.2-rc.1，`dsh web`）。
> 时间：2026-11-12（Asia/Shanghai）。

## 摘要

循环卡片连接的 Agent 卡片选「本机 DSH」后，第一项执行完即整条循环中断，界面显示「本机 DSH 本轮未完成，已保留收到的内容；请检查模型配置或取回原回复」。

真实原因不是配置、不是循环调度、也不是输出长度截断：**模型生成建卡工具参数时，在根对象收尾多写了一个 `}`，DSH 严格解析判为非法 JSON，把整轮标记为 `MALFORMED_RESPONSE`**。桥把这个未知原因码兜底成了"检查模型配置"，因此长期误导排查方向。

## 1. 现象与用户可见影响

- 循环卡 → Agent 卡（本机 DSH）：循环第一项正常，第二项起失败；观感是"Agent 最多执行一次"。
- 报错文案固定为上述一句，没有任何 DSH 侧的信息。
- 该轮不产生任何卡片；已流出的文字保留在对话里。
- 手动重跑可以继续，但循环每次都会在同样的位置停下。

## 2. 排查过程与证据

### 2.1 报错文本的来源

`apps/desktop/src-tauri/src/commands/local_chat_dsh_local.rs` 的 `Reply::status()` 只识别五种 `turn/end.reason.kind`：`completed`、`aborted`、`interrupted`、`max-tokens`、`blocked`；其余一律落到兜底分支，输出上面那句"请检查模型配置"。所以这句话本身不携带任何诊断信息。

### 2.2 从 DSH 会话日志取真相

桥每轮创建独立会话，日志位于：

```
%USERPROFILE%\.dsh\sessions\--C-Users-Hins-.dsh--\session-bowerbird-chat-<sha256>\session.v4.jsonl.zstd
```

文件是**多帧 zstd**（单个文件约 8 帧）。逐帧解压后可读到：

```json
{"type":"turn/end","data":{"turn":1,"reason":{
  "kind":"error",
  "error":{"message":"DeepSeek Messages stream: tool input is invalid JSON","code":"MALFORMED_RESPONSE"}}}}
```

命中三例（均为当天）：

| 时间 | 会话 | 参数长度 | 结尾 |
|---|---|---|---|
| 10:17 | `session-bowerbird-chat-f084e335…` | 1468 | `…]}}` |
| 03:26 | `session-bowerbird-chat-62e89f40…` | 3216 | `…]}}` |
| 03:19 | `session-bowerbird-chat-c5397747…` | 2381 | `…]}}` |

同批次成功的对照会话（10:17 `7cee4580…`）参数结尾只有一个 `}`，解析通过。

### 2.3 模型原始参数

从 `assistant/attempt` 事件的流式块里取 `block-end.block.arguments`（模型原始输出，未经任何加工）。三例尾部均为根对象已闭合后又多一个 `}`，`JSON.parse` 报：

```
Unexpected non-whitespace character after JSON at position <length-1>
```

即：不是缺字段、不是内容超限，是**语法上多一个右花括号**。

### 2.4 DSH 只拼接、不加工

`dsh-llm-deepseek`（asar 内）的实现：

```js
if (delta.type === "input_json_delta" && content.type === "tool-call") {
  block.json += argumentsDelta;                       // 逐段拼接
}
// content_block_stop:
if (block.content.type === "tool-call" && block.json.length > 0)
  block.content.arguments = block.json;
// message_stop:
try { parsed = JSON.parse(content.arguments); }
catch { return malformed("tool input is invalid JSON"); }
```

DSH 不添加任何字符，桥只接收 DSH 已经拒绝的结果。因此可以排除"Bowerbird 或 DSH 把参数写坏"。

### 2.5 排除截断

失败轮的 `request/header.config` 为：

```json
{"provider":"deepseek-official","model":"deepseek-flash","maxTokens":256000,"reasoningEffort":"high"}
```

`maxTokens` 远未耗尽；`turn/end` 是 `error` 而不是 `max-tokens`；DSH 也只在 `reason.kind !== "max-tokens"` 时才做工具参数校验。所以不是"输出被截断"，而是"输出完整但末尾多一个括号"。

### 2.6 频率与循环的叠加

同一上午桥的 12 个会话、共 11 次工具调用，3 次 `MALFORMED_RESPONSE`（约 27%）。循环每个条目一轮、每轮重新生成整批卡片 JSON，任一命中即整条循环停止——这就是"最多执行一次"的来源。

## 3. 根因

**直接原因**：模型生成的 `create_canvas_cards` 参数在根对象后多一个 `}`。

**放大因素**（都在我们可控范围内）：

1. 建卡 schema 原本是 5 分支的 `oneOf` 联合，模型需要在分支间选型并正确闭合多层结构；
2. 轮次提示词会回放历史 JSON（含上一轮工具调用），模型容易照着上一轮的结构续写；
3. 循环逐项重复以上生成，失败概率被条目数放大。

**为什么一直误判**：桥把所有未知 `reason` 兜底成"检查模型配置"，把"模型语法错误"说成了"配置问题"。

## 4. 影响范围

- 该轮**不创建任何卡片**：Rust 侧先校验后落卡，失败即整体拒绝，不存在半批卡片。
- 已收到的部分文字保留在对话里，可读但不可续跑。
- 循环 / 工作流在该步失败停止，需要重跑；不会重复提交已完成项。
- 不影响历史数据、画板内容和既有卡片。

## 5. 已落地改动（工作区未提交）

| 改动 | 位置 | 说明 |
|---|---|---|
| 报错可读化 | `local_chat_dsh_local.rs` `Reply::failed()` | `MALFORMED_RESPONSE` → 「模型返回的卡片工具参数不是合法 JSON（码）；可直接重跑这张卡片」；其他错误码只带 code，不回显上游原文 |
| 自动 Agent 轮次不回放历史 | `local_chat_dsh.rs` / `core/local_chat.rs` | `include_history = !db.local_chat_turn_targets_agent_card(turn)`；live 与 legacy 两条路径都生效；手动对话仍带历史 |
| 建卡 schema 拍平 | `chat-card-tool.json` | `cards.items` 由 5 分支 `oneOf` 改为单对象 + `kind` 枚举，`required` 收敛为 `id/kind/title` |
| 跨类型字段归一化 | `core/local_chat_cards.rs` | 按 `kind` 丢弃别的类型的字段；`endpoint` 等未知键仍拒绝 |
| 工具版本 | `local_chat.rs` | `CARD_TOOL_VERSION` 4 → 5，旧会话按既有机制迁移 |
| 测试 | `local_chat_tests.rs`、`local_chat_cards_tests.rs` | 两条 schema 契约测试更新，新增一条归一化用例 |

验证状态：`cargo test --lib --no-run` 通过（exit 0）。Rust 用例**未执行**：本机测试二进制启动即 `0xC0000139`，用改动前的旧二进制同样复现，属环境问题。尚未跑真实循环回归。

## 6. 本轮明确不做

- 不自动重试：用户明确要求先解决原因，而不是用重试掩盖。
- 不以更换模型作为解决方案。
- 除上述已落地项外，不再改动代码。

## 7. 未决方案（供决策）

如果拍平后仍出现同样的尾部多括号，剩下的是"传输方式"层面的选择：

| 方案 | host 是否解析复杂 JSON | 同轮纠错（模型看到错误再改） | 字段约束 |
|---|---|---|---|
| A 现状：结构化参数（已拍平） | 是（本次问题所在） | 有 | schema 强约束 |
| B 文本块：模型在回复里写约定块，由桥解析 | 否，彻底免疫 | 无，校验失败只能整轮重跑 | 只能写进提示词 |
| C 单字符串参数：`{"json":"…"}` | 仅解析极简外层 | 有 | 只能写进工具描述；新增转义风险 |

"同轮纠错"指：工具返回 `{"success":false,"error":"循环需要行来源"}` 给模型，模型在同一轮补齐参数后再次调用，用户无感。B 方案会失去这条链路。

## 8. 复现与取证方法

1. 找到失败轮对应的 `session-bowerbird-chat-*` 目录（按修改时间）。
2. 按 zstd 帧魔数 `28 b5 2f fd` 切分 `session.v4.jsonl.zstd`，逐帧解压。
3. 在事件里查 `turn/end` 的 `reason`；若有 `MALFORMED_RESPONSE`，再从 `assistant/attempt` 的 `block-end.block.arguments` 取模型原始参数。
4. 对参数跑 `JSON.parse`，错误位置通常就是末尾——多一个 `}` 即本次故障形态。

## 9. 结论

这不是"模型配置"问题，也不是截断：是模型输出的工具参数在收尾多一个 `}`，被 DSH 严格解析放大成整轮失败；循环把单轮失败累积成"最多执行一次"。代码侧能做的是降低结构复杂度（已做）与改变传输方式（未决），重试和换模型都不是本轮方向。

## 10. 审查后的补齐（同日）

代码审查指出四处会让修复失效或报错误导的缺口，已按顺序处理：

| 缺口 | 处理 |
|---|---|
| preset 只在缺失时安装，更新 Bowerbird 后用户仍跑旧工具定义 | `install` 改为契约同步：比对 profile 补丁里的托管块与当前内容寻址模块；不一致时先移除托管块，用 `agentPresets/list` 是否消失判断宿主是否会热加载，消失后重写并等它重新出现才判 `Active`，不消失则写回并报待重启；`setup` 在 `live` 时总是同步；状态对"已安装但非当前版本"单独提示 |
| `include_history=false` 仍带着 `[近期建卡历史]` 摘要 | `cloud_chat::messages` 增加 `include_card_actions`，自动轮次传 `false`；手动对话仍为 `true` |
| 后端中文报错含 `MALFORMED_RESPONSE`，被前端 `clearChineseMessage` 整句过滤成兜底 | 文案去掉下划线错误码；仅 `tool input is invalid JSON` 翻译为"卡片工具参数不是合法 JSON"，同码其他异常为"模型回复格式异常"；文案改为"重跑前请确认本轮已创建的卡片" |
| 宿主已明确失败，前端仍把步骤设为 waiting 并反复取回 | `terminalChatFailure()`（"本机 DSH 本轮失败"前缀）在 `chatResult` 中抛出 `WorkflowNodeError`，按失败终止 |

验证：`cargo test --lib --no-run` 通过（exit 0），`tsc --noEmit` 通过（exit 0）。仍未能执行 Rust 用例（`0xC0000139`），未跑真实循环。

**剩余阻塞**：多余尾括号的规范化只能在 DSH 的参数解析边界做。Bowerbird 收到工具调用时 DSH 已判定失败，Rust 侧无法修复；审查给出的受限规则（仅删最后一个多余 `}`、删后必须整体可严格解析为对象、保留原始参数与原因诊断）需要在 DSH 的 stream 扩展点或 adapter 中实现，本轮未改动 DSH。

**未实现**：显式"重做当前 Agent、保留本次循环已完成项与当前项已完成分支"的重做动作；目前终态失败后由用户重新运行整张卡片。
