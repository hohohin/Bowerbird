import { useEffect, useMemo, useRef } from "react";
import { Bot, Image, MessageSquareText, MoveRight } from "lucide-react";
import type { CanvasEdge, CanvasNode } from "../lib/types";

type JsonObject = Record<string, unknown>;

function payload(node: CanvasNode): JsonObject {
  try {
    const value = JSON.parse(node.payloadJson) as unknown;
    return value && typeof value === "object" ? value as JsonObject : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nodeTitle(node: CanvasNode) {
  const data = payload(node);
  if (node.kind === "prompt") return text(data.text) ?? "生成指令";
  if (node.kind === "agent_group") return "Agent 执行组";
  if (node.kind === "asset") {
    const snapshot = data.snapshot as JsonObject | undefined;
    return text(snapshot?.name) ?? (node.role === "reference" ? "参考素材" : "生成结果");
  }
  return text(data.text) ?? "创作记录";
}

function nodeMeta(node: CanvasNode) {
  const data = payload(node);
  if (node.kind === "prompt") {
    return [text(data.provider), text(data.ratio), text(data.status)].filter(Boolean).join(" · ");
  }
  if (node.kind === "agent_group") {
    return [text(data.skill_id), text(data.status), number(data.progress) != null ? `${number(data.progress)}%` : null]
      .filter(Boolean)
      .join(" · ");
  }
  return node.role ?? node.kind;
}

function relationLabel(kind: CanvasEdge["kind"]) {
  return {
    input: "输入",
    produced: "产出",
    continued: "继续",
    retry: "重试",
    branch: "分支",
    agent_step: "Agent 步骤",
  }[kind];
}

function AgentEventTrail({ node }: { node: CanvasNode }) {
  if (node.kind !== "agent_group") return null;
  const data = payload(node);
  const events = Array.isArray(data.events) ? data.events as JsonObject[] : [];
  const visible = events.slice(-12);
  if (visible.length === 0) return null;
  return (
    <div className="creative-timeline-agent-events">
      {visible.map((event, index) => (
        <div key={`${number(event.seq) ?? index}-${text(event.event_type) ?? "event"}`}>
          <span>{text(event.step) ?? text(event.event_type) ?? "Agent 事件"}</span>
          <p>{text(event.summary) ?? `${number(event.progress) ?? 0}%`}</p>
        </div>
      ))}
    </div>
  );
}

function Inspector({
  node,
  nodes,
  edges,
}: {
  node: CanvasNode | null;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}) {
  const byId = useMemo(() => new Map(nodes.map((item) => [item.id, item])), [nodes]);
  if (!node) {
    return <aside className="creative-inspector"><p>选择一条记录查看精确输入、执行状态与关系。</p></aside>;
  }
  const data = payload(node);
  const incoming = edges.filter((edge) => edge.toNodeId === node.id);
  const outgoing = edges.filter((edge) => edge.fromNodeId === node.id);
  const relations = [...incoming.map((edge) => ({ edge, node: byId.get(edge.fromNodeId) })), ...outgoing.map((edge) => ({ edge, node: byId.get(edge.toNodeId) }))];
  const events = Array.isArray(data.events) ? data.events as JsonObject[] : [];
  const approvals = Array.isArray(data.approvals) ? data.approvals as JsonObject[] : [];
  const clarifications = Array.isArray(data.clarifications) ? data.clarifications as JsonObject[] : [];
  const visualProfile = data.visual_profile && typeof data.visual_profile === "object"
    ? data.visual_profile as JsonObject
    : null;
  const referenceNodes = incoming
    .filter((edge) => edge.kind === "input")
    .map((edge) => byId.get(edge.fromNodeId))
    .filter((item): item is CanvasNode => !!item && item.kind === "asset");
  const parentNode = incoming
    .filter((edge) => edge.kind === "continued" || edge.kind === "retry" || edge.kind === "branch")
    .map((edge) => byId.get(edge.fromNodeId))
    .find((item): item is CanvasNode => !!item) ?? null;
  const visualProfileLabel = visualProfile
    ? `${text(visualProfile.profile_id) ?? "未知档案"} · v${number(visualProfile.version) ?? "?"} · ${text(visualProfile.hash)?.slice(0, 12) ?? "无 hash"}`
    : "—";
  return (
    <aside className="creative-inspector">
      <div className="creative-inspector-heading"><span>节点详情</span><small>{node.kind}</small></div>
      <h3>{nodeTitle(node)}</h3>
      {node.kind === "prompt" && (
        <dl>
          <dt>用户指令</dt><dd>{text(data.text) ?? "—"}</dd>
          <dt>实际 Prompt</dt><dd>{text(data.applied_prompt) ?? text(data.text) ?? "—"}</dd>
          <dt>Provider / 比例</dt><dd>{[text(data.provider), text(data.ratio)].filter(Boolean).join(" · ") || "—"}</dd>
          <dt>参考输入</dt><dd>{referenceNodes.length > 0 ? referenceNodes.map(nodeTitle).join("、") : "—"}</dd>
          <dt>父结果</dt><dd>{parentNode ? nodeTitle(parentNode) : "—"}</dd>
          <dt>视觉设定</dt><dd>{visualProfileLabel}</dd>
          <dt>状态</dt><dd>{text(data.status) ?? "—"}</dd>
        </dl>
      )}
      {node.kind === "agent_group" && (
        <dl>
          <dt>Run</dt><dd>{text(data.run_id) ?? "—"}</dd>
          <dt>Runtime / Skill</dt><dd>{[text(data.agent_runtime), text(data.skill_id)].filter(Boolean).join(" · ") || "—"}</dd>
          <dt>步骤 / 状态</dt><dd>{[text(data.current_step), text(data.status), number(data.progress) != null ? `${number(data.progress)}%` : null].filter(Boolean).join(" · ") || "—"}</dd>
          <dt>安全计量摘要</dt><dd>预算 {number(data.budget_credits) ?? "—"} · 实际 {number(data.actual_credits) ?? "—"}</dd>
          <dt>视觉设定</dt><dd>{visualProfileLabel}</dd>
          <dt>事件</dt><dd>{events.length} 条</dd>
          <dt>审批 / 澄清</dt><dd>{approvals.filter((item) => item.status === "pending").length} 待审批 · {clarifications.filter((item) => item.status === "pending").length} 待澄清</dd>
        </dl>
      )}
      {node.kind === "asset" && (
        <dl>
          <dt>角色</dt><dd>{node.role ?? "—"}</dd>
          <dt>中央素材 ID</dt><dd>{node.assetId ?? "已删除（tombstone）"}</dd>
          <dt>执行来源</dt><dd>{JSON.stringify(data.execution ?? {})}</dd>
        </dl>
      )}
      <div className="creative-inspector-relations">
        <span>明确关系</span>
        {relations.length === 0 ? <p>没有关联边</p> : relations.map(({ edge, node: related }) => (
          <div key={edge.id}><MoveRight size={12} /><b>{relationLabel(edge.kind)}</b><small>{related ? nodeTitle(related) : "已移除节点"}</small></div>
        ))}
      </div>
    </aside>
  );
}

export function CreativeTimeline({
  nodes,
  edges,
  selectedNodeId,
  onSelect,
  onLocate,
}: {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
  onLocate: (nodeId: string) => void;
}) {
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const ordered = useMemo(
    () => nodes.filter((node) => node.hiddenAt == null).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    [nodes],
  );
  const selected = ordered.find((node) => node.id === selectedNodeId) ?? null;

  useEffect(() => {
    if (selectedNodeId) itemRefs.current.get(selectedNodeId)?.scrollIntoView({ block: "nearest" });
  }, [selectedNodeId]);

  return (
    <div className="creative-timeline-layout">
      <section className="creative-timeline-list" aria-label="创作时间线">
        <div className="canvas-timeline-heading">
          <span>时间线</span>
          <small>按事实创建时间投影；画板坐标不参与执行顺序</small>
        </div>
        {ordered.length === 0 ? <p>这项创作还没有素材或执行记录。</p> : (
          <ol>
            {ordered.map((node) => (
              <li key={node.id} className={selectedNodeId === node.id ? "is-selected" : ""}>
                <button
                  ref={(element) => {
                    if (element) itemRefs.current.set(node.id, element);
                    else itemRefs.current.delete(node.id);
                  }}
                  type="button"
                  onClick={() => onSelect(node.id)}
                  onDoubleClick={() => onLocate(node.id)}
                >
                  {node.kind === "asset" ? <Image size={14} /> : node.kind === "agent_group" ? <Bot size={14} /> : <MessageSquareText size={14} />}
                  <div><strong>{nodeTitle(node)}</strong><small>{nodeMeta(node)}</small></div>
                </button>
                <button type="button" className="creative-timeline-locate" onClick={() => onLocate(node.id)}>在画板定位</button>
                <AgentEventTrail node={node} />
              </li>
            ))}
          </ol>
        )}
      </section>
      <Inspector node={selected} nodes={ordered} edges={edges} />
    </div>
  );
}
