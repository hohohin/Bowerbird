export type HtmlLayoutRenderPhase =
  | "prepare_inputs"
  | "compose_html_document"
  | "render_once"
  | "awaiting_user_review"
  | "exporting"
  | "succeeded"
  | "failed"
  | "cancelled";

export type HtmlLayoutRenderEvent =
  | "inputs_prepared"
  | "html_composed"
  | "render_completed"
  | "user_accepted"
  | "user_discarded"
  | "export_completed"
  | "failed"
  | "cancelled";

const TRANSITIONS: Readonly<Record<HtmlLayoutRenderPhase, Partial<Record<HtmlLayoutRenderEvent, HtmlLayoutRenderPhase>>>> = {
  prepare_inputs: { inputs_prepared: "compose_html_document", failed: "failed", cancelled: "cancelled" },
  compose_html_document: { html_composed: "render_once", failed: "failed", cancelled: "cancelled" },
  render_once: { render_completed: "awaiting_user_review", failed: "failed", cancelled: "cancelled" },
  awaiting_user_review: { user_accepted: "exporting", user_discarded: "cancelled", cancelled: "cancelled" },
  exporting: { export_completed: "succeeded", failed: "failed" },
  succeeded: {},
  failed: {},
  cancelled: {},
};

export function nextHtmlLayoutRenderPhase(phase: HtmlLayoutRenderPhase, event: HtmlLayoutRenderEvent): HtmlLayoutRenderPhase {
  const next = TRANSITIONS[phase][event];
  if (!next) throw new Error(`html_layout_phase_transition_denied:${phase}:${event}`);
  return next;
}
