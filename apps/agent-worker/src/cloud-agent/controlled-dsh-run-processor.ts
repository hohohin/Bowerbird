import type { ModelBackend } from "../contracts/model.ts";
import type {
  ApprovedStepExecutor,
  ControlledFeedbackDiagnoser,
} from "../kernel/controlled-image-edit-runner.ts";
import { ControlledImageEditRunProcessor } from "./controlled-run-processor.ts";
import type { AgentRunContext, AgentRunProcessor } from "./runtime.ts";

export type ControlledExecutorScope = ApprovedStepExecutor | {
  executor: ApprovedStepExecutor;
  diagnoser?: ControlledFeedbackDiagnoser;
  cleanup(): void;
};

export type ControlledDshRunProcessorOptions = {
  createModel(context: AgentRunContext): ModelBackend;
  executorFactory(context: AgentRunContext): ControlledExecutorScope;
};

/** Binds one DSH ModelBackend to one claimed Run while reusing the legacy business processor. */
export class ControlledDshRunProcessor implements AgentRunProcessor {
  private readonly options: ControlledDshRunProcessorOptions;

  constructor(options: ControlledDshRunProcessorOptions) {
    this.options = options;
  }

  async process(context: AgentRunContext): Promise<void> {
    const processor = new ControlledImageEditRunProcessor(
      this.options.createModel(context),
      this.options.executorFactory,
    );
    await processor.process(context);
  }
}
