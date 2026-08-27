import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  AgentControlClient,
  type ClaimedArtifact,
  type RegisteredAgentArtifact,
} from "../control-plane/agent-control-client.ts";

export type WorkspaceImage = {
  mime: "image/png" | "image/jpeg" | "image/webp";
  bytes: Uint8Array;
  sha256: string;
};

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** HTML 文档 artifact 上限（与 html-renderer maxHtmlBytes 一致）。 */
const MAX_HTML_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const ORPHAN_WORKSPACE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/** Remove only old, per-Run directories created beneath the configured workspace root. */
export function cleanupOrphanWorkspaces(
  rootPath: string,
  maxAgeMs = ORPHAN_WORKSPACE_MAX_AGE_MS,
  nowMs = Date.now(),
): number {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw new Error("agent_workspace_cleanup_age_invalid");
  const root = resolve(rootPath);
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9-]{1,80}$/.test(entry.name)) continue;
    const path = resolve(root, entry.name);
    if (path === root || !path.startsWith(`${root}\\`) && !path.startsWith(`${root}/`)) continue;
    const ageMs = nowMs - statSync(path).mtimeMs;
    if (ageMs < maxAgeMs) continue;
    rmSync(path, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

function imageMime(bytes: Uint8Array): WorkspaceImage["mime"] | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

function extension(mime: WorkspaceImage["mime"]): string {
  return mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
}

function checkedImage(bytes: Uint8Array, expected?: Pick<ClaimedArtifact, "mime" | "bytes" | "sha256">): WorkspaceImage {
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("agent_workspace_image_size_invalid");
  const mime = imageMime(bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (!mime || (expected && (mime !== expected.mime || bytes.byteLength !== expected.bytes || sha256 !== expected.sha256))) {
    throw new Error("agent_workspace_image_validation_failed");
  }
  return { mime, bytes, sha256 };
}

/** Per-Run filesystem boundary. Images are downloaded only on approved execution. */
export class RunWorkspace {
  readonly path: string;
  private readonly control: AgentControlClient;
  private readonly remote = new Map<string, ClaimedArtifact>();
  private readonly local = new Map<string, { path: string; image: WorkspaceImage }>();
  private readonly localHtml = new Map<string, { path: string; html: string; sha256: string }>();

  constructor(args: {
    root: string;
    runId: string;
    control: AgentControlClient;
    artifacts?: ClaimedArtifact[];
  }) {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(args.runId)) throw new Error("agent_workspace_run_id_invalid");
    const root = resolve(args.root);
    const path = resolve(root, args.runId);
    if (path === root || !path.startsWith(`${root}\\`) && !path.startsWith(`${root}/`)) {
      throw new Error("agent_workspace_path_escape");
    }
    mkdirSync(join(path, "inputs"), { recursive: true });
    mkdirSync(join(path, "outputs"), { recursive: true });
    this.path = path;
    this.control = args.control;
    for (const artifact of args.artifacts ?? []) this.remote.set(artifact.artifactId, artifact);
  }

  async readArtifact(artifactId: string): Promise<WorkspaceImage> {
    const existing = this.local.get(artifactId);
    if (existing && existsSync(existing.path)) return checkedImage(new Uint8Array(readFileSync(existing.path)));
    const artifact = this.remote.get(artifactId);
    if (!artifact?.url) throw new Error("agent_workspace_artifact_url_missing");
    const bytes = await this.control.downloadVerifiedBytes(artifact.url, artifact);
    const image = checkedImage(bytes, artifact);
    const path = join(this.path, artifact.role === "input" ? "inputs" : "outputs", `${artifact.artifactId}.${extension(image.mime)}`);
    writeFileSync(path, image.bytes);
    this.local.set(artifactId, { path, image });
    return image;
  }

  /** 读取 role=html_document 的 artifact 为受验文本（≤2MiB、严格 UTF-8、sha 复核）。 */
  async readHtmlDocumentArtifact(artifactId: string): Promise<string> {
    const cached = this.localHtml.get(artifactId);
    if (cached && existsSync(cached.path)) {
      const bytes = new Uint8Array(readFileSync(cached.path));
      if (createHash("sha256").update(bytes).digest("hex") !== cached.sha256) throw new Error("agent_workspace_html_hash_mismatch");
      return cached.html;
    }
    const artifact = this.remote.get(artifactId);
    if (!artifact?.url) throw new Error("agent_workspace_artifact_url_missing");
    if (artifact.role !== "html_document") throw new Error("agent_workspace_html_role_invalid");
    if (artifact.mime !== "text/html") throw new Error("agent_workspace_html_mime_invalid");
    const bytes = await this.control.downloadVerifiedBytes(artifact.url, artifact, MAX_HTML_DOCUMENT_BYTES + 1);
    if (!bytes.byteLength || bytes.byteLength > MAX_HTML_DOCUMENT_BYTES) throw new Error("agent_workspace_html_size_invalid");
    let html: string;
    try {
      html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("agent_workspace_html_utf8_invalid");
    }
    const path = join(this.path, "inputs", `${artifactId}.html`);
    writeFileSync(path, bytes);
    this.localHtml.set(artifactId, { path, html, sha256: artifact.sha256 });
    return html;
  }

  writeProviderResult(callId: string, bytes: Uint8Array): WorkspaceImage {
    if (!/^[0-9a-f]{64}$/.test(callId)) throw new Error("agent_workspace_call_id_invalid");
    const image = checkedImage(bytes);
    const path = join(this.path, "outputs", `${callId}.${extension(image.mime)}`);
    writeFileSync(path, image.bytes);
    this.local.set(`call:${callId}`, { path, image });
    return image;
  }

  providerResult(callId: string): WorkspaceImage | null {
    const existing = this.local.get(`call:${callId}`);
    if (!existing || !existsSync(existing.path)) return null;
    return checkedImage(new Uint8Array(readFileSync(existing.path)));
  }

  rememberArtifact(callId: string, artifact: RegisteredAgentArtifact, image: WorkspaceImage): void {
    const pending = this.local.get(`call:${callId}`);
    if (pending) this.local.set(artifact.artifactId, pending);
    this.remote.set(artifact.artifactId, artifact);
    if (!this.local.has(artifact.artifactId)) {
      const path = join(this.path, "outputs", `${artifact.artifactId}.${extension(image.mime)}`);
      writeFileSync(path, image.bytes);
      this.local.set(artifact.artifactId, { path, image });
    }
  }

  rememberRemoteArtifact(artifact: RegisteredAgentArtifact): void {
    this.remote.set(artifact.artifactId, artifact);
  }

  cleanup(): void {
    const resolvedPath = resolve(this.path);
    if (!resolvedPath || resolvedPath.length < 8) throw new Error("agent_workspace_cleanup_path_invalid");
    rmSync(resolvedPath, { recursive: true, force: true });
    this.local.clear();
    this.localHtml.clear();
  }
}
