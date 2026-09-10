import test from "node:test";
import assert from "node:assert/strict";
import {
  awaitGenerationComposerIntent,
  captureGenerationSubmissionAuthority,
} from "../src/lib/generationIntent.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a deferred Agent compile cannot revise a newly opened generation job", async () => {
  const compileA = deferred();
  const current = {
    token: 1,
    activeJobId: "job-a",
    mode: "revise",
  };
  const intentA = {
    token: 1,
    jobId: "job-a",
    mode: "revise",
  };
  const revisions = [];

  const pending = (async () => {
    const compiled = await awaitGenerationComposerIntent(
      intentA,
      () => current,
      () => compileA.promise,
    );
    if (compiled.current) {
      revisions.push({ jobId: intentA.jobId, prompt: compiled.value.prompt });
    }
  })();

  // Equivalent to opening B while A's local Agent compilation is still pending.
  current.activeJobId = "job-b";
  compileA.resolve({ prompt: "compiled-a" });
  await pending;

  assert.deepEqual(revisions, []);
});

test("a deferred prompt compile keeps the provider and visual profile from the send click", async () => {
  const compile = deferred();
  const preferences = { provider: "codex", visualProfileId: "profile-a" };
  const authority = captureGenerationSubmissionAuthority(preferences);
  const submitted = [];

  const pending = (async () => {
    await compile.promise;
    submitted.push(authority);
  })();

  preferences.provider = "jimeng";
  preferences.visualProfileId = "profile-b";
  compile.resolve();
  await pending;

  assert.deepEqual(submitted, [{ provider: "codex", visualProfileId: "profile-a" }]);
});

// Execute the production store actions with a deferred provider command.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { acquireCreativeSubmission } from "../src/lib/creativeGeneration.ts";

function startupHarness() {
  const source = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("store.ts", source, ts.ScriptTarget.Latest, true);
  const actions = {};
  function visit(node) {
    if (ts.isPropertyAssignment(node) && ["startGeneration", "applyGenChunk"].includes(node.name.getText(file)) && ts.isArrowFunction(node.initializer)) {
      actions[node.name.getText(file)] = node.initializer.getText(file);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  let resolve, reject;
  const provider = new Promise((yes, no) => { resolve = yes; reject = no; });
  const state = { genJobs: {}, genJobOrder: [], presets: [], activeProjectId: "startup-test" };
  const errors = [];
  const waiters = new Map();
  const bindings = {
    get: () => state, set: (update) => Object.assign(state, update(state)),
    normalizeGenerationProvider: (value) => value, generationGateError: () => null,
    normalizeAnnotationPrompt: (value) => value, autoRatioFromReferences: () => null,
    nextGenTurnId: () => 1, crypto: { randomUUID: () => "job-start" },
    generationStartupWaiters: waiters, api: { codexCreateImage: () => provider },
    taskErrorMessage: String, reconcileRejectedCloudSession: async () => {},
    genHandleError: (id, message) => errors.push({ id, message }),
    updateJob: (id, update) => { state.genJobs[id] = update(state.genJobs[id]); },
  };
  const code = ts.transpileModule(`const start = ${actions.startGeneration}; const chunk = ${actions.applyGenChunk};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const handlers = new Function(...Object.keys(bindings), code + "; return { start, chunk };")(...Object.values(bindings));
  return { ...handlers, state, errors, waiters, resolve, reject,
    submit: (early) => handlers.start("prompt", [], null, "codex", undefined, undefined, undefined, undefined, null, undefined, early) };
}

test("backend started releases the project claim while generation is still running", async () => {
  const h = startupHarness();
  const claim = acquireCreativeSubmission("startup-test");
  let settled = false;
  const pending = h.submit(true).finally(() => { settled = true; claim.release(); });
  assert.equal(acquireCreativeSubmission("startup-test"), null);
  h.chunk({ kind: "started", job_id: "unrelated" });
  await Promise.resolve();
  assert.equal(settled, false);
  h.chunk({ kind: "started", job_id: "job-start" });
  assert.deepEqual(await pending, { jobId: "job-start", accepted: true });
  assert.equal(h.state.genJobs["job-start"].running, true);
  const next = acquireCreativeSubmission("startup-test");
  assert.ok(next);
  next.release();
  assert.equal(h.waiters.size, 0);
  h.reject(new Error("late provider failure"));
  await new Promise((done) => setImmediate(done));
  assert.equal(h.state.genJobs["job-start"].running, false);
  assert.match(h.errors[0].message, /late provider failure/);
});

test("startup rejection returns failure and clears its waiter", async () => {
  const h = startupHarness();
  const pending = h.submit(true);
  h.reject(new Error("startup denied"));
  assert.deepEqual(await pending, { jobId: "job-start", accepted: false, error: "Error: startup denied" });
  assert.equal(h.waiters.size, 0);
  assert.equal(h.state.genJobs["job-start"].running, false);
});

test("completion callers still wait for images and commands without started still settle", async () => {
  for (const early of [false, true]) {
    const h = startupHarness();
    let settled = false;
    const pending = h.submit(early).then((result) => { settled = true; return result; });
    if (!early) h.chunk({ kind: "started", job_id: "job-start" });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled, false);
    h.resolve("job-start");
    assert.equal((await pending).accepted, true);
    assert.equal(h.waiters.size, 0);
  }
});
