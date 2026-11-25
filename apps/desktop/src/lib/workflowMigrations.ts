import { h3DraftForResult, h3PromptPatch, isH3ImageCard, normalizeWorkflowLocalVideo, rebindGenerationReferences, workflowDependencies,
  workflowExecutionNodes, workflowImageContainer, workflowLockedNodes, workflowRunActive, workflowRuns, workflowWriteNodes,
  type CanvasWorkflow, type WorkflowInput, type WorkflowRun, type WorkflowStep } from "./canvasWorkflow";
import { canvasSessionCompleted, canvasSessionCompletionLookup, reconcileCanvasWorkflowReferences } from "./canvasSessionOutputs";
import type { CanvasNode, GenJob } from "./types";

export function migrateWorkflowDocument(persisted: CanvasWorkflow, canvasNodes: readonly CanvasNode[], genJobs: Record<string, GenJob>) {
  let document = persisted;
  // Old dimension wires now carry the complete prompt through the single text port.
  const describes = new Set(document.nodes.filter(node => node.kind === "instruction" && node.action === "describe").map(node => node.id));
  const splits = new Set(document.nodes.filter(node => node.kind === "instruction" && node.action === "layers").map(node => node.id));
  const explicitTextTargets = new Set(document.nodes.flatMap(node => node.textTarget ? [node.textTarget.nodeId] : []));
  const aggregateInput = (input: WorkflowInput) => describes.has(input.nodeId ?? "") && input.portId?.startsWith("dimension-") ? { ...input, portId: "text" }
    : splits.has(input.nodeId ?? "") && input.portId?.startsWith("layer-") ? { ...input, portId: "image" } : input;
  document = { ...document, nodes: document.nodes.map(node => ({ ...node,
    ...(describes.has(node.id) ? { outputPorts: [], outputs: node.outputs.text ? { text: node.outputs.text } : {} } : {}),
    ...(splits.has(node.id) ? { outputPorts: [], outputs: node.outputs.image ? { image: node.outputs.image } : {} } : {}),
    ...(node.resultNodeIds ? { resultNodeIds: node.resultNodeIds.filter(id => !explicitTextTargets.has(id)) } : {}),
    ...(node.textTarget ? { textTarget: { ...node.textTarget, image: !!node.inputs.image?.length } } : {}),
    inputs: Object.fromEntries(Object.entries(node.inputs).map(([port, bindings]) => [port, bindings.map(aggregateInput)])),
    ...(node.promptReferences ? { promptReferences: node.promptReferences.map(ref => {
      const { assetId, ...reference } = ref;
      return { ...reference, ...(ref.type === "image" && workflowImageContainer(ref.input) ? {} : { assetId }), input: aggregateInput(ref.input) };
    }) } : {}),
  })) };
  // A crash is not permission to repeat a billable request. Continue only queries known jobs.
  const runs = workflowRuns(persisted).map<WorkflowRun>(saved => {
    const interrupted = saved.status === "running" ? new Set(saved.order) : undefined;
    const steps = Object.fromEntries(Object.entries(saved.steps).map<[string, WorkflowStep]>(([id, step]) => {
      if (interrupted?.has(id) && step.status === "running") return [id, { ...step, comfyStopping: false, comfyProgress: undefined,
        status: "waiting", error: "上次执行已中断，可继续取回已有任务；不会自动重新生成。" }];
      return [id, step.comfyStopping || step.comfyProgress !== undefined ? { ...step, comfyStopping: false, comfyProgress: undefined } : step];
    }));
    return { ...saved, steps, status: interrupted ? "waiting" : saved.status };
  });
  // Older runs kept locks from previous and future trigger phases.
  const triggerIds = new Set(document.nodes.filter(node => node.kind === "trigger").map(node => node.id));
  for (const run of runs) {
    const loopFinished = !run.loop || run.loop.items && (run.loop.startIndex ?? 0) + run.loop.completed.length === run.loop.items.length;
    if (run.status === "waiting" && loopFinished && run.triggerQueue?.length && run.order.every(id => run.steps[id]?.status === "done")) {
      run.startId = run.triggerQueue[0];
      run.order = [];
      run.lockedNodeIds = [];
      run.writeNodeIds = [];
      run.loop = undefined;
      continue;
    }
    if (!workflowRunActive(run) || !(run.lockedNodeIds ?? run.order).some(id => triggerIds.has(id))) continue;
    const nodes = workflowExecutionNodes(document.nodes, run.startId);
    run.lockedNodeIds = workflowDependencies(nodes, run.order);
    run.writeNodeIds = workflowWriteNodes(nodes, run.order);
  }
  // Conversation metadata may hydrate later; baseline all completed turns before grouping them.
  const historicalSessionCompletions = new Set(canvasNodes.filter(node => node.kind === "prompt"
    && node.hiddenAt == null && canvasSessionCompleted(node, canvasNodes)).map(node => node.id));
  const recovering = workflowLockedNodes({ ...document, runs });
  document = { ...document, nodes: reconcileCanvasWorkflowReferences(document.nodes, canvasNodes).map(node => {
    // Old runs may own sparse pipe numbers. Keep their submitted inputs when
    // projecting those numbers into today's contiguous positions.
    if (recovering.has(node.id) && node.promptReferences) node = { ...node, promptReferences: node.promptReferences.map(ref => {
      if (ref.direction === "output" || ref.slot === undefined) return ref;
      const index = node.inputs[ref.type]?.findIndex(input => input.slot === ref.slot) ?? -1;
      return index < 0 ? ref : { ...ref, slot: index + 1 };
    }) };
    node = normalizeWorkflowLocalVideo(rebindGenerationReferences(node));
    if (!node.h3Prompt && (node.kind === "comfy-video" || isH3ImageCard(node))) {
      const snapshot = [...runs].reverse().map(run => run.steps[node.id]?.comfyOptimization)
        .find(s => s?.result && s.result === node.prompt && ("mode" in s.input) === (node.kind === "comfy-video"));
      if (snapshot?.result) return { ...node, ...h3PromptPatch(h3DraftForResult(snapshot.input, snapshot.result)) };
    }
    return node;
  }), runs, run: runs[runs.length - 1] ?? null };
  // Loading historical results never authorizes a new generation. Pending turns remain armed.
  const completed = canvasSessionCompletionLookup(canvasNodes, genJobs);
  const nodes = document.nodes.map(node => node.kind === "trigger" && node.inputs.completion?.some(input => input.canvasNodeId)
    ? { ...node, completionSeen: [...new Set([...(node.completionSeen ?? []), ...completed(node.inputs.completion)])] } : node);
  document = { ...document, nodes };
  const latest = runs[runs.length - 1];
  const latestIssue = latest && ["failed", "waiting"].includes(latest.status) ? Object.values(latest.steps).find(step => step.status === "failed" && step.diagnostic)?.diagnostic ?? null : null;
  return { document, historicalSessionCompletions, latestIssue };
}
