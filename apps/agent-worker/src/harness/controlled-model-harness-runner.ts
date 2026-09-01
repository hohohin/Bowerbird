import type {
  HarnessAdapter,
  HarnessCheckpointSeed,
  HarnessPromptBlock,
  HarnessSession,
  HarnessTurnResult,
} from "./contracts.ts";
import type { ControlledModelActionBridge } from "./controlled-model-action-bridge.ts";
import {
  startLoopbackToolBridge,
  type LoopbackToolBridgeServer,
} from "./loopback-tool-bridge-server.ts";

export type ControlledModelHarnessAdapterFactory = (
  childEnvironment: Readonly<Record<string, string>>,
  providerEnvironment: Readonly<Record<string, string>>,
) => HarnessAdapter;

/** Runs one side-effect-free controlled model turn in a fresh DSH session. */
export class ControlledModelHarnessRunner {
  private readonly bridge: ControlledModelActionBridge;
  private readonly createAdapter: ControlledModelHarnessAdapterFactory;

  constructor(
    bridge: ControlledModelActionBridge,
    createAdapter: ControlledModelHarnessAdapterFactory,
  ) {
    this.bridge = bridge;
    this.createAdapter = createAdapter;
  }

  async run(
    seed: HarnessCheckpointSeed,
    prompt: HarnessPromptBlock[],
    providerEnvironment: Readonly<Record<string, string>>,
  ): Promise<HarnessTurnResult> {
    if (seed.runId !== this.bridge.runId || seed.phase !== this.bridge.phase || !prompt.length ||
        prompt.some((block) => block.type !== "text" || !block.text.trim())) {
      throw new Error("controlled_dsh_model_input_invalid");
    }

    let server: LoopbackToolBridgeServer | undefined;
    let session: HarnessSession | undefined;
    try {
      server = await startLoopbackToolBridge(this.bridge);
      const adapter = this.createAdapter(server.childEnvironment(), providerEnvironment);
      session = await adapter.open(seed);
      return await session.turn(prompt);
    } finally {
      await session?.close();
      await server?.close();
    }
  }
}
