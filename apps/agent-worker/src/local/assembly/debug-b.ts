/** 一次性诊断脚本：给 Route B 套一层日志 Model，看校验失败时模型的原始返回。 */
import { DeepSeekBackend, deepSeekConfigFromEnv } from "../../providers/deepseek/backend.ts";
import type { ModelBackend, ModelTurnRequest, ModelTurnResult } from "../../contracts/model.ts";
import { expandPrompt } from "./expand.ts";
import { FIXTURES } from "./fixtures.ts";
import { reviewWithSkill } from "./review-agent.ts";
import { loadPromptReviewSkill } from "./skill-loader.ts";

class LoggingModel implements ModelBackend {
  readonly id = "deepseek" as const;
  private readonly inner: DeepSeekBackend;
  constructor(inner: DeepSeekBackend) {
    this.inner = inner;
  }
  async turn(request: ModelTurnRequest, signal: { readonly aborted: boolean }): Promise<ModelTurnResult> {
    const result = await this.inner.turn(request, signal);
    if (result.kind === "action") {
      console.log("---- action args ----");
      console.log(JSON.stringify(result.arguments).slice(0, 1500));
    } else {
      console.log("---- non-action:", result.kind);
    }
    return result;
  }
}

const wanted = process.argv.slice(2);
const model = new LoggingModel(new DeepSeekBackend(deepSeekConfigFromEnv(process.env)));
for (const fixture of FIXTURES.filter((item) => wanted.length === 0 || wanted.includes(item.id))) {
  try {
    await reviewWithSkill(
      {
        intentPrompt: fixture.input.originalPrompt,
        expandedPrompt: expandPrompt(fixture.input.originalPrompt, fixture.input.references),
        references: fixture.input.references,
        output: fixture.input.output,
      },
      model,
      `debug-b-${fixture.id}`,
      loadPromptReviewSkill(),
    );
    console.log(`[${fixture.id}] OK`);
  } catch (error) {
    console.log(`[${fixture.id}] FAIL: ${error instanceof Error ? error.message : error}`);
  }
}
