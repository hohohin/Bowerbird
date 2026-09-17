import { useMemo } from "react";
import { GenerationPanel } from "./GenerationPanel";
import type { GenJob } from "../lib/types";
import type { canvasConversationTurns } from "../lib/canvasConversation";

export function CanvasConversation({ turns, selectedId, onReuse }: {
  turns: ReturnType<typeof canvasConversationTurns>;
  selectedId: string;
  onReuse: (node: ReturnType<typeof canvasConversationTurns>[number]["node"]) => void;
}) {
  // A presentation-only job: never insert it into task state or reuse a provider session.
  const job = useMemo<GenJob | null>(() => {
    const first = turns[0];
    if (!first) return null;
    return { id: `canvas-snapshot:${first.node.threadId ?? first.node.id}`, projectId: first.node.projectId,
      threadId: first.node.threadId, sessionId: null, running: false, streaming: "", provider: first.provider,
      createdAt: first.node.createdAt, lastPrompt: first.text, lastRefs: first.references.flatMap(a => a.store_path ? [a.store_path] : []),
      refAssets: first.references, lastRatio: first.ratio,
      turns: turns.map((turn, index) => ({ id: index + 1, turnKey: turn.node.id, media: "image",
        prompt: turn.appliedPrompt, promptRaw: turn.text, appliedPrompt: turn.appliedPrompt, provider: turn.provider,
        ratio: turn.ratio, refs: turn.references.flatMap(a => a.store_path ? [a.store_path] : []),
        refAssets: turn.references, referenceNodeIds: turn.referenceNodeIds,
        images: turn.outputs.flatMap(a => a.store_path ? [a.store_path] : []) })) };
  }, [turns]);
  if (!job) return null;
  return <GenerationPanel embedded hydratedAssets={turns.flatMap(turn => [...turn.references, ...turn.outputs])}
    snapshot={{ job, selectedTurnKey: selectedId, onReuse: turn => {
      const source = turns.find(item => item.node.id === turn.turnKey);
      if (source) onReuse(source.node);
    } }} />;
}
