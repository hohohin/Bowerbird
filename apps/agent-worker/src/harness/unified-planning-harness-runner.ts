import type {
  HarnessAdapter,
  HarnessCheckpointSeed,
  HarnessPromptBlock,
  HarnessSession,
  HarnessTurnResult,
} from "./contracts.ts";
import {
  startLoopbackToolBridge,
  type LoopbackToolBridgeServer,
} from "./loopback-tool-bridge-server.ts";
import type { PlanningToolDispatchPort } from "./loopback-tool-bridge-server.ts";
import { ToolActivity } from "./tool-activity.ts";
type RunToolBridge = PlanningToolDispatchPort & { readonly runId: string };

export type PlanningHarnessAdapterFactory = (
  childEnvironment: Readonly<Record<string, string>>,
  providerEnvironment?: Readonly<Record<string, string>>,
  activity?: ToolActivity,
) => HarnessAdapter;

/**
 * Owns one U2 planning turn end-to-end: per-Run capability server, fresh DSH
 * session, and deterministic teardown. It does not own Run/checkpoint state.
 */
export class UnifiedPlanningHarnessRunner {
  private readonly bridge: RunToolBridge;
  private readonly createAdapter: PlanningHarnessAdapterFactory;

  constructor(
    bridge: RunToolBridge,
    createAdapter: PlanningHarnessAdapterFactory,
  ) {
    this.bridge = bridge;
    this.createAdapter = createAdapter;
  }

  async run(seed: HarnessCheckpointSeed, prompt: HarnessPromptBlock[]): Promise<HarnessTurnResult> {
    if (seed.runId !== this.bridge.runId || !["compose_plan", "execute_approved_plan"].includes(seed.phase) ||
        (seed.phase === "execute_approved_plan" && !/^[0-9a-f]{64}$/.test(seed.approvedPlanHash ?? "")) || !prompt.length ||
        prompt.some((block) => block.type !== "text" || !block.text.trim())) {
      throw new Error("unified_planning_input_invalid");
    }

    let server: LoopbackToolBridgeServer | undefined;
    let session: HarnessSession | undefined;
    try {
      const activity = new ToolActivity();
      server = await startLoopbackToolBridge({ dispatch: (call) => activity.run(() => this.bridge.dispatch(call)) });
      const adapter = this.createAdapter(server.childEnvironment(), undefined, activity);
      session = await adapter.open(seed);
      return await session.turn(prompt);
    } finally {
      await session?.close();
      await server?.close();
    }
  }
}
