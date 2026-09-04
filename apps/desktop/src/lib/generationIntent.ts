export type GenerationComposerMode = "edit" | "revise";

export interface GenerationComposerIntent {
  token: number;
  jobId: string;
  mode: GenerationComposerMode;
}

export interface GenerationComposerIntentState {
  token: number;
  activeJobId: string | null;
  mode: GenerationComposerMode | null;
}

export interface GenerationSubmissionAuthority {
  provider: string;
  visualProfileId: string | null;
}

/** Provider and visual profile are billing/output authority, not late-bound UI
 * preferences. Freeze them at the same click boundary as prompt and refs. */
export function captureGenerationSubmissionAuthority(
  state: GenerationSubmissionAuthority,
): GenerationSubmissionAuthority {
  return {
    provider: state.provider,
    visualProfileId: state.visualProfileId,
  };
}

export function isGenerationComposerIntentCurrent(
  intent: GenerationComposerIntent,
  current: GenerationComposerIntentState,
): boolean {
  return (
    intent.token === current.token &&
    intent.jobId === current.activeJobId &&
    intent.mode === current.mode
  );
}

export async function awaitGenerationComposerIntent<T>(
  intent: GenerationComposerIntent,
  readCurrent: () => GenerationComposerIntentState,
  operation: () => Promise<T>,
): Promise<{ current: true; value: T } | { current: false }> {
  const value = await operation();
  return isGenerationComposerIntentCurrent(intent, readCurrent())
    ? { current: true, value }
    : { current: false };
}
