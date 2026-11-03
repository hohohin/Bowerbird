import { localTextAgentJob, startTextAgent, type TextAgentJob } from "./textAgent";
import { userErrorMessage } from "./userError";
import { notifyError } from "./notify";

export interface TextAgentTaskState { busy: boolean; resumable: boolean; status: string; error: string }
export const initialTextAgentTask: TextAgentTaskState = { busy: false, resumable: false, status: "", error: "" };
type Input = Parameters<typeof startTextAgent>[0];

/** One request owner per bubble; cancel/close invalidate pending reads before touching the editor. */
export class TextAgentTask {
  private job: TextAgentJob | null = null;
  private version = 0;
  private active = true;
  private state = initialTextAgentTask;
  constructor(private changed: (state: TextAgentTaskState) => void, private result: (text: string) => void) {}
  activate() { this.active = true; }
  private current(version: number) { return this.active && version === this.version; }
  private update(patch: Partial<TextAgentTaskState>) {
    this.state = { ...this.state, ...patch, resumable: !!this.job };
    if (this.active) this.changed(this.state);
  }
  private async submit(input: Input, version: number) {
    if (input.provider === "codex-cli") this.job = localTextAgentJob(input.requestId);
    const job = await startTextAgent(input);
    if (!this.current(version)) { await this.cancelOnClose(job); return; }
    this.job = job;
  }
  private async receive(version: number) {
    const job = this.job;
    if (!job) return;
    while (this.current(version)) {
      const text = await job.read();
      if (!this.current(version)) return;
      if (text !== null) { this.job = null; this.result(text); this.update({ status: "已写入文档" }); return; }
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  }
  async run(input?: Input) {
    if (this.state.busy || !this.active) return;
    const version = ++this.version;
    this.update({ busy: true, error: "", status: "Agent 正在回复…" });
    try { if (input) await this.submit(input, version); if (this.current(version)) await this.receive(version); }
    catch (reason) { if (this.current(version)) this.update({ error: userErrorMessage(reason, "暂时无法取得 Agent 回复，请检查原任务后继续取回。"), status: "" }); }
    finally { if (this.current(version)) this.update({ busy: false }); }
  }
  async stop() {
    const version = ++this.version;
    this.update({ busy: true, status: "正在停止…", error: "" });
    try { await this.job?.cancel(); if (this.current(version)) { this.job = null; this.update({ status: "已停止" }); } }
    catch (reason) { if (this.current(version)) this.update({ error: userErrorMessage(reason, "尚未确认停止，请检查原任务。"), status: "" }); }
    finally { if (this.current(version)) this.update({ busy: false }); }
  }
  close() {
    this.active = false; this.version++;
    if (this.job) void this.cancelOnClose(this.job);
  }
  private async cancelOnClose(job: TextAgentJob) {
    try { await job.cancel(); }
    catch (reason) { notifyError(reason, "尚未确认 Agent 已停止，请在任务中心检查原任务。"); }
  }
}
