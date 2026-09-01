import type {
  HarnessAdapter,
  HarnessCheckpointSeed,
  HarnessPromptBlock,
  HarnessSession,
  HarnessTurnResult,
} from "./contracts.ts";
import { startLoopbackToolBridge, type LoopbackToolBridgeServer } from "./loopback-tool-bridge-server.ts";
import type { UnifiedHtmlExecutionToolBridge } from "./unified-html-execution-tool-bridge.ts";

export type HtmlExecutionProfileMode = "html-execution" | "content-execution";

export type HtmlExecutionHarnessAdapterFactory = (
  childEnvironment: Readonly<Record<string, string>>,
  providerEnvironment: Readonly<Record<string, string>>,
  profileMode: HtmlExecutionProfileMode,
) => HarnessAdapter;

/** One fresh approved HTML session; Bowerbird checkpoint/tool ledger remain the recovery authority. */
export class UnifiedHtmlExecutionHarnessRunner<TResult, TInspection = unknown, TFinal = unknown, TSocial = unknown> {
  private readonly bridge: UnifiedHtmlExecutionToolBridge<TResult, TInspection, TFinal, TSocial>;
  private readonly createAdapter: HtmlExecutionHarnessAdapterFactory;

  constructor(bridge: UnifiedHtmlExecutionToolBridge<TResult, TInspection, TFinal, TSocial>, createAdapter: HtmlExecutionHarnessAdapterFactory) {
    this.bridge = bridge;
    this.createAdapter = createAdapter;
  }

  async run(
    seed: HarnessCheckpointSeed,
    prompt: HarnessPromptBlock[],
    providerEnvironment: Readonly<Record<string, string>>,
    profileMode: HtmlExecutionProfileMode = "html-execution",
  ): Promise<HarnessTurnResult> {
    if (seed.runId !== this.bridge.runId || seed.phase !== "execute_approved_plan" ||
        !/^[0-9a-f]{64}$/.test(seed.approvedPlanHash ?? "") || !prompt.length ||
        prompt.some((block) => block.type !== "text" || !block.text.trim())) {
      throw new Error("unified_html_execution_input_invalid");
    }
    let server: LoopbackToolBridgeServer | undefined;
    let session: HarnessSession | undefined;
    try {
      server = await startLoopbackToolBridge(this.bridge);
      session = await this.createAdapter(server.childEnvironment(), providerEnvironment, profileMode).open(seed);
      return await session.turn(prompt);
    } finally {
      await session?.close();
      await server?.close();
    }
  }
}
