import { useStore } from "../store";
import { notifyGenerationComplete } from "./generationNotifications";
import { useLocalChatStore } from "./localChatStore";
import type { LibraryActivityTask } from "./libraryGenerationActivity";

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

export function observeLibraryChatCompletion() {
  return useLocalChatStore.subscribe((state, previous) => {
    for (const chat of Object.values(state.summaries)) {
      const before = previous.summaries[chat.id];
      if (!before || before.status !== "running" || chat.status !== "idle" || chat.revision <= before.revision) continue;
      complete(`library-chat:${chat.id}:${chat.revision}`, "对话已回复", chat);
    }
  });
}
