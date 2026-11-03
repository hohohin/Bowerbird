// Actual App, routing, store.startGeneration, notifications and CanvasWorkspace;
// only native IPC is simulated. No user data, credentials or model is accessed.
import '../home-navigation-live/preview';
import { useStore } from '../../../src/store';
import { generationPromptNodeId, generationOutputNodeId } from '../../../src/lib/projectNodeIds';

const w = window as any;
const previousInvoke = w.__TAURI_INTERNALS__.invoke;
const projects = w.homeProjects;
const assets = [...useStore.getState().assets];
const samples = Object.values(import.meta.glob('../../../src-tauri/resources/samples/preset-*.webp', { eager: true, query: '?url', import: 'default' })) as string[];
assets.forEach((asset, index) => Object.assign(asset, { ext: 'webp', store_path: samples[index % samples.length], thumb_path: samples[index % samples.length] }));
w.lastLibraryAssetId = assets.at(-1)?.id;
const snapshots = new Map<string, any>([['p', w.snapshot()]]);
w.preparedProjects = []; w.generationCalls = [];
function canvas(projectId: string) {
  let snapshot = snapshots.get(projectId);
  if (!snapshot) {
    snapshot = { canvas: { projectId, draftJson: '{}', createdAt: 1, updatedAt: 1 },
      nodes: [], edges: [], groups: [], groupItems: [], threads: [], executionLinks: [], view: null };
    snapshots.set(projectId, snapshot);
  }
  return snapshot;
}
w.liveSnapshot = (id: string) => structuredClone(canvas(id));
w.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
  if (command === 'codex_health' || command === 'dreamina_health') return { ok: true };
  if (command === 'prepare_library_generation_project') {
    w.calls.push({ command, args });
    const id = args.projectId || 'quick-live';
    w.preparedProjects.push(id);
    if (!args.projectId && !projects.some((project: any) => project.id === id)) projects.push({ ...projects[0], id, name: '快速生成', workspace_path: '/synthetic/quick', asset_count: 0 });
    const project = projects.find((project: any) => project.id === id);
    if (!project) throw '项目已不可用，请重新选择';
    canvas(id); return project;
  }
  if (command === 'project_thread_create') {
    const thread = { ...args.value, archivedAt: null, createdAt: 1, updatedAt: 1 };
    canvas(thread.projectId).threads.push(thread); return thread;
  }
  if (command === 'project_canvas_get') return structuredClone(canvas(args.projectId));
  if (command === 'project_canvas_update_draft') { canvas(args.projectId).canvas.draftJson = args.draftJson; return true; }
  if (command === 'project_canvas_view_flush' || command === 'project_canvas_view_upsert') {
    canvas(args.value.projectId).view = args.value; return args.value;
  }
  if (command === 'project_canvas_node_update') {
    const snapshot = [...snapshots.values()].find(value => value.nodes.some((node: any) => node.id === args.nodeId));
    const node = snapshot?.nodes.find((value: any) => value.id === args.nodeId);
    if (node) Object.assign(node, args.value);
    return node ?? null;
  }
  if (command === 'begin_generation_diagnostic') return `attempt-${args.request.jobId}`;
  if (command === 'codex_create_image') {
    w.generationCalls.push(args);
    const snapshot = canvas(args.projectId);
    snapshot.nodes.push({ id: generationPromptNodeId(args.jobId, args.turnKey), projectId: args.projectId, threadId: args.threadId,
      kind: 'prompt', assetId: null, role: null, x: 5000, y: 800, width: 320, height: 190, zIndex: 1, positionLocked: false,
      hiddenAt: null, createdAt: Date.now(), updatedAt: Date.now(), payloadJson: JSON.stringify({ schema_version: 1, text: args.prompt, status: 'running', provider: args.provider, job_id: args.jobId, turn_key: args.turnKey }) });
    useStore.getState().applyGenChunk({ kind: 'started', job_id: args.jobId, references: args.referenceImages, provider: args.provider });
    return `session-${args.jobId}`;
  }
  if (command === 'get_asset') return assets.find(asset => asset.id === args.id) ?? null;
  if (command === 'get_assets_by_ids') return assets.filter(asset => args.assetIds.includes(asset.id));
  if (command === 'generation_diagnostics') return [];
  return previousInvoke(command, args);
};
w.completeGeneration = (index: number) => {
  const request = w.generationCalls[index];
  const snapshot = canvas(request.projectId);
  const promptId = generationPromptNodeId(request.jobId, request.turnKey);
  const prompt = snapshot.nodes.find((node: any) => node.id === promptId);
  prompt.payloadJson = JSON.stringify({ ...JSON.parse(prompt.payloadJson), status: 'done' });
  const asset = { ...assets[0], id: `output-${request.jobId}`, name: '合成生成结果', source: 'generated', generation_session_id: `session-${request.jobId}` };
  assets.push(asset);
  const outputId = generationOutputNodeId(request.jobId, request.turnKey, asset.id);
  snapshot.nodes.push({ ...prompt, id: outputId, kind: 'asset', assetId: asset.id, role: 'output', x: 5360, width: 190, height: 150,
    payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: asset.name, width: 190, height: 150 } }) });
  snapshot.edges.push({ id: `edge-${request.jobId}`, projectId: request.projectId, threadId: request.threadId, fromNodeId: promptId, toNodeId: outputId, kind: 'produced', ordinal: 0, createdAt: 1 });
  useStore.getState().applyGenChunk({ kind: 'done', job_id: request.jobId, images: [asset.store_path], provider: request.provider, session_id: asset.generation_session_id });
  return { promptId, threadId: request.threadId, projectId: request.projectId };
};
useStore.setState({ activeGenProvider: 'codex', defaultProvider: 'codex', codexHealth: { ok: true } as any,
  settings: { theme: 'dark', generation_completion_popup: true, generation_completion_sound: false } as any,
  cloudAuth: { logged_in: true, cloud_available: true, user_id: 'synthetic' } as any,
  cloudEntitlement: { user_id: 'synthetic', tier: 'pro', offline_state: 'fresh', balances: { daily: 0, sub: 1200, topup: 0 }, policy: { can_use_byo: true, can_use_cloud: true, max_parallel_jobs: 10 } } as any });
