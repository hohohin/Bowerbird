import { useMemo, useSyncExternalStore } from "react";
import { comfyEnvironment, type ComfyEnvironment, type ComfyEnvironmentMode } from "./comfyVideo";
import { userErrorMessage } from "./userError";
import { useStore } from "../store";

type Snapshot = { environment?: ComfyEnvironment; error: string; checking: boolean; acting: boolean; canCancel: boolean; cancelling: boolean };
type Action = "select_existing" | "install" | "prepare" | "driver" | "cancel";
type Listener = () => void;
const initial: Snapshot = { error: "", checking: true, acting: false, canCancel: false, cancelling: false };
const refreshInterval = 5000;
const checks = new Map<string, EnvironmentCheck>();
let focusTimer: number | undefined;
let lastFocus = -Infinity;
let operation: EnvironmentCheck | undefined;
let operationVersion = 0;
let pollTimer: number | undefined;
let stopWatchingAccount: (() => void) | undefined;

const preparing = (state?: ComfyEnvironment) => state?.phase === "installing" || state?.phase === "starting";
const accountScope = ({ cloudAuth }: ReturnType<typeof useStore.getState>) => cloudAuth?.logged_in ? cloudAuth.user_id ?? "" : "";
function scheduleFocus() {
  window.clearTimeout(focusTimer);
  focusTimer = window.setTimeout(() => {
    if (operation) return;
    lastFocus = performance.now();
    for (const check of checks.values()) if (check.listeners.size) void check.refresh(true);
  }, Math.max(250, refreshInterval + lastFocus - performance.now()));
}

function publishOperation() {
  for (const check of checks.values()) check.publish();
}

function beginOperation(check: EnvironmentCheck) {
  operation = check;
  const version = ++operationVersion;
  stopWatchingAccount = useStore.subscribe(state => {
    if (accountScope(state) !== check.scope) finishOperation(check);
  });
  return version;
}

function finishOperation(check: EnvironmentCheck) {
  if (operation !== check) return;
  const refreshRelated = check.wasPreparing || check.selectionChanged;
  window.clearTimeout(pollTimer);
  stopWatchingAccount?.();
  stopWatchingAccount = undefined;
  operation = undefined;
  operationVersion++;
  check.wasPreparing = false;
  check.selectionChanged = false;
  check.cancelling = false;
  publishOperation();
  if (refreshRelated && accountScope(useStore.getState()) === check.scope) for (const other of checks.values()) {
    if (other !== check && other.family === check.family && other.scope === check.scope) {
      other.checkedAt = -Infinity;
      if (other.listeners.size) void other.refresh(true);
    }
  }
}

function pollOperation(check: EnvironmentCheck) {
  const version = operationVersion;
  window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(async () => {
    if (version !== operationVersion) return;
    try {
      const state = await comfyEnvironment("status", check.endpoint, undefined, undefined, check.mode);
      if (version !== operationVersion) return;
      check.update({ environment: state, error: "" });
      if (!preparing(state)) { finishOperation(check); return; }
    } catch (error) {
      if (version !== operationVersion) return;
      check.update({ error: String(error) });
    }
    pollOperation(check);
  }, 1000);
}

class EnvironmentCheck {
  readonly family;
  readonly listeners = new Set<Listener>();
  readonly createdAt = performance.now();
  checkedAt = -Infinity;
  wasPreparing = false;
  selectionChanged = false;
  cancelling = false;
  private revision = 0;
  private state = initial;
  private snapshot = initial;
  constructor(readonly scope: string, readonly mode: ComfyEnvironmentMode, readonly endpoint: string, readonly directory?: string) {
    this.family = mode === "image" || mode === "edit" ? "image" : "video";
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: Listener) => {
    if (![...checks.values()].some(check => check.listeners.size)) window.addEventListener("focus", scheduleFocus);
    this.listeners.add(listener);
    void this.refresh();
    return () => {
      this.listeners.delete(listener);
      if ([...checks.values()].some(check => check.listeners.size)) return;
      window.removeEventListener("focus", scheduleFocus);
      window.clearTimeout(focusTimer);
      lastFocus = -Infinity;
    };
  };

  publish() {
    const active = operation?.scope === this.scope ? operation : undefined;
    const related = active?.family === this.family ? active : undefined;
    const progress = related && related !== this && preparing(related.state.environment) ? related.state.environment : undefined;
    const snapshot = {
      environment: progress || this.state.environment,
      error: progress ? related?.state.error ?? "" : this.state.error,
      checking: !related && this.state.checking,
      acting: !!active && !progress,
      canCancel: !!related && preparing(related.state.environment),
      cancelling: related?.cancelling ?? false,
    };
    const previous = this.snapshot;
    if (previous.environment === snapshot.environment && previous.error === snapshot.error &&
        previous.checking === snapshot.checking && previous.acting === snapshot.acting &&
        previous.canCancel === snapshot.canCancel && previous.cancelling === snapshot.cancelling) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  update(patch: Partial<Snapshot>) {
    this.state = { ...this.state, ...patch };
    if (operation === this) publishOperation();
    else this.publish();
  }

  refresh = async (force = false) => {
    if (operation?.family === this.family && operation.scope === this.scope) return;
    if (Number.isFinite(this.checkedAt) && (this.state.checking || (!force && performance.now() - this.checkedAt < refreshInterval))) return;
    this.checkedAt = performance.now();
    const revision = ++this.revision;
    this.update({ checking: true });
    try {
      const environment = await comfyEnvironment("detect", this.endpoint, this.directory, undefined, this.mode);
      if (revision !== this.revision) return;
      this.update({ environment, error: "", checking: false });
      if (!operation && accountScope(useStore.getState()) === this.scope && preparing(environment)) {
        beginOperation(this);
        this.wasPreparing = true;
        publishOperation();
        pollOperation(this);
      }
    } catch (error) {
      if (revision === this.revision) this.update({ error: String(error), checking: false });
    }
  };

  async run(action: Action, existingDirectory?: string, openDriver?: (url: string) => Promise<void>) {
    if (action === "cancel") {
      const owner = operation;
      if (!owner || owner.scope !== this.scope || owner.family !== this.family || owner.cancelling
        || accountScope(useStore.getState()) !== this.scope || !preparing(owner.state.environment)) return;
      const version = operationVersion;
      owner.cancelling = true;
      owner.update({ error: "" });
      try {
        // Different modes can show the same progress. Native cancellation belongs to the mode that started it.
        await comfyEnvironment("cancel", owner.endpoint, owner.directory, undefined, owner.mode);
      } catch (error) {
        if (version !== operationVersion) return;
        owner.cancelling = false;
        owner.update({ error: userErrorMessage(error, "暂时无法取消本机环境操作，请重试。") });
      }
      return;
    }
    if (operation || accountScope(useStore.getState()) !== this.scope) return;
    const version = beginOperation(this);
    ++this.revision;
    this.update({ error: "", checking: false });
    try {
      const state = await comfyEnvironment(action, this.endpoint, this.directory, existingDirectory, this.mode);
      if (version !== operationVersion) return;
      this.checkedAt = performance.now();
      this.selectionChanged = action === "select_existing";
      this.update({ environment: state });
      if (preparing(state)) {
        this.wasPreparing = true;
        pollOperation(this);
        return;
      }
      if (action === "driver" && state.driverDownload) await openDriver?.(state.driverDownload.url);
    } catch (error) {
      if (version !== operationVersion) return;
      const previous = this.state.environment;
      if (previous && action !== "select_existing") {
        this.update({ environment: { ...previous, phase: "failed", message: String(error) } });
      } else this.update({ error: String(error) });
    } finally {
      if (version === operationVersion && !this.wasPreparing) finishOperation(this);
    }
  }
}

export function useComfyEnvironment(mode: ComfyEnvironmentMode, endpoint: string, directory?: string) {
  const scope = useStore(accountScope);
  const check = useMemo(() => {
    const key = JSON.stringify([scope, mode, endpoint, directory]);
    let existing = checks.get(key);
    if (!existing) {
      for (const [oldKey, old] of checks) {
        if (old !== operation && !old.listeners.size &&
            performance.now() - Math.max(old.createdAt, old.checkedAt) > refreshInterval) checks.delete(oldKey);
      }
      existing = new EnvironmentCheck(scope, mode, endpoint, directory);
      checks.set(key, existing);
      existing.publish();
    }
    return existing;
  }, [scope, mode, endpoint, directory]);
  return { ...useSyncExternalStore(check.subscribe, check.getSnapshot), check };
}
