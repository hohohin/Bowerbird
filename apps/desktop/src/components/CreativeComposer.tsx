import { CreationBoard } from "./CreationBoard";
import type { CreativePromptLoadRequest } from "../lib/creativeLaunch";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { parseCreativeComposerState, serializeCreativeComposerState, type CreativeComposerMode } from "../lib/creativeDraft";
import type { CreationEditorDraft } from "./creation/useCreationEditor";
import type { CreativeParentCandidate, CreativeThreadResolution } from "../lib/creativeGeneration";
import type { ComposerLocalVideoRequest } from "../lib/comfyVideo";
import type { ChatCodexOptions, ChatComposeRequest, ChatProvider } from "../lib/localChat";

export function CreativeComposer({
  projectId,
  header,
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
  prepareProject,
  onGenerationSubmitted,
  onGenerateLocalVideo,
  onOptimizeLocalVideo,
  onSendChat,
  onChatDraftSent,
  onOpenChatHistory,
  chatHistoryOpen,
  resolveCreativeThread,
}: {
  projectId?: string;
  header?: ReactNode;
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
  prepareProject?: () => Promise<string>;
  onGenerationSubmitted?: (projectId: string, threadId?: string | null, nodeId?: string | null) => void;
  onGenerateLocalVideo?: (request: ComposerLocalVideoRequest, projectId?: string) => Promise<void>;
  onOptimizeLocalVideo?: (request: ComposerLocalVideoRequest, projectId?: string) => Promise<string>;
  onSendChat?: (request: ChatComposeRequest, projectId?: string) => Promise<void>;
  onChatDraftSent?: (sentDraftJson: string) => void;
  onOpenChatHistory?: () => void;
  chatHistoryOpen?: boolean;
  resolveCreativeThread: (
    parentAssetId: string | null,
    prompt: string,
    routeRevision?: number,
    continuationRequestId?: string | null,
    parentNodeId?: string | null,
    projectId?: string,
  ) => Promise<CreativeThreadResolution>;
}) {
  const stateRef = useRef(parseCreativeComposerState(draftJson));
  const [mode, setMode] = useState(stateRef.current.mode);
  const [chatProvider, setChatProvider] = useState<ChatProvider>(stateRef.current.chatProvider ?? "codex-local");
  const [chatCodexOptions, setChatCodexOptions] = useState<ChatCodexOptions | undefined>(stateRef.current.chatCodexOptions);
  const [chatDshSkill, setChatDshSkill] = useState(stateRef.current.chatDshSkill);
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
      header={header}
      projectId={projectId}
      initialDraft={seedDraft}
      initialAssetIds={currentDraft ? [] : initialAssetIds}
      composerMode={mode}
      onComposerModeChange={selectMode}
      chatProvider={chatProvider}
      chatCodexOptions={chatCodexOptions}
      chatDshSkill={chatDshSkill}
      onChatDshSkillChange={skill => { flushRef.current?.(); stateRef.current.chatDshSkill = skill; setChatDshSkill(skill); onDraftChange(serializeCreativeComposerState(stateRef.current)); }}
      onChatCodexOptionsChange={options => { flushRef.current?.(); stateRef.current.chatCodexOptions = options; setChatCodexOptions(options); onDraftChange(serializeCreativeComposerState(stateRef.current)); }}
      onChatProviderChange={provider => {
        flushRef.current?.();
        stateRef.current.chatProvider = provider; setChatProvider(provider);
        if (provider !== "dsh-cloud") { stateRef.current.chatDshSkill = undefined; setChatDshSkill(undefined); }
        onDraftChange(serializeCreativeComposerState(stateRef.current));
      }}
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
      prepareProject={prepareProject}
      onGenerationSubmitted={onGenerationSubmitted}
      onGenerateLocalVideo={onGenerateLocalVideo}
      onOptimizeLocalVideo={onOptimizeLocalVideo}
      onSendChat={onSendChat ? async (request, targetProjectId, sentDraft) => {
        await onSendChat(request, targetProjectId);
        if (sentDraft) onChatDraftSent?.(sentDraft);
      } : undefined}
      resolveCreativeThread={resolveCreativeThread}
    />
  );
}
