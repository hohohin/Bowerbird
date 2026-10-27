import { CreationBoard } from "./CreationBoard";
import type { CreativePromptLoadRequest } from "../lib/creativeLaunch";
import { useEffect, useRef, useState } from "react";
import { parseCreativeComposerState, serializeCreativeComposerState, type CreativeComposerMode } from "../lib/creativeDraft";
import type { CreationEditorDraft } from "./creation/useCreationEditor";
import type { Asset } from "../lib/types";
import type { CreativeParentCandidate, CreativeThreadResolution } from "../lib/creativeGeneration";
import type { ComposerLocalVideoRequest } from "../lib/comfyVideo";

export function CreativeComposer({
  projectId,
  draftJson,
  initialAssetIds = [],
  continuationCandidates = [],
  focusedContinuationNodeId = null,
  focusedContinuationThreadId = null,
  promptLoadRequest = null,
  onPromptLoadConsumed,
  onDraftChange,
  onOpenLibrary,
  registerDraftFlush,
  beforeGenerate,
  onGenerateLocalVideo,
  onSendChat,
  onChatDraftSent,
  onOpenChatHistory,
  chatHistoryOpen,
  resolveCreativeThread,
}: {
  projectId: string;
  draftJson: string;
  initialAssetIds?: string[];
  continuationCandidates?: CreativeParentCandidate[];
  focusedContinuationNodeId?: string | null;
  focusedContinuationThreadId?: string | null;
  promptLoadRequest?: CreativePromptLoadRequest | null;
  onPromptLoadConsumed?: (requestId: string) => void;
  onDraftChange: (draftJson: string) => void;
  onOpenLibrary?: () => void;
  registerDraftFlush?: (flush: (() => void) | null) => void;
  beforeGenerate?: () => Promise<void>;
  onGenerateLocalVideo?: (request: ComposerLocalVideoRequest) => Promise<void>;
  onSendChat?: (request: { prompt: string; references: Asset[] }) => Promise<void>;
  onChatDraftSent?: (sentDraftJson: string) => void;
  onOpenChatHistory?: () => void;
  chatHistoryOpen?: boolean;
  resolveCreativeThread: (
    parentAssetId: string | null,
    prompt: string,
    routeRevision?: number,
    continuationRequestId?: string | null,
    parentNodeId?: string | null,
  ) => Promise<CreativeThreadResolution>;
}) {
  const stateRef = useRef(parseCreativeComposerState(draftJson));
  const [mode, setMode] = useState(stateRef.current.mode);
  const flushRef = useRef<(() => void) | null>(null);
  function persist(draft: CreationEditorDraft) {
    stateRef.current.drafts[mode] = draft;
    onDraftChange(serializeCreativeComposerState(stateRef.current));
  }
  function selectMode(next: CreativeComposerMode) {
    if (next === mode) return;
    flushRef.current?.();
    stateRef.current.mode = next;
    onDraftChange(serializeCreativeComposerState(stateRef.current));
    setMode(next);
  }
  useEffect(() => {
    if (promptLoadRequest) selectMode(promptLoadRequest.generation?.media === "video" ? "video" : "image");
  }, [promptLoadRequest?.id]);
  const currentDraft = stateRef.current.drafts[mode];
  const seedDraft: CreationEditorDraft = currentDraft ?? {
    doc: { type: "doc", content: [{ type: "paragraph" }] }, refs: [],
    generation: { media: mode === "video" ? "video" : "image" },
  };
  return (
    <CreationBoard
      key={mode}
      embedded
      projectId={projectId}
      initialDraft={seedDraft}
      initialAssetIds={currentDraft ? [] : initialAssetIds}
      composerMode={mode}
      onComposerModeChange={selectMode}
      continuationCandidates={continuationCandidates}
      focusedContinuationNodeId={focusedContinuationNodeId}
      focusedContinuationThreadId={focusedContinuationThreadId}
      promptLoadRequest={promptLoadRequest && mode === (promptLoadRequest.generation?.media === "video" ? "video" : "image") ? promptLoadRequest : null}
      onPromptLoadConsumed={onPromptLoadConsumed}
      onDraftChange={persist}
      onOpenLibrary={onOpenLibrary}
      onOpenChatHistory={onOpenChatHistory}
      chatHistoryOpen={chatHistoryOpen}
      registerDraftFlush={(flush) => { flushRef.current = flush; registerDraftFlush?.(flush); }}
      beforeGenerate={beforeGenerate}
      onGenerateLocalVideo={onGenerateLocalVideo}
      onSendChat={onSendChat ? async request => {
        flushRef.current?.();
        const sentDraft = JSON.stringify(stateRef.current.drafts.chat);
        await onSendChat(request);
        onChatDraftSent?.(sentDraft);
      } : undefined}
      resolveCreativeThread={resolveCreativeThread}
    />
  );
}
