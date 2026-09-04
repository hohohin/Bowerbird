import { CreationBoard } from "./CreationBoard";
import { parseCreativeComposerDraft, serializeCreativeComposerDraft } from "../lib/creativeDraft";
import type { CreativeParentCandidate, CreativeThreadResolution } from "../lib/creativeGeneration";

export function CreativeComposer({
  projectId,
  draftJson,
  initialAssetIds = [],
  continuationCandidates = [],
  focusedContinuationNodeId = null,
  focusedContinuationThreadId = null,
  onDraftChange,
  registerDraftFlush,
  beforeGenerate,
  resolveCreativeThread,
}: {
  projectId: string;
  draftJson: string;
  initialAssetIds?: string[];
  continuationCandidates?: CreativeParentCandidate[];
  focusedContinuationNodeId?: string | null;
  focusedContinuationThreadId?: string | null;
  onDraftChange: (draftJson: string) => void;
  registerDraftFlush?: (flush: (() => void) | null) => void;
  beforeGenerate?: () => Promise<void>;
  resolveCreativeThread: (
    parentAssetId: string | null,
    prompt: string,
    routeRevision?: number,
    continuationRequestId?: string | null,
    parentNodeId?: string | null,
  ) => Promise<CreativeThreadResolution>;
}) {
  return (
    <CreationBoard
      embedded
      projectId={projectId}
      initialDraft={parseCreativeComposerDraft(draftJson)}
      initialAssetIds={initialAssetIds}
      continuationCandidates={continuationCandidates}
      focusedContinuationNodeId={focusedContinuationNodeId}
      focusedContinuationThreadId={focusedContinuationThreadId}
      onDraftChange={(composer) => onDraftChange(serializeCreativeComposerDraft(composer))}
      registerDraftFlush={registerDraftFlush}
      beforeGenerate={beforeGenerate}
      resolveCreativeThread={resolveCreativeThread}
    />
  );
}
