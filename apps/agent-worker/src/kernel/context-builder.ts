import type { ContextBlock } from "../contracts/model.ts";
import { canonicalJson, sha256Hex } from "./tool-ledger.ts";

const KIND_ORDER: Record<ContextBlock["kind"], number> = {
  system_policy: 0,
  phase_brief: 1,
  skill_instruction: 2,
  budget: 3,
  approval_result: 4,
  user_goal: 5,
  input_manifest: 6,
  visual_profile_capsule: 7,
  preference_capsule: 8,
  tool_result: 9,
  compaction_summary: 10,
};

const REQUIRED_KINDS = new Set<ContextBlock["kind"]>([
  "system_policy",
  "phase_brief",
  "skill_instruction",
  "budget",
  "approval_result",
  "user_goal",
  "input_manifest",
]);

const TRUST_BY_KIND: Record<ContextBlock["kind"], ReadonlySet<ContextBlock["trust"]>> = {
  system_policy: new Set(["system"]),
  phase_brief: new Set(["system"]),
  skill_instruction: new Set(["system"]),
  budget: new Set(["approved"]),
  approval_result: new Set(["approved"]),
  user_goal: new Set(["untrusted"]),
  input_manifest: new Set(["untrusted"]),
  visual_profile_capsule: new Set(["untrusted"]),
  preference_capsule: new Set(["untrusted"]),
  tool_result: new Set(["approved", "untrusted"]),
  // Kernel validates the summary structure, but compressed user/model facts
  // remain low-trust and must never be promoted into instructions.
  compaction_summary: new Set(["untrusted"]),
};

export type CompactedContextFact = { fact: string; sourceHash: string };

export type ContextBuildResult = {
  blocks: ContextBlock[];
  compactedFacts: CompactedContextFact[];
  estimatedTokens: number;
  compacted: boolean;
};

export type ContextBuildOptions = {
  maxTokens: number;
  /** systemPolicy / Skill / action schemas live outside context blocks but use the same model window. */
  reservedContent?: unknown[];
  /** Keep the newest N tool results verbatim; older results may be compacted first. */
  keepRecentToolResults?: number;
};

export function estimateContextTokens(value: unknown): number {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value)).byteLength;
  // Deterministic conservative approximation for mixed Chinese/JSON content.
  return Math.max(1, Math.ceil(bytes / 3));
}

function validateBlock(block: ContextBlock): void {
  if (!Object.hasOwn(KIND_ORDER, block.kind)) throw new Error("context_block_kind_invalid");
  if (!block.source.trim() || block.source.length > 200) throw new Error("context_block_source_invalid");
  if (!TRUST_BY_KIND[block.kind].has(block.trust)) throw new Error(`context_block_trust_invalid:${block.kind}`);
  if (!/^[0-9a-f]{64}$/.test(block.contentHash)) throw new Error("context_block_hash_invalid");
  if (block.createdAt !== undefined && !Number.isFinite(Date.parse(block.createdAt))) {
    throw new Error("context_block_created_at_invalid");
  }
}

function preferenceFacts(block: ContextBlock): CompactedContextFact[] {
  if (block.kind !== "preference_capsule" || !block.body || typeof block.body !== "object" || Array.isArray(block.body)) return [];
  const body = block.body as Record<string, unknown>;
  const facts: CompactedContextFact[] = [];
  for (const group of ["preferred", "avoid", "workflow"] as const) {
    const values = Array.isArray(body[group]) ? body[group] : [];
    for (const raw of values) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      const category = typeof item.category === "string" ? item.category.trim() : "";
      const value = typeof item.value === "string" ? item.value.trim() : "";
      if (!category || !value) continue;
      facts.push({ fact: `${group}:${category}=${value}`.slice(0, 300), sourceHash: block.contentHash });
    }
  }
  return facts;
}

function explicitCompactionFacts(block: ContextBlock): CompactedContextFact[] {
  if (!block.body || typeof block.body !== "object" || Array.isArray(block.body)) return [];
  const raw = (block.body as Record<string, unknown>).compactionFacts;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((value): value is string => typeof value === "string" && !!value.trim())
    .map((fact) => ({ fact: fact.trim().slice(0, 300), sourceHash: block.contentHash }));
}

function summaryBlock(omitted: ContextBlock[], facts: CompactedContextFact[]): ContextBlock {
  const body = {
    schemaVersion: 1,
    omittedSources: omitted.map((block) => ({ kind: block.kind, source: block.source, sourceHash: block.contentHash })),
    facts,
  };
  return {
    kind: "compaction_summary",
    source: "kernel:context-compactor",
    trust: "untrusted",
    contentHash: sha256Hex(canonicalJson(body)),
    body,
  };
}

function totalTokens(blocks: ContextBlock[], reservedContent: unknown[]): number {
  let total = 0;
  for (const value of reservedContent) total += estimateContextTokens(value);
  for (const block of blocks) total += estimateContextTokens(block);
  return total;
}

/** Fixed-order, provenance-preserving context assembly with deterministic low-trust compaction. */
export function buildModelContext(input: readonly ContextBlock[], options: ContextBuildOptions): ContextBuildResult {
  if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1) throw new Error("context_token_budget_invalid");
  const reservedContent = options.reservedContent ?? [];
  const keepRecentToolResults = options.keepRecentToolResults ?? 1;
  if (!Number.isInteger(keepRecentToolResults) || keepRecentToolResults < 0) {
    throw new Error("context_recent_tool_count_invalid");
  }

  const ordered = input.map((block, index) => ({ block, index }));
  for (const { block } of ordered) validateBlock(block);
  ordered.sort((left, right) => KIND_ORDER[left.block.kind] - KIND_ORDER[right.block.kind] || left.index - right.index);
  const blocks: ContextBlock[] = ordered.map(({ block }) => ({ ...block }));
  let estimatedTokens = totalTokens(blocks, reservedContent);
  if (estimatedTokens <= options.maxTokens) {
    return { blocks, compactedFacts: [], estimatedTokens, compacted: false };
  }

  const toolIndexes = blocks.flatMap((block, index) => block.kind === "tool_result" ? [index] : []);
  const protectedToolIndexes = new Set(toolIndexes.slice(-keepRecentToolResults));
  const candidates = blocks.flatMap((block, index) => {
    if (REQUIRED_KINDS.has(block.kind) || block.kind === "compaction_summary" || protectedToolIndexes.has(index)) return [];
    const rank = block.kind === "preference_capsule" ? 0 : block.kind === "visual_profile_capsule" ? 1 : 2;
    return [{ block, index, rank }];
  }).sort((left, right) => left.rank - right.rank || left.index - right.index);

  const omitted: ContextBlock[] = [];
  const omittedIndexes = new Set<number>();
  let compactedFacts: CompactedContextFact[] = [];
  for (const candidate of candidates) {
    omitted.push(candidate.block);
    omittedIndexes.add(candidate.index);
    compactedFacts.push(...preferenceFacts(candidate.block), ...explicitCompactionFacts(candidate.block));
    const retained = blocks.filter((_, index) => !omittedIndexes.has(index));
    let summary = summaryBlock(omitted, compactedFacts);
    estimatedTokens = totalTokens([...retained, summary], reservedContent);
    while (estimatedTokens > options.maxTokens && compactedFacts.length) {
      compactedFacts = compactedFacts.slice(0, -1);
      summary = summaryBlock(omitted, compactedFacts);
      estimatedTokens = totalTokens([...retained, summary], reservedContent);
    }
    if (estimatedTokens <= options.maxTokens) {
      const combined: ContextBlock[] = [...retained, summary];
      const assembled = combined
        .map((block, index) => ({ block, index }))
        .sort((left, right) => KIND_ORDER[left.block.kind] - KIND_ORDER[right.block.kind] || left.index - right.index)
        .map(({ block }) => block);
      return { blocks: assembled, compactedFacts, estimatedTokens, compacted: true };
    }
  }

  throw new Error("context_token_budget_exceeded_required_blocks");
}
