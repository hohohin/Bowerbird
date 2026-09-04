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
