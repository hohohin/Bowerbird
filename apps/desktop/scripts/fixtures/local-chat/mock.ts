// Closed synthetic IPC. All state belongs to this browser tab, never a user library.
const STORAGE_KEY = "bowerbird-local-chat-fixture-v1";
const clone = <T,>(value: T): T => structuredClone(value);
const image = (background: string, shape: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="${background}"/><circle cx="240" cy="160" r="92" fill="${shape}"/><path d="M120 280 Q240 210 360 280" stroke="${shape}" stroke-width="14" fill="none"/></svg>`)}`;
export const assets = [
  { id: "ref-lotus", name: "合成花影参考", store_path: image("#eee7df", "#bd8b95") },
  { id: "ref-moon", name: "合成月色参考", store_path: image("#d8e1e9", "#7892a9") },
].map(asset => ({ ...asset, thumb_path: asset.store_path, width: 480, height: 360, ext: "svg", source: "imported" }));
export const projects = ["p", "q"].map((id, index) => ({ id, name: index ? "项目 B · 包装文案" : "项目 A · 荷月礼盒", kind: "blank", workspace_path: `blank:${id}`, asset_count: 2, title_source: "manual", created_at: 1, updated_at: 1 }));
type Message = { id: string; turnId: string; role: "user" | "assistant" | "tool"; text: string; referenceAssetIds: string[]; status: string; createdAt: number; updatedAt: number };
type Conversation = { id: string; projectId: string; threadId: string; nodeId: string; title: string; provider: "codex-local"; status: string; turnCount: number; preview: string; revision: number; createdAt: number; updatedAt: number; error: string | null; messages: Message[]; actions?: any[] };
type Database = { activeProjectId: string; projects: Record<string, any>; conversations: Record<string, Conversation>; requests: Record<string, string>; settings: Record<string, unknown> };
function emptySnapshot(id: string) {
  return { canvas: { projectId: id, draftJson: "{}", createdAt: 1, updatedAt: 1 },
    nodes: id === "p" ? assets.map((asset, index) => ({ id: `reference-${asset.id}`, projectId: id, threadId: null, kind: "asset", assetId: asset.id, role: "reference", x: 100 + index * 260, y: 100, width: 220, height: 165, zIndex: 1, hiddenAt: null, positionLocked: false, createdAt: 1, updatedAt: 1,
      payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: asset.name, width: 480, height: 360 } }) })) : [],
    edges: [], groups: [], groupItems: [], threads: [], executionLinks: [],
    view: { projectId: id, panX: 40, panY: 35, zoom: 1, sourcePanelWidth: 250, viewMode: "canvas", timelineScope: "all" } };
}
const initial = (): Database => ({ activeProjectId: "p", projects: Object.fromEntries(projects.map(p => [p.id, emptySnapshot(p.id)])), conversations: {}, requests: {}, settings: {} });
let database: Database = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null") ?? initial();
const callbacks = new Map<number, (value: unknown) => void>();
const listeners = new Map<number, string>();
const subscribers = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setInterval>>();
const pendingReplies: Array<() => void> = [];
let nextCallback = 0;
export const controls = { fault: "none", hold: true, delayReply: false, authenticated: true, entitled: true };
export const calls: Array<{ command: string; args: any }> = [];
export const subscribe = (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; };
const changed = () => { for (const listener of subscribers) listener(); };
const save = () => { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(database)); changed(); };
const emit = (event: string, payload: unknown) => { for (const [handler, name] of listeners) if (event === name) callbacks.get(handler)?.({ event, id: handler, payload: clone(payload) }); };
export const inspect = () => clone({ ...database, calls, pendingReplies: pendingReplies.length });
export function reset() { for (const timer of timers.values()) clearInterval(timer); sessionStorage.removeItem(STORAGE_KEY); location.reload(); }
const summary = (chat: Conversation) => { const { messages: _messages, ...value } = chat; return clone(value); };
function persistChat(chat: Conversation) {
  chat.updatedAt = Date.now(); chat.revision += 1;
  chat.preview = [...chat.messages].reverse().find(message => message.role === "assistant" && message.text)?.text.slice(0, 100) ?? "";
  const node = database.projects[chat.projectId].nodes.find((node: any) => node.id === chat.nodeId);
  if (node) node.updatedAt = chat.updatedAt;
  save(); emit("local-chat://updated", chat);
}
function clearTimer(chat: Conversation) { const timer = timers.get(chat.id); if (timer) clearInterval(timer); timers.delete(chat.id); }
const fullReply = "**花影入月**\n\n可以保留参考图里的粉灰色关系，把荷花的线条留在包装侧边，正面用一轮留白的月亮组织视觉重心。\n\n先确定礼盒的主色和文字层级，再把包装、海报、社交媒体图片分别整理为三条清晰的生成指令。\n\n这是一段隔离验收回复，不会调用真实模型或修改文件。";
export function advance(id?: string) {
  const chat = id ? database.conversations[id] : Object.values(database.conversations).find(chat => chat.status === "running");
  if (!chat || chat.status !== "running") return;
  const message = chat.messages.at(-1)!;
  message.text = fullReply.slice(0, Math.min(fullReply.length, message.text.length + 42)); message.updatedAt = Date.now();
  if (message.text.length === fullReply.length) { message.status = "done"; chat.status = "idle"; clearTimer(chat); }
  persistChat(chat);
}
export function finish(id?: string) {
  const chats = id ? [database.conversations[id]].filter(Boolean) : Object.values(database.conversations).filter(chat => chat.status === "running" || chat.status === "stopping");
  for (const chat of chats) { clearTimer(chat); Object.assign(chat.messages.at(-1)!, { text: fullReply, status: "done", updatedAt: Date.now() }); chat.status = "idle"; persistChat(chat); }
}
export function interrupt() {
  for (const chat of Object.values(database.conversations).filter(chat => chat.status === "running" || chat.status === "stopping")) { clearTimer(chat); chat.status = "interrupted"; chat.messages.at(-1)!.status = "interrupted"; persistChat(chat); }
}
export function failRunning() {
  for (const chat of Object.values(database.conversations).filter(chat => chat.status === "running" || chat.status === "stopping")) { clearTimer(chat); chat.status = "failed"; chat.error = "synthetic provider C:\\private\\auth.json token_missing"; chat.messages.at(-1)!.status = "failed"; persistChat(chat); }
}
export function staleEvent() {
  const chat = Object.values(database.conversations).at(-1); if (!chat) return;
  const old = clone(chat); old.revision = Math.max(0, old.revision - 1); old.status = "failed"; old.error = "stale payload must be ignored"; old.messages.at(-1)!.text = "过期事件不应覆盖最新内容"; emit("local-chat://updated", old);
}
export async function createCards(mode: "count" | "rows") {
  const chat = Object.values(database.conversations).filter(chat => chat.projectId === database.activeProjectId).at(-1);
  if (!chat) return;
  const examples = await fetch("/.tmp/local-chat/card-fixtures.json").then(response => response.json());
  // Resolve the compiler's synthetic asset identity to this fixture's visible image.
  const example = JSON.parse(JSON.stringify(examples[mode]).replaceAll('"picture"', '"ref-lotus"'));
  const action = { ...clone(example.action), conversationId: chat.id, turnId: chat.messages.at(-1)!.turnId };
  if (chat.actions?.some(value => value.id === action.id)) return;
  const project = database.projects[chat.projectId];
  const current = project.workflow ?? { revision: 0, document: { schema_version: 1, nodes: [], run: null } };
  const offset = Math.max(0, ...project.nodes.map((node: any) => node.x + node.width + 80), ...current.document.nodes.map((node: any) => node.x + 400));
  for (const node of [...example.workflow.document.nodes, ...example.notes]) node.x += offset;
  project.workflow = { revision: current.revision + 1, document: { ...current.document,
    nodes: [...current.document.nodes, ...clone(example.workflow.document.nodes)], cardNames: { ...current.document.cardNames, ...example.workflow.document.cardNames } } };
  project.nodes.push(...clone(example.notes).map((note: any) => ({ ...note, projectId: chat.projectId, threadId: chat.threadId })));
  (project.cardBaselines ??= {})[action.id] = { nodes: clone(example.workflow.document.nodes), notes: clone(project.nodes.filter((note: any) => action.cards.some((card: any) => card.id === note.id))) };
  (chat.actions ??= []).push(action);
  clearTimer(chat); chat.status = "idle";
  Object.assign(chat.messages.at(-1)!, { text: "已创建内容、生成、循环和触发卡片。可以先编辑内容，再点击触发卡片运行。", status: "done", updatedAt: Date.now() });
  persistChat(chat); emit("local-chat://cards-changed", { projectId: chat.projectId, conversationId: chat.id, actionId: action.id });
}
function autoStream(chat: Conversation) { if (!controls.hold) timers.set(chat.id, setInterval(() => advance(chat.id), 900)); }
export function setHold(value: boolean) { controls.hold = value; for (const chat of Object.values(database.conversations).filter(chat => chat.status === "running")) { clearTimer(chat); autoStream(chat); } changed(); }
export function setFault(value: string) { controls.fault = value; changed(); }
export function setDelayReply(value: boolean) { controls.delayReply = value; changed(); }
export function releaseReplies() { pendingReplies.splice(0).forEach(resolve => resolve()); changed(); }
export async function invoke(command: string, args: any = {}) {
  if (!command.startsWith("plugin:event")) { calls.push({ command, args: clone(args) }); if (calls.length > 100) calls.shift(); }
  if (command === "plugin:event|listen") { listeners.set(args.handler, args.event); return args.handler; }
  if (command === "plugin:event|unlisten") { listeners.delete(args.eventId); return null; }
  if (command === "plugin:event|emit") { emit(args.event, args.payload); return null; }
  if (command === "local_chat_list") { if (controls.fault === "read") throw new Error("synthetic database C:\\private\\chat.db failed"); return Object.values(database.conversations).filter(chat => chat.projectId === args.projectId).sort((a, b) => b.updatedAt - a.updatedAt).map(summary); }
  if (command === "local_chat_get") { if (controls.fault === "read") throw new Error("synthetic database C:\\private\\chat.db failed"); return clone(database.conversations[args.conversationId] ?? null); }
  if (command === "local_chat_cards_undo") {
    const chat = database.conversations[args.conversationId], action = chat?.actions?.find(action => action.id === args.actionId);
    if (!action) throw new Error("找不到这次创建记录。");
    if (action.status === "undone") return clone(chat);
    const project = database.projects[chat.projectId], baseline = project.cardBaselines[action.id];
    if (baseline.nodes.some((node: any) => JSON.stringify(node) !== JSON.stringify(project.workflow.document.nodes.find((current: any) => current.id === node.id)))
      || baseline.notes.some((node: any) => JSON.stringify(node) !== JSON.stringify(project.nodes.find((current: any) => current.id === node.id)))) throw new Error("卡片已有修改或运行记录，无法撤销此次创建，请在画板中单独调整。");
    const ids = new Set(action.cards.map((card: any) => card.id));
    project.nodes = project.nodes.filter((node: any) => !ids.has(node.id));
    project.workflow.document.nodes = project.workflow.document.nodes.filter((node: any) => !ids.has(node.id));
    for (const id of ids) delete project.workflow.document.cardNames[id as string];
    project.workflow.revision += 1; action.status = "undone"; action.undoneAt = Date.now(); persistChat(chat);
    emit("local-chat://cards-changed", { projectId: chat.projectId, conversationId: chat.id, actionId: action.id }); return clone(chat);
  }
  if (command === "local_chat_send") {
    const input = args.input;
    if (!controls.authenticated) throw new Error("请先在设置中登录本机 Codex。");
    if (!controls.entitled) throw new Error("本机对话需要 Pro 或 Studio 权益。");
    if (controls.fault === "send") throw new Error("synthetic IPC C:\\private\\auth.json token_missing");
    if (database.requests[input.requestId]) return clone(database.conversations[database.requests[input.requestId]]);
    if (!input.text?.trim()) throw new Error("请输入对话内容。");
    let chat = input.conversationId ? database.conversations[input.conversationId] : undefined;
    if (input.conversationId && (!chat || chat.projectId !== input.projectId)) throw new Error("对话不属于当前项目。");
    if (chat && ["running", "stopping"].includes(chat.status)) throw new Error("这条对话仍在回复，请稍候。");
    const now = Date.now();
    if (!chat) {
      const id = crypto.randomUUID(); const project = database.projects[input.projectId];
      if (!project) throw new Error("项目不存在。");
      chat = { id, projectId: input.projectId, threadId: `chat-thread-${id}`, nodeId: `local-chat:${id}`, title: input.text.trim().slice(0, 30), provider: "codex-local", status: "idle", turnCount: 0, preview: "", revision: 0, createdAt: now, updatedAt: now, error: null, messages: [] };
      database.conversations[id] = chat;
      project.threads.push({ id: chat.threadId, projectId: chat.projectId, title: chat.title, createdAt: now, updatedAt: now, archivedAt: null });
      project.nodes.push({ id: chat.nodeId, projectId: chat.projectId, threadId: chat.threadId, kind: "note", assetId: null, role: null, x: 100, y: 310, width: 320, height: 180, zIndex: 2, ...input.placement, positionLocked: false, hiddenAt: null, createdAt: now, updatedAt: now, payloadJson: JSON.stringify({ schema_version: 1, note_type: "chat", text: chat.title, conversation_id: id }) });
    }
    const turnId = crypto.randomUUID();
    const node = database.projects[chat.projectId].nodes.find((node: any) => node.id === chat.nodeId);
    if (node) node.hiddenAt = null;
    chat.messages.push({ id: crypto.randomUUID(), turnId, role: "user", text: input.text.trim(), referenceAssetIds: input.referenceAssetIds ?? [], status: "done", createdAt: now, updatedAt: now }, { id: crypto.randomUUID(), turnId, role: "assistant", text: "", referenceAssetIds: [], status: "running", createdAt: now, updatedAt: now });
    chat.turnCount++; chat.status = "running"; chat.error = null; database.requests[input.requestId] = chat.id;
    persistChat(chat); autoStream(chat);
    const accepted = clone(chat);
    if (controls.delayReply) await new Promise<void>(resolve => { pendingReplies.push(resolve); changed(); });
    return accepted;
  }
  if (command === "local_chat_stop") {
    if (controls.fault === "stop") throw new Error("synthetic transport C:\\private\\pipe failed");
    const chat = database.conversations[args.conversationId]; if (!chat) return null;
    if (chat.status === "running" || chat.status === "stopping") { clearTimer(chat); chat.status = "stopped"; chat.messages.at(-1)!.status = "stopped"; persistChat(chat); }
    return clone(chat);
  }
  if (/codex_create_image|generate_video|local_agent_run|cloud_agent_create/.test(command)) throw new Error("隔离测试禁止真实生成。");
  if (command === "list_projects") return clone(projects);
  if (command === "set_active_project") { database.activeProjectId = args.projectId ?? "p"; save(); return null; }
  if (command === "get_active_project") return database.activeProjectId;
  if (command === "project_canvas_ensure" || command === "project_canvas_materialize") return clone(database.projects[args.projectId ?? args.value.projectId].canvas);
  if (command === "project_canvas_get") return clone(database.projects[args.projectId]);
  if (command === "project_canvas_update_draft") { database.projects[args.projectId].canvas.draftJson = args.draftJson; save(); return true; }
  if (command === "project_canvas_view_upsert" || command === "project_canvas_view_flush") { database.projects[args.value.projectId].view = clone(args.value); save(); return clone(args.value); }
  if (command === "project_canvas_touch" || command === "project_canvas_title_from_first_prompt" || command === "project_canvas_rename") return true;
  if (command === "project_thread_create") { const thread = { ...args.value, createdAt: Date.now(), updatedAt: Date.now(), archivedAt: null }; database.projects[thread.projectId].threads.push(thread); save(); return clone(thread); }
  if (command === "project_canvas_node_create") { const node = { ...args.value, hiddenAt: null, createdAt: Date.now(), updatedAt: Date.now() }; database.projects[node.projectId].nodes.push(node); save(); return clone(node); }
  if (command === "project_canvas_node_update" || command === "project_canvas_note_update") { const node = Object.values(database.projects).flatMap(project => project.nodes).find(node => node.id === args.nodeId); if (node) Object.assign(node, args.value ?? { payloadJson: args.payloadJson }); save(); return clone(node ?? null); }
  if (command === "project_canvas_node_remove") { const node = Object.values(database.projects).flatMap(project => project.nodes).find(node => node.id === args.nodeId); if (node) node.hiddenAt = Date.now(); save(); return node ? "hidden" : null; }
  if (command === "get_assets_by_ids") return clone(assets.filter(asset => args.assetIds.includes(asset.id)));
  if (command === "list_assets" || command === "material_catalog_assets") return clone(assets);
  if (command === "material_catalog") return { tags: [], collections: [], prompts: [], tag_asset_ids: {} };
  if (command === "list_library_view") return { assets: clone(assets), memberships: [], total: assets.length };
  if (command === "count_assets") return assets.length;
  if (command === "read_image_data_url") return args.path;
  if (command === "file_workspace_status") return { config: { root: null, places: [], projects: {} }, proposed_root: "/synthetic-library" };
  if (command === "file_workspace_all") return { entries: [], unavailable: [] };
  if (command === "get_settings") return clone(database.settings);
  if (command === "update_settings") { database.settings = clone(args.settings); save(); return null; }
  if (command === "codex_health" || command === "dreamina_health") return { ok: controls.authenticated, reason: controls.authenticated ? "" : "尚未登录" };
  if (command === "local_agent_health") return false;
  if (command === "canvas_workflow_get") return clone(database.projects[args.projectId].workflow ?? { revision: 0, document: { schema_version: 1, nodes: [], run: null } });
  if (command === "canvas_workflow_save") {
    const project = database.projects[args.projectId];
    if (args.revision !== (project.workflow?.revision ?? 0)) throw new Error("工作流已被其他窗口修改，请重新打开项目");
    project.workflow = { revision: args.revision + 1, document: clone(args.document) }; save(); return args.revision + 1;
  }
  if (command === "list_generation_groups") return {};
  if (command === "generation_history") return { turns: [], references: [] };
  if (command.startsWith("list_") || /visual_profiles|asset_ids|palette_overview|workflow_templates_list/.test(command)) return [];
  return null;
}
export function install(w: any) {
  w.__TAURI_INTERNALS__ = { transformCallback: (callback: (value: unknown) => void) => { const id = ++nextCallback; callbacks.set(id, callback); return id; }, convertFileSrc: (path: string) => path,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, invoke };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event: string, id: number) => listeners.delete(id) };
  w.localChatFixture = { inspect };
}
