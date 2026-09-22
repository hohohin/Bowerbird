import { defineTool } from "@deepseek-ai/dsh-tools";
import { callBowerbirdPlanningBridge } from "./bowerbird-planning-rpc.mjs";

// Local dev-only "Agent DS" toolset: the desktop app executes both tools through
// the .agent-z rpc file contract behind the parent bridge. No conclude/parking
// semantics — a local chat turn simply ends when the model stops calling tools.
const JSON_OUTPUT = {
  schema: { type: "json" },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
};

function remoteTool({ name, description, parameters, isConcurrencySafe }) {
  return defineTool({
    name,
    description,
    parameters,
    ...(isConcurrencySafe ? { isConcurrencySafe } : {}),
    output: JSON_OUTPUT,
    async execute(args, exec) {
      return await callBowerbirdPlanningBridge(name, args, exec.signal);
    },
  });
}

export const name = "bowerbird-agent-ds-tools";
export const inject = ["tools"];

export function agentDsToolDefinitions() {
  return [
    remoteTool({
      name: "dreamina_generate",
      description:
        "用即梦（Dreamina，火山引擎）生成图片并自动存入 Bowerbird 素材库（瀑布流可见），返回生成图的资产 id 与路径。" +
        "涉及生图时必须用本工具，不要自己调 CLI 或编造结果。需要 Bowerbird 桌面端运行中。",
      isConcurrencySafe: () => true,
      parameters: {
        prompt: { type: "string", required: true, description: "完整生图提示词" },
        images: {
          type: "array",
          description: "参考图绝对路径（可选，最多 10 张）",
          items: { type: "string" },
        },
        ratio: { type: "string", description: "画面比例，如 16:9 / 1:1（可选，默认自动）" },
      },
    }),
    remoteTool({
      name: "understand_asset",
      description:
        "对一张参考图执行反推（图像理解，走 Bowerbird 视觉链路），并把结果以 agentz-<时间> 新维度追加到该图已有维度数据之后（不覆盖现有维度）。适合需要聚焦分析（如局部细节、文字提取）或为素材库留下分析记录时使用。需要 Bowerbird 桌面端运行中。",
      parameters: {
        image_path: { type: "string", required: true, description: "素材库内图片的绝对路径（store_path）" },
        prompt: {
          type: "string",
          description:
            "自定义反推指令（可选，≤4000 字符）。例：『着重描述画面右侧人物的动作与穿着，忽略背景』；不传则用应用默认指令",
        },
      },
    }),
  ];
}

export function apply(ctx) {
  for (const definition of agentDsToolDefinitions()) ctx.tools.register(definition);
}
