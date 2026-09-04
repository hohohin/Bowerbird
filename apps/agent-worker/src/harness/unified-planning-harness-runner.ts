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
import type { UnifiedPlanningToolBridge } from "./unified-planning-tool-bridge.ts";

export type PlanningHarnessAdapterFactory = (
  childEnvironment: Readonly<Record<string, string>>,
  providerEnvironment?: Readonly<Record<string, string>>,
) => HarnessAdapter;

/**
 * Owns one U2 planning turn end-to-end: per-Run capability server, fresh DSH
 * session, and deterministic teardown. It does not own Run/checkpoint state.
 */
export class UnifiedPlanningHarnessRunner {
  private readonly bridge: UnifiedPlanningToolBridge;
  private readonly createAdapter: PlanningHarnessAdapterFactory;

  constructor(
    bridge: UnifiedPlanningToolBridge,
    createAdapter: PlanningHarnessAdapterFactory,
  ) {
    this.bridge = bridge;
    this.createAdapter = createAdapter;
  }

  async run(seed: HarnessCheckpointSeed, prompt: HarnessPromptBlock[]): Promise<HarnessTurnResult> {
    if (seed.runId !== this.bridge.runId || seed.phase !== "compose_plan" || !prompt.length ||
        prompt.some((block) => block.type !== "text" || !block.text.trim())) {
      throw new Error("unified_planning_input_invalid");
    }

    let server: LoopbackToolBridgeServer | undefined;
    let session: HarnessSession | undefined;
    try {
      server = await startLoopbackToolBridge(this.bridge);
      const adapter = this.createAdapter(server.childEnvironment());
      session = await adapter.open(seed);
      return await session.turn(prompt);
    } finally {
      await session?.close();
      await server?.close();
    }
  }
}
