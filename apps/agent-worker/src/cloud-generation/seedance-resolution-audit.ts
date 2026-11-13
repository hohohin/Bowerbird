import { VIDEO_RESOLUTIONS } from "../../../cloud/supabase/functions/_shared/video-contract.ts";

export const SEEDANCE_SPEC_URL = "https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh";
export const SEEDANCE_AUDIT_INTERVAL = 24 * 60 * 60 * 1000;
const MAX_SPEC_BYTES = 4 * 1024 * 1024;

/** Read only the resolution enum, not examples, other models, or embedded page scripts. */
export function seedanceDocumentResolutions(html: string): string[] {
  const text = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;|&#8203;/gi, " ").replace(/[\s\u200b]+/g, " ");
  const section = /通过\s+resolution\s+参数指定输出视频的分辨率。[\s\S]{0,120}?可选值[：:]([\s\S]{0,700}?)(?:说明|宽高比)/.exec(text)?.[1];
  if (!section) throw new Error("seedance_spec_unrecognized");
  const values = [...new Set(section.match(/\b\d{3,4}p\b|\b[248]k\b/gi) ?? [])].map(value => value.toLowerCase()).sort();
  if (!values.length) throw new Error("seedance_spec_unrecognized");
  return values;
}

type AuditFetch = (url: string, init: { method: string; redirect: "error"; signal: AbortSignal }) => Promise<Response>;

/** Monitoring only: failures or changed documentation never alter validation, pricing or UI options. */
export function createSeedanceResolutionAudit(options: {
  fetch?: AuditFetch; now?: () => number; log?: (record: Record<string, unknown>) => void;
} = {}) {
  const request = options.fetch ?? fetch, now = options.now ?? Date.now;
  const log = options.log ?? (record => console.log(JSON.stringify(record)));
  let lastAttempt = -Infinity, running = false;
  return async () => {
    const checkedAt = now();
    if (running || checkedAt - lastAttempt < SEEDANCE_AUDIT_INTERVAL) return;
    running = true; lastAttempt = checkedAt;
    const expected = [...VIDEO_RESOLUTIONS].sort();
    try {
      const response = await request(SEEDANCE_SPEC_URL, { method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("seedance_spec_http_failed");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("seedance_spec_stream_missing");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > MAX_SPEC_BYTES) throw new Error("seedance_spec_too_large");
          chunks.push(part.value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const observed = seedanceDocumentResolutions(new TextDecoder().decode(bytes));
      log({ event: "seedance_resolution_audit", status: JSON.stringify(observed) === JSON.stringify(expected) ? "unchanged" : "changed",
        checkedAt, source: SEEDANCE_SPEC_URL, expected, observed });
    } catch (error) {
      const code = error instanceof Error && /^seedance_spec_\w+$/.test(error.message) ? error.message : "seedance_spec_unavailable";
      log({ event: "seedance_resolution_audit", status: "unavailable", checkedAt, source: SEEDANCE_SPEC_URL, expected, error: code });
    } finally { running = false; }
  };
}

export function startSeedanceResolutionAudit() {
  const check = createSeedanceResolutionAudit();
  void check();
  const timer = setInterval(() => { void check(); }, SEEDANCE_AUDIT_INTERVAL) as { unref?: () => void };
  timer.unref?.();
}
