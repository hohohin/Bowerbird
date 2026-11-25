import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ModalShell } from "./ModalShell";
import { useStore } from "../store";
import { api } from "../lib/api";
import { canvasWorkflowController } from "../lib/canvasWorkflowRuntime";
import { assetPayloadJson, createCanvasAssetSnapshot } from "../lib/creativeCanvas";
import { newWorkflowNode, type WorkflowNode } from "../lib/canvasWorkflow";
import { DEFAULT_VIDEO_OPTIONS, videoDurationRange } from "../lib/videoGeneration";
import { replicationAnalysisNote } from "../lib/replicationAnalysisNote";
import { userErrorMessage } from "../lib/userError";
import type { Asset, NewCanvasNode } from "../lib/types";

type Row = { start: number; end: number; index: number; texts: readonly [string, string, string]; speech: string };
interface Props {
  mode: "note" | "workflow";
  rows: Row[];
  assetId: string;
  sourceHash: string;
  currentProjectId?: string | null;
  onClose: () => void;
  onOpenBoard?: () => void;
}
async function stableId(...parts: (string | number)[]) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function deliver(projectId: string, { mode, assetId, sourceHash, rows }: Props) {
  const controller = canvasWorkflowController(projectId);
  await controller.flush();
  await api.projectCanvasEnsure(projectId);
  const [graph, workflow] = await Promise.all([api.projectCanvasGet(projectId), api.canvasWorkflowGet(projectId)]);
  const sorted = [...rows].sort((a, b) => a.start - b.start);
  const key = await stableId(
    projectId,
    mode,
    assetId,
    sourceHash,
    ...sorted.flatMap((row) => [row.start, row.end]),
  );
  const existing = await invoke<string | null>("video_shots_delivery_get", { projectId, deliveryKey: key });
  if (existing) return { nodeId: existing, existing: true };
  let y = 48 +
    Math.max(
      0,
      ...graph.nodes.map((n) => n.y + n.height),
      ...workflow.document.nodes.map((n) => n.y + (n.layoutSize?.height ?? 530)),
    );
  const frames: NewCanvasNode[] = [];
  const additions: WorkflowNode[] = [];
  const node = (
    id: string,
    kind: "asset" | "note",
    asset: string | null,
    width: number,
    height: number,
    payloadJson: string,
  ): NewCanvasNode => ({
    id,
    projectId,
    threadId: null,
    kind,
    assetId: asset,
    role: kind === "asset" ? "reference" : null,
    payloadJson,
    x: 24,
    y,
    width,
    height,
    zIndex: 1,
    positionLocked: false,
  });
  const material = (row: Row) =>
    invoke<Asset>("video_shots_frame_asset", { assetId, sourceHash, startMs: row.start });
  let focus = "";
  if (mode === "note") {
    const items = [];
    for (const row of sorted) {
      const frame = await material(row);
      items.push({
        assetId: frame.id,
        index: row.index,
        start: row.start / 1000,
        end: row.end / 1000,
        dataUrl: "",
        text: [
          "画面与运镜\n" + row.texts[0],
          "首帧提示词\n" + row.texts[1],
          "视频提示词\n" + row.texts[2],
          "真实台词\n" + (row.speech || "此镜头无台词"),
        ].join("\n\n"),
      });
    }
    focus = "shot-note-" + key;
    frames.push(
      node(
        focus,
        "note",
        null,
        700,
        Math.min(1400, 90 + 175 * items.length),
        JSON.stringify({ ...replicationAnalysisNote(items), title: "画板分镜卡" }),
      ),
    );
  } else {
    for (const row of sorted) {
      const id = await stableId(projectId, assetId, sourceHash, row.start, row.end);
      const imageId = "shot-image-" + id, videoId = "shot-video-" + id, frameId = "shot-frame-" + id;
      focus ||= imageId;
      if (
        workflow.document.nodes.some((n) => n.id === imageId || n.id === videoId) ||
        graph.nodes.some((n) => n.id === frameId)
      ) continue;
      const frame = await material(row);
      frames.push(
        node(frameId, "asset", frame.id, 168, 106, assetPayloadJson(createCanvasAssetSnapshot(frame, frameId))),
      );
      additions.push({
        ...newWorkflowNode("generation", 235, y, "jimeng"),
        id: imageId,
        prompt: row.texts[1],
        generation: { media: "image" },
        inputs: { image: [{ assetId: frame.id, assetNodeId: frameId }] },
      }, {
        ...newWorkflowNode("generation", 620, y, "jimeng"),
        id: videoId,
        prompt: row.texts[2],
        sourceShotDurationMs: row.end - row.start,
        generation: {
          media: "video",
          videoChannel: "jimeng",
          videoOptions: { ...DEFAULT_VIDEO_OPTIONS, kind: "image2video", duration: generationSeconds(row) },
        },
        inputs: { image: [{ nodeId: imageId, portId: "image" }] },
      });
      y += 580;
    }
  }
  const nodeId = await invoke<string>("video_shots_deliver", {
    projectId,
    sourceAssetId: assetId,
    sourceHash,
    deliveryKey: key,
    focusId: focus,
    revision: workflow.revision,
    shots: sorted.map(({ start, end, texts }) => ({ start, end, texts })),
    frames,
    additions,
  });
  await controller.refreshExternalCards();
  return { nodeId, existing: false };
}
export function ShotBoardDelivery(props: Props) {
  const projects = useStore((s) => s.projects);
  const [projectId, setProjectId] = useState(
    projects.some((p) => p.id === props.currentProjectId) ? props.currentProjectId! : "",
  );
  const [receipt, setReceipt] = useState<{ nodeId: string; existing: boolean }>();
  const [busy, setBusy] = useState(false), lock = useRef(false);
  const [error, setError] = useState("");
  async function submit() {
    if (lock.current || !projectId) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      setReceipt(await deliver(projectId, props));
    } catch (e) {
      setError(userErrorMessage(e, "无法保存到项目画板，请重试。"));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <ModalShell
      width="sm"
      title={receipt
        ? (receipt.existing ? "已在项目画板中" : "已发送到画板")
        : (props.mode === "note" ? "生成画板分镜卡" : "生成画板分镜工作流")}
      onClose={props.onClose}
      preventClose={busy}
      footer={receipt
        ? (
          <>
            <button className="app-modal-button" onClick={props.onClose}>返回复刻</button>
            <button
              className="app-modal-button is-primary"
              data-modal-autofocus
              onClick={() => {
                props.onClose();
                props.onOpenBoard?.();
                useStore.setState({
                  creativeNavigation: { projectId, threadId: null, nodeId: receipt.nodeId, projectNode: true },
                });
              }}
            >
              前往画板查看
            </button>
          </>
        )
        : (
          <>
            <button className="app-modal-button" disabled={busy} onClick={props.onClose}>取消</button>
            <button
              className="app-modal-button is-primary"
              disabled={!projectId || busy}
              onClick={() => void submit()}
            >
              {busy ? "正在保存…" : "生成到画板"}
            </button>
          </>
        )}
    >
      {receipt
        ? <p>{projects.find((p) => p.id === projectId)?.name} · {props.rows.length} 个镜头</p>
        : (
          <label className="shot-project-label">
            目标项目
            <select value={projectId} disabled={busy} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">选择项目</option>
              {projects.map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
      {!receipt && props.mode === "workflow" &&
        props.rows.some((row) => generationSeconds(row) !== (row.end - row.start) / 1000) &&
        (
          <details>
            <summary>查看镜头时长与生成时长</summary>
            <ul>
              {props.rows.filter((row) => generationSeconds(row) !== (row.end - row.start) / 1000).map((row) => (
                <li key={row.start}>
                  镜头 {row.index + 1} · 原片 {(row.end - row.start) / 1000} 秒 → 生成 {generationSeconds(row)} 秒
                </li>
              ))}
            </ul>
          </details>
        )}
      {error && <p role="alert">{error}</p>}
    </ModalShell>
  );
}

function generationSeconds(row: Row) {
  const [min, max] = videoDurationRange(DEFAULT_VIDEO_OPTIONS.model_version);
  return Math.max(min, Math.min(max, Math.ceil((row.end - row.start) / 1000)));
}
