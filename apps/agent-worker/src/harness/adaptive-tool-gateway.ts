import { canonicalJson, computeArgsHash } from "../kernel/tool-ledger.ts";
import { parseTaskAuthorization, type TaskAuthorization } from "../contracts/task-authorization.ts";
import type { HarnessModelToolCall } from "./unified-planning-tool-bridge.ts";
import type { ToolGatewayResult } from "./scoped-tool-gateway.ts";

export type AdaptiveAction = {
  actionId: string;
  toolName: string;
  arguments: unknown;
  argsHash: string;
  slot: number;
  status: "pending" | "completed";
  result?: unknown;
};
export type AdaptiveJournal = { authorizationHash: string; actions: AdaptiveAction[] };
export type AdaptiveToolPort = {
  /** Validates tool arguments and current-Run artifact ownership before reserving a slot. */
  validate(toolName: string, args: unknown): unknown;
  /** Existing durable executors own provider replay and uncertain outcomes. */
  execute(action: AdaptiveAction): Promise<unknown>;
  save(journal: AdaptiveJournal): Promise<void>;
};

/** A durable journal and capability gate, not a planner: the Agent chooses every action. */
export class AdaptiveToolGateway {
  private readonly authorization: TaskAuthorization;
  private readonly port: AdaptiveToolPort;
  private journal: AdaptiveJournal;
  private mutex: Promise<void> = Promise.resolve();
  private readonly flights = new Map<string, Promise<unknown>>();
  private stopped = false;

  constructor(authorization: TaskAuthorization, journal: AdaptiveJournal, port: AdaptiveToolPort) {
    this.authorization = parseTaskAuthorization(authorization);
    if (journal.authorizationHash !== computeArgsHash(this.authorization)) throw new Error("adaptive_authorization_mismatch");
    const ids = new Set<string>();
    for (const [slot, action] of journal.actions.entries()) {
      if (action.slot !== slot || ids.has(action.actionId) || !/^[a-z][a-z0-9_-]{0,63}$/.test(action.actionId) ||
          !["pending", "completed"].includes(action.status) ||
          action.argsHash !== computeArgsHash({ toolName: action.toolName, arguments: action.arguments })) {
        throw new Error("adaptive_journal_invalid");
      }
      ids.add(action.actionId);
    }
    for (const toolName of new Set(journal.actions.map((action) => action.toolName))) {
      if (journal.actions.filter((action) => action.toolName === toolName).length > this.limit(toolName)) {
        throw new Error("adaptive_journal_quota_invalid");
      }
    }
    this.journal = JSON.parse(canonicalJson(journal));
    this.port = port;
  }

  private limit(toolName: string): number {
    return toolName === "finalize_output" ? 1
      : this.authorization.capabilities.find((item) => item.tool === toolName)?.maxCalls ?? 0;
  }
  get finalResult(): unknown {
    return this.journal.actions.find((action) => action.toolName === "finalize_output" && action.status === "completed")?.result;
  }
  snapshot(): AdaptiveJournal { return JSON.parse(canonicalJson(this.journal)); }

  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }

  async recover(): Promise<void> {
    // Resume persisted requests with the original slot before asking the Agent for new work.
    for (const action of this.snapshot().actions.filter((entry) => entry.status === "pending")) {
      await this.dispatch({ toolName: action.toolName, arguments: { actionId: action.actionId, input: action.arguments } });
    }
  }

  async dispatch(call: HarnessModelToolCall): Promise<ToolGatewayResult> {
    const raw = call.arguments as { actionId?: unknown; input?: unknown } | null;
    const correction = (errorCode: string): ToolGatewayResult => ({ callId: "validation", value: { status: "retry_required", errorCode } });
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join(",") !== "actionId,input" ||
        typeof raw.actionId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(raw.actionId)) return correction("adaptive_arguments_invalid");
    if (!this.limit(call.toolName)) return correction("adaptive_capability_not_authorized");
    let input: unknown;
    try { input = JSON.parse(canonicalJson(this.port.validate(call.toolName, raw.input))); }
    catch (error) { return correction(error instanceof Error && /^[a-z0-9_:-]{1,120}$/.test(error.message) ? error.message : "adaptive_tool_arguments_invalid"); }
    const argsHash = computeArgsHash({ toolName: call.toolName, arguments: input });
    let leader: AdaptiveAction | undefined;
    let resolveFlight!: (value: unknown) => void;
    let rejectFlight!: (reason: unknown) => void;
    const reserved = await this.locked(async () => {
      if (this.stopped) throw new Error("adaptive_execution_stopped");
      const existing = this.journal.actions.find((action) => action.actionId === raw.actionId);
      if (existing && (existing.argsHash !== argsHash || existing.toolName !== call.toolName)) return { error: "adaptive_action_id_conflict" };
      if (existing?.status === "completed") return { value: existing.result };
      if (!existing && this.journal.actions.some((action) => action.toolName === "finalize_output")) return { error: "adaptive_already_finalized" };
      if (call.toolName === "finalize_output" && this.journal.actions.some((action) => action.status === "pending" && action !== existing)) {
        return { error: "adaptive_tools_still_running" };
      }
      if (!existing && this.journal.actions.filter((action) => action.toolName === call.toolName).length >= this.limit(call.toolName)) {
        return { error: "adaptive_capability_limit_reached" };
      }
      const action = existing ?? { actionId: raw.actionId as string, toolName: call.toolName, arguments: input,
        argsHash, slot: this.journal.actions.length, status: "pending" as const };
      if (!existing) {
        this.journal.actions.push(action);
        try { await this.port.save(this.snapshot()); }
        catch (error) { this.stopped = true; throw error; }
      }
      let flight = this.flights.get(action.actionId);
      if (!flight) {
        flight = new Promise<unknown>((resolve, reject) => { resolveFlight = resolve; rejectFlight = reject; });
        void flight.catch(() => {});
        this.flights.set(action.actionId, flight);
        leader = JSON.parse(canonicalJson(action));
      }
      return { flight };
    });
    if (reserved.error) return correction(reserved.error);
    if (leader) {
      void (async () => {
        try {
          const result = await this.port.execute(leader!);
          // Refuse non-JSON results before they can enter recovery context.
          const frozen = JSON.parse(canonicalJson(result));
          await this.locked(async () => {
            const action = this.journal.actions[leader!.slot]!;
            action.status = "completed";
            action.result = frozen;
            try { await this.port.save(this.snapshot()); } catch (error) { this.stopped = true; throw error; }
          });
          resolveFlight(frozen);
        } catch (error) {
          this.stopped = true;
          rejectFlight(error);
        }
      })();
    }
    return { callId: `action:${raw.actionId}`, value: reserved.flight ? await reserved.flight : reserved.value };
  }
}
