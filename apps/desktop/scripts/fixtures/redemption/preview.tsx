import React from "react";
import { createRoot } from "react-dom/client";
import { SettingsDialog } from "../../../src/components/SettingsDialog";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";

// Synthetic IPC only: the real SettingsDialog, store action and API wrapper run without native IO.
const w = window as any;
w.store = useStore;
w.calls = [];
w.mode = "success";
const policy = { can_use_byo: false, can_use_cloud: true, max_parallel_jobs: 1, understand_daily_limit: 10,
  can_use_priority_queue: false, can_hd_export: false, can_use_agent_runs: false,
  max_parallel_agent_runs: 1, allowed_agent_skills: [], agent_budget_options: [], can_use_visual_profiles: false };
const free: any = { user_id: "test-user", tier: "free", balances: { daily: 30, sub: 0, topup: 0 }, policy,
  recent_transactions: [], generation_services: [], prompt_configs: [], is_test_account: false };
const pro = { ...free, tier: "pro", balances: { daily: 30, sub: 1100, topup: 0 },
  policy: { ...policy, can_use_byo: true, max_parallel_jobs: 4, understand_daily_limit: null } };
const callbacks = new Map();
w.__TAURI_INTERNALS__ = {
  transformCallback: (callback: any) => { const id = callbacks.size + 1; callbacks.set(id, callback); return id; },
  unregisterCallback: (id: number) => callbacks.delete(id),
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  invoke: async (command: string, args: any) => {
    w.calls.push({ command, args });
    if (command === "plugin:event|listen") return args.handler;
    if (command === "plugin:event|unlisten") return;
    if (command === "plugin:app|version") return "26.9.14";
    if (command === "library_root") return "synthetic-library";
    if (command === "codex_health" || command === "dreamina_health") return { ok: false };
    if (command === "cloud_sync_entitlement") return pro;
    if (command === "cloud_redeem_code") {
      if (w.mode === "error") throw "兑换码无效、已过期或已被使用";
      if (w.mode === "hold") await new Promise((resolve) => { w.release = resolve; });
      return { already_redeemed: w.mode === "replay", period_end: "2026-10-14T00:00:00Z", credits: 1100,
        credits_expires_at: "2026-10-14T00:00:00Z", entitlement: w.mode === "pending" ? null : pro };
    }
    throw new Error(`Unexpected synthetic IPC: ${command}`);
  },
};
useStore.setState({ cloudAuth: { cloud_available: true, logged_in: true, user_id: "test-user", email: "test@example.test",
  display_name: null, avatar_url: null, access_expires_at: null, reason: null }, cloudEntitlement: free,
  cloudBusy: false, loadSettings: async () => {}, defaultProvider: "codex" });
createRoot(document.getElementById("root")!).render(<SettingsDialog onClose={() => {}} />);
