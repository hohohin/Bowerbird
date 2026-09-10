import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { DEFAULT_VIDEO_OPTIONS, videoInputError, videoRatio, isVideoPath } from "../src/lib/videoGeneration.ts";
import { mergeRecoveredGenJobs } from "../src/lib/generationRecovery.ts";
import { parseCreativeComposerDraft, serializeCreativeComposerDraft } from "../src/lib/creativeDraft.ts";
const image = (name) => ({ id: name, store_path: `C:/assets/${name}.png`, duration: null });
const video = (duration = 5) => ({ id: "video", store_path: "C:/assets/clip.mp4", duration });
const options = (kind) => ({ ...DEFAULT_VIDEO_OPTIONS, kind });

test("Seedance 2.5 validates all four explicit modes without silently dropping references", () => {
  assert.equal(videoInputError(options("text2video"), []), null);
  assert.match(videoInputError(options("text2video"), [image("a")]), /移除/);
  assert.equal(videoInputError(options("image2video"), [image("a")]), null);
  assert.match(videoInputError(options("image2video"), [video()]), /1 张图片/);
  assert.equal(videoInputError(options("frames2video"), [image("first"), image("last")]), null);
  assert.match(videoInputError(options("frames2video"), [image("first"), video()]), /2 张图片/);
  assert.equal(videoInputError(options("multimodal2video"), [image("a"), video()]), null);
  assert.match(videoInputError(options("multimodal2video"), []), /至少/);
  assert.match(videoInputError(options("multimodal2video"), [video(31)]), /2–30/);
  assert.match(videoInputError(options("multimodal2video"), [video(20), video(20)]), /总时长/);
  assert.match(videoInputError(options("multimodal2video"), Array.from({ length: 31 }, (_, i) => image(i))), /30 张/);
  assert.match(videoInputError(options("multiframe2video"), []), /不支持/);
  assert.match(videoInputError({ ...DEFAULT_VIDEO_OPTIONS, model_version: "seedance2.0" }, []), /2.5/);
  assert.match(videoInputError({ ...DEFAULT_VIDEO_OPTIONS, duration: 3 }, []), /4–30/);
  assert.match(videoInputError({ ...DEFAULT_VIDEO_OPTIONS, duration: 4.5 }, []), /整数/);
  assert.match(videoInputError(DEFAULT_VIDEO_OPTIONS, [], "2:3"), /比例/);
  assert.equal(videoRatio(options("frames2video"), "3:4"), null);
  assert.equal(videoRatio(options("text2video"), null), "16:9");
  assert.equal(isVideoPath("C:/ASSET.MP4"), true);
});

function harness() {
  const file = ts.createSourceFile("store.ts", readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const names = ["startGeneration", "sendGenRevise", "retryLastGenTurn", "loadGenJobs", "applyGenChunk", "reusePromptToBoard"];
  const actions = {};
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && names.includes(node.name.getText(file)) && ts.isArrowFunction(node.initializer)) actions[node.name.getText(file)] = node.initializer.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file);
  const state = { genJobs: {}, genJobOrder: [], presets: [], activeProjectId: "project-a", assets: [], dreaminaHealth: { ok: true } };
  const requests = [], errors = [];
  let id = 0;
  const bindings = {
    get: () => state, set: (update) => Object.assign(state, typeof update === "function" ? update(state) : update),
    normalizeGenerationProvider: (value) => value, generationGateError: () => null,
    normalizeAnnotationPrompt: (value) => value, autoRatioFromReferences: () => "3:4",
    nextGenTurnId: () => ++id, crypto: { randomUUID: () => `id-${++id}` },
    generationStartupWaiters: new Map(), api: { codexCreateImage: async (req) => { requests.push(req); } },
    taskErrorMessage: String, reconcileRejectedCloudSession: async () => {},
    genHandleError: (jobId, message) => errors.push({ jobId, message }),
    updateJob: (jobId, update) => { state.genJobs[jobId] = update(state.genJobs[jobId]); },
    videoInputError, videoRatio, isCloudProvider: value => value?.startsWith("bowerbird-cloud"),
    generationParentLocator: () => ({ storePath: "C:/assets/previous.mp4", nodeId: "parent-node" }),
    mergeRecoveredGenJobs, taskCenterGenerationJobs: () => [],
  };
  const code = ts.transpileModule(`return { ${Object.entries(actions).map(([name, body]) => `${name}: ${body}`).join(",")} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  Object.assign(state, new Function(...Object.keys(bindings), code)(...Object.values(bindings)));
  const start = (kind, refs, ratio = "9:16", provider = "jimeng") => state.startGeneration("prompt", refs, ratio, provider, "raw", undefined, undefined, [], null, { projectId: "project-a", threadId: "thread-a", referenceNodeIds: refs.map((_, i) => `ref-${i}`) }, false, { media: "video", videoOptions: options(kind) });
  return { state, requests, errors, start, api: bindings.api };
}

test("prompt reuse preserves exact nodes only inside the source project", () => {
  const { state } = harness();
  state.activeJobId = "source";
  state.genJobs.source = { projectId: "project-a", provider: "jimeng", refAssets: [image("a")], turns: [{ referenceNodeIds: ["source-node"] }] };
  state.reusePromptToBoard("same project");
  assert.deepEqual(state.pendingCreativeReuse.promptLoad.referenceNodeIds, ["source-node"]);
  state.activeProjectId = "project-b";
  state.reusePromptToBoard("different project");
  assert.equal(state.pendingCreativeReuse.promptLoad.referenceNodeIds, undefined);
  assert.deepEqual(state.pendingCreativeReuse.promptLoad.refs, [image("a")]);
  state.activeProjectId = null;
  state.reusePromptToBoard("new project");
  assert.equal(state.pendingCreativeReuse.promptLoad.referenceNodeIds, undefined);
});

test("production store sends exact first/last order and project/thread identity with no image ratio", async () => {
  const h = harness();
  await h.start("frames2video", [image("first"), image("last")]);
  const req = h.requests[0];
  assert.equal(req.media, "video");
  assert.equal(req.videoOptions.model_version, "seedance2.5");
  assert.deepEqual(req.referenceImages, ["C:/assets/first.png", "C:/assets/last.png"]);
  assert.equal(req.ratio, null);
  assert.equal(req.projectId, "project-a");
  assert.equal(req.threadId, "thread-a");
  assert.deepEqual(req.referenceNodeIds, ["ref-0", "ref-1"]);
  const job = h.state.genJobs[req.jobId];
  assert.deepEqual(job.turns[0].videoOptions, options("frames2video"));
});

test("production store rejects unsupported provider and inputs before calling the backend", async () => {
  const h = harness();
  await assert.rejects(h.start("text2video", [], "16:9", "codex"), /即梦/);
  await assert.rejects(h.start("image2video", [video()]), /1 张图片/);
  assert.equal(h.requests.length, 0);
});

test("video revision uses explicit references and never borrows the preceding MP4 for image2video", async () => {
  const h = harness();
  await h.start("image2video", [image("first")]);
  const job = h.state.genJobs[h.requests[0].jobId];
  job.sessionId = "submitted-video";
  job.running = false;
  job.turns[0].images = ["C:/assets/previous.mp4"];
  await assert.rejects(h.state.sendGenRevise(job.id, "revision", "jimeng", { references: [] }), /1 张图片/);
  await h.state.sendGenRevise(job.id, "revision", "jimeng", { references: [image("new-first")], generation: { media: "video", videoOptions: options("image2video") } });
  assert.deepEqual(h.requests[1].referenceImages, ["C:/assets/new-first.png"]);
  assert.equal(h.requests[1].exactReferences, true);
  assert.equal(h.requests[1].media, "video");
  assert.equal(h.requests[1].parentAssetPath, "C:/assets/previous.mp4");
});

test("Cloud route accepts 1080p while CLI keeps its supported resolutions", async () => {
  const o = { ...options("text2video"), video_resolution: "1080p" };
  assert.ok(videoInputError(o, [], "16:9", "jimeng"));
  assert.equal(videoInputError(o, [], "16:9", "bowerbird-cloud-video_seedance25_1080p"), null);
  const h = harness();
  await h.start("text2video", [], "16:9", "bowerbird-cloud-video_seedance25_720p");
  assert.equal(h.requests[0].provider, "bowerbird-cloud-video_seedance25_720p");
  assert.equal(h.requests[0].media, "video");
});

test("Cloud failed retry recovers original job after lost create response or download failure", async () => {
  for (const remote of [null, "saved-remote-id"]) {
    const h = harness();
    await h.start("text2video", [], "16:9", "bowerbird-cloud-video_seedance25_720p");
    const job = h.state.genJobs[h.requests[0].jobId];
    job.sessionId = remote; job.submitId = remote; job.running = false; job.turns[0].error = "connection lost";
    h.state.activeJobId = job.id;
    h.state.cloudAuth = { cloud_available: true, logged_in: true };
    const oldKey = job.turns[0].turnKey;
    const recovered = [];
    h.api.recoverCloudVideo = async id => { recovered.push(id); };
    h.state.loadGenJobs = async () => {};
    h.state.retryLastGenTurn([]);
    await Promise.resolve();
    assert.deepEqual(recovered, [job.id]);
    assert.equal(h.requests.length, 1, "retry never invokes a second create request");
    assert.equal(h.state.genJobs[job.id].turns[0].turnKey, oldKey);
  }
});

test("edited reference identity survives production revision, started event, and retry", async () => {
  const h = harness(); await h.start("image2video", [image("first")]);
  const job = h.state.genJobs[h.requests[0].jobId]; job.sessionId = "remote"; job.running = false;
  await h.state.sendGenRevise(job.id, "edit", "jimeng", { references: [image("first")], referenceNodeIds: ["another-instance"], generation: { media: "video", videoOptions: options("image2video") } });
  assert.deepEqual(h.requests[1].referenceNodeIds, ["another-instance"]);
  h.state.applyGenChunk({ kind: "started", job_id: job.id, references: [image("first").store_path], reference_node_ids: ["another-instance"] });
  h.state.genJobs[job.id].running = false;
  h.state.genJobs[job.id].turns.at(-1).error = "fixture interruption";
  h.state.activeJobId = job.id;
  h.state.retryLastGenTurn([]);
  assert.deepEqual(h.requests[2].referenceNodeIds, ["another-instance"]);
});

test("retry preserves an empty text2video reference list, duration, and original ratio", async () => {
  const h = harness();
  await h.start("text2video", []);
  const job = h.state.genJobs[h.requests[0].jobId];
  job.sessionId = "video-submitted";
  job.running = false;
  job.turns[0].error = "query interrupted";
  job.turns[0].refs = [];
  job.turns[0].videoOptions.duration = 12;
  h.state.activeJobId = job.id;
  h.state.retryLastGenTurn();
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(h.requests[1].referenceImages, []);
  assert.equal(h.requests[1].videoOptions.duration, 12);
  assert.equal(h.requests[1].ratio, "9:16");
  assert.equal(h.requests[1].creativeRelation, "retry");
});

test("project composer serialization retains video mode and immutable options", () => {
  const generation = { media: "video", videoOptions: options("multimodal2video"), ratio: "21:9" };
  const draft = { doc: { type: "doc" }, refs: [video()], generation };
  assert.deepEqual(parseCreativeComposerDraft(serializeCreativeComposerDraft(draft)), draft);
});

test("startup hydration preserves video settings when recover_started arrives first", () => {
  const live = { id: "job", provider: "jimeng", turns: [], streaming: "", running: true, lastPrompt: "", lastRefs: [], refAssets: [] };
  const persisted = { ...live, media: "video", videoOptions: options("frames2video"), projectId: "project-a", threadId: "thread-a" };
  const merged = mergeRecoveredGenJobs({ job: live }, ["job"], [persisted]);
  assert.equal(merged.jobs.job.media, "video");
  assert.deepEqual(merged.jobs.job.videoOptions, options("frames2video"));
});

test("retrieving a cancelled video updates its existing job instead of resubmitting", async () => {
  const h = harness();
  await h.start("text2video", []);
  const job = h.state.genJobs[h.requests[0].jobId];
  job.running = false; job.turns[0].error = "cancelled";
  h.state.applyGenChunk({ kind: "recover_started", job_id: job.id, media: "video", video_options: options("text2video"), submit_id: "existing-submit", prompt: "prompt", provider: "jimeng", references: [], ratio: "9:16" });
  assert.equal(h.state.genJobs[job.id].running, true);
  assert.equal(h.state.genJobs[job.id].turns[0].error, null);
  assert.equal(h.state.genJobs[job.id].submitId, "existing-submit");
  assert.equal(h.requests.length, 1);
  assert.equal(h.state.genJobs[job.id].threadId, "thread-a");
});

test("a recovery event creates a complete video placeholder before the task list arrives", () => {
  const h = harness();
  h.state.applyGenChunk({ kind: "recover_started", job_id: "restored", media: "video", video_options: options("frames2video"), submit_id: "existing-submit", prompt: "prompt", provider: "jimeng", references: ["first.png", "last.png"], ratio: null, project_id: "project-a", thread_id: "thread-a" });
  const job = h.state.genJobs.restored;
  assert.equal(job.media, "video");
  assert.deepEqual(job.videoOptions, options("frames2video"));
  assert.deepEqual(job.turns[0].refs, ["first.png", "last.png"]);
  assert.equal(job.threadId, "thread-a");
});

test("a video mode change updates the next composer defaults but preserves the first turn", async () => {
  const h = harness();
  await h.start("text2video", []);
  const job = h.state.genJobs[h.requests[0].jobId]; job.sessionId = "prior";
  await h.state.sendGenRevise(job.id, "frames", "jimeng", { references: [image("first"), image("last")], generation: { media: "video", videoOptions: options("frames2video") } });
  const current = h.state.genJobs[job.id];
  assert.equal(current.videoOptions.kind, "frames2video");
  assert.equal(current.lastRatio, null);
  assert.equal(current.turns[0].videoOptions.kind, "text2video");
  assert.equal(current.turns[0].ratio, "9:16");
});
