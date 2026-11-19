import { create } from "zustand";
import { useStore } from "../store";
import { canvasWorkflowController, type CanvasWorkflowController } from "./canvasWorkflowRuntime";
import { notifyGenerationComplete } from "./generationNotifications";
import { useLocalChatStore } from "./localChatStore";
import { libraryLocalVideoRun, libraryLocalVideoTask, type LibraryActivityTask, type LibraryLocalVideoLocator } from "./libraryGenerationActivity";

const STORAGE_KEY = "bowerbird.libraryLocalVideo.v1";
const liveLocators = new Set<string>();
const locatorKey = (locator: LibraryLocalVideoLocator) => `${locator.projectId}:${locator.nodeId}`;
function readLocators(): LibraryLocalVideoLocator[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is LibraryLocalVideoLocator => item && typeof item.projectId === "string"
      && typeof item.nodeId === "string" && Number.isFinite(item.createdAt)).slice(-50)
      .map(({ projectId, nodeId, createdAt }) => ({ projectId, nodeId, createdAt }));
  } catch { return []; }
}
export const useLibraryGenerationRuntime = create<{
  locators: LibraryLocalVideoLocator[];
  tasks: Record<string, LibraryActivityTask>;
}>(() => ({ locators: readLocators(), tasks: {} }));

/** Store only a locator; the workflow remains the authority for inputs and execution. */
export function registerLibraryLocalVideo(projectId: string, nodeId: string) {
  const locator = { projectId, nodeId, createdAt: Date.now() };
  const key = locatorKey(locator);
  liveLocators.add(key);
  const locators = [...useLibraryGenerationRuntime.getState().locators.filter(item => locatorKey(item) !== key), locator].slice(-50);
  const trackedKeys = new Set(locators.map(locatorKey));
  for (const tracked of liveLocators) if (!trackedKeys.has(tracked)) liveLocators.delete(tracked);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(locators)); } catch { /* The current task remains observable without storage. */ }
  useLibraryGenerationRuntime.setState(state => ({ locators,
    tasks: Object.fromEntries(Object.entries(state.tasks).filter(([id]) => trackedKeys.has(id))),
  }));
}

export function openLibraryActivityTask(task: Pick<LibraryActivityTask, "projectId" | "threadId" | "nodeId">) {
  useStore.setState({ creativeNavigation: { projectId: task.projectId, threadId: task.threadId, nodeId: task.nodeId },
    genPanelOpen: false, boardOpen: false, detailAssetId: null });
}

function complete(key: string, message: string, task: Pick<LibraryActivityTask, "projectId" | "threadId" | "nodeId">) {
  const state = useStore.getState();
  state.markProjectThreadUnread(task.projectId, task.threadId);
  void notifyGenerationComplete(key, message, state.settings, {
    projectName: state.projects.find(project => project.id === task.projectId)?.name,
    onOpen: () => openLibraryActivityTask(task),
  });
}

function publishLocalVideo(key: string, task: LibraryActivityTask | null) {
  useLibraryGenerationRuntime.setState(state => {
    if (!state.locators.some(locator => locatorKey(locator) === key)) return state;
    if (task) return { tasks: { ...state.tasks, [key]: task } };
    if (!(key in state.tasks)) return state;
    const tasks = { ...state.tasks };
    delete tasks[key];
    return { tasks };
  });
}

interface VideoObserver { alive: boolean; observedRunning: boolean; checking: boolean }

async function confirmLocalVideo(controller: CanvasWorkflowController, locator: LibraryLocalVideoLocator, observer: VideoObserver) {
  const key = locatorKey(locator);
  try {
    // A controller emits optimistic edits before its serialized durable write finishes.
    await controller.flush();
    if (!observer.alive) return;
    const task = libraryLocalVideoTask(locator, controller.document, controller.error);
    if (!task) { publishLocalVideo(key, null); return; }
    publishLocalVideo(key, task);
    if (task.status !== "completed" || !observer.observedRunning) return;
    observer.observedRunning = false; liveLocators.delete(key);
    const run = libraryLocalVideoRun(controller.document, locator.nodeId);
    complete(`library-h3:${key}:${run?.id}`, "本机视频生成完成", task);
  } catch {
    if (!observer.alive) return;
    const failed = libraryLocalVideoTask(locator, controller.document, "save-failed");
    if (failed) publishLocalVideo(key, failed);
  } finally { observer.checking = false; }
}

export function observeLibraryLocalVideo(locator: LibraryLocalVideoLocator) {
  const controller = canvasWorkflowController(locator.projectId);
  const key = locatorKey(locator);
  const observer: VideoObserver = { alive: true, observedRunning: liveLocators.has(key), checking: false };
  const update = () => {
    if (!controller.ready || !observer.alive) return;
    const task = libraryLocalVideoTask(locator, controller.document, controller.error);
    if (!task) { publishLocalVideo(key, null); return; }
    if (task.status === "running") observer.observedRunning = true;
    if (task.status !== "completed") { publishLocalVideo(key, task); return; }
    if (observer.checking) return;
    observer.checking = true;
    void confirmLocalVideo(controller, locator, observer);
  };
  const unsubscribe = controller.subscribe(update);
  void controller.load().then(update);
  update();
  return () => { observer.alive = false; unsubscribe(); };
}

export function observeLibraryChatCompletion() {
  return useLocalChatStore.subscribe((state, previous) => {
    for (const chat of Object.values(state.summaries)) {
      const before = previous.summaries[chat.id];
      if (!before || before.status !== "running" || chat.status !== "idle" || chat.revision <= before.revision) continue;
      complete(`library-chat:${chat.id}:${chat.revision}`, "对话已回复", chat);
    }
  });
}
