import type { TextDocumentDestination, TextWorkspaceDocument } from "./documentTypes";

const requests = new Map<string, string>();
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Keep retry identity outside the mounted editor, without storing document text in the key. */
export async function textWorkspaceRequestId(document: TextWorkspaceDocument, destination: TextDocumentDestination): Promise<string> {
  const target = destination.kind === "collection" ? ["collection", destination.folderId] : ["project", destination.projectId];
  const bytes = new TextEncoder().encode(JSON.stringify([document.title, document.markdown, target]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const key = `bowerbird.text-save.v1.${hash}`;
  let id = requests.get(key);
  if (!id) {
    try { const saved = sessionStorage.getItem(key); if (saved && UUID.test(saved)) id = saved; } catch { /* The process-local identity remains available. */ }
  }
  id ??= crypto.randomUUID();
  requests.set(key, id);
  try { sessionStorage.setItem(key, id); } catch { /* The process-local identity remains available. */ }
  return id;
}
