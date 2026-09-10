export const ONBOARDING_KEY = "bowerbird.onboarding.v2";
export type LessonStatus = "new" | "active" | "paused" | "skipped" | "completed";
export interface OnboardingProgress {
  version: 2;
  status: LessonStatus;
  step: number;
  projectId: string | null;
  sampleProjectId: string | null;
  startedAt: number;
  jobId: string | null;
  outcome: "prepared" | "generated" | null;
  updateSeen: boolean;
  dismissed: string[];
  skippedSteps: number[];
}
export const freshOnboarding = (): OnboardingProgress => ({
  version: 2, status: "new", step: 1, projectId: null, sampleProjectId: null,
  startedAt: 0, jobId: null, outcome: null, updateSeen: false, dismissed: [], skippedSteps: [],
});
export function parseOnboarding(raw: string | null): OnboardingProgress {
  try {
    const p = JSON.parse(raw ?? "null");
    if (p?.version !== 2 || !["new", "active", "paused", "skipped", "completed"].includes(p.status)
      || !Number.isInteger(p.step) || p.step < 1 || p.step > 6) return freshOnboarding();
    const id = (value: unknown) => typeof value === "string" && value.length > 0 ? value : null;
    // The former sixth step (continue editing) now resumes at the final generation step.
    return { ...freshOnboarding(), status: p.status === "active" ? "paused" : p.status, step: Math.min(p.step, 5),
      projectId: id(p.projectId), sampleProjectId: id(p.sampleProjectId), jobId: id(p.jobId),
      startedAt: Number.isFinite(p.startedAt) ? p.startedAt : 0,
      outcome: ["prepared", "generated"].includes(p.outcome) ? p.outcome : null,
      updateSeen: p.updateSeen === true,
      dismissed: Array.isArray(p.dismissed) ? p.dismissed.filter((v: unknown) => typeof v === "string") : [],
      skippedSteps: Array.isArray(p.skippedSteps) ? p.skippedSteps.filter((v: unknown) => v === 4) : [],
    };
  } catch { return freshOnboarding(); }
}
export interface LessonEvidence {
  onProject: boolean;
  hasCard: boolean;
  movedCard: boolean;
  hasText: boolean;
  hasReference: boolean;
  hasDimension: boolean;
  generated: boolean;
}
export function nextLessonStep(step: number, e: LessonEvidence) {
  if (!e.onProject) return step;
  const completed = [false, e.hasCard, e.movedCard, e.hasText && e.hasReference,
    e.hasText && e.hasReference && e.hasDimension, e.generated];
  return completed[step] ? Math.min(6, step + 1) : step;
}
