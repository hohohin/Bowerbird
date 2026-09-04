import assert from "node:assert/strict";
import test from "node:test";

import { mergeRecoveredGenJobs } from "../src/lib/generationRecovery.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function job(overrides = {}) {
  return {
    id: "job-1",
    turns: [],
    sessionId: null,
    streaming: "",
    lastPrompt: "",
    lastRefs: [],
    refAssets: [],
    lastRatio: null,
    provider: "",
    projectId: null,
    createdAt: 200,
    running: true,
    ...overrides,
  };
}

test("a deferred generation list hydrates a recover_started placeholder without rolling back live state", async () => {
  const listed = deferred();
  const laterTurn = {
    id: 12,
    turnKey: "turn-2",
    prompt: "newer revise",
    images: ["newer.png"],
    provider: "live-provider",
    error: "newer terminal state",
  };
  let state = {
    jobs: {
      retained: job({ id: "retained", lastPrompt: "keep me" }),
    },
    order: ["retained"],
  };

  const load = (async () => {
    const persisted = await listed.promise;
    state = mergeRecoveredGenJobs(state.jobs, state.order, persisted);
  })();

  // Mirrors recover_started plus newer chunks arriving after listGenJobs starts.
  state = {
    jobs: {
      ...state.jobs,
      "job-1": job({
        turns: [
          {
            id: 11,
            turnKey: "turn-1",
            prompt: "recover prompt",
            appliedPrompt: null,
            promptRaw: null,
            images: ["live-image.png"],
            refs: [],
            refAssets: [],
            provider: "live-provider",
          },
          laterTurn,
        ],
        streaming: "newer polling message",
        running: false,
        remoteStatus: "success",
      }),
    },
    order: ["retained", "job-1"],
  };

  listed.resolve([
    job({
      conversationId: "conversation-1",
      threadId: "thread-1",
      creativeSessionId: "legacy-session-1",
      turns: [{
        id: 1,
        turnKey: "turn-1",
        prompt: "persisted prompt",
        appliedPrompt: "compiled prompt",
        promptRaw: "raw prompt",
        images: ["stale-image.png"],
        refs: ["reference.png"],
        refAssets: [{ id: "asset-ref" }],
        provider: "persisted-provider",
      }],
      sessionId: "provider-session-1",
      lastPrompt: "persisted prompt",
      lastRefs: ["reference.png"],
      lastRatio: "3:4",
      provider: "persisted-provider",
      projectId: "project-1",
      visualProfile: { profileId: "profile-1" },
      visualProfileId: "profile-1",
      createdAt: 100,
      submitId: "submit-1",
      running: true,
      remoteStatus: "querying",
    }),
  ]);
  await load;

  const recovered = state.jobs["job-1"];
  assert.equal(recovered.conversationId, "conversation-1");
  assert.equal(recovered.sessionId, "provider-session-1");
  assert.equal(recovered.projectId, "project-1");
  assert.equal(recovered.threadId, "thread-1");
  assert.equal(recovered.creativeSessionId, "legacy-session-1");
  assert.deepEqual(recovered.lastRefs, ["reference.png"]);
  assert.equal(recovered.lastRatio, "3:4");
  assert.equal(recovered.visualProfileId, "profile-1");
  assert.equal(recovered.submitId, "submit-1");
  assert.equal(recovered.createdAt, 100);

  assert.equal(recovered.streaming, "newer polling message");
  assert.equal(recovered.running, false);
  assert.equal(recovered.remoteStatus, "success");
  assert.deepEqual(recovered.turns.map((turn) => turn.turnKey), ["turn-1", "turn-2"]);
  assert.equal(recovered.turns[0].appliedPrompt, "compiled prompt");
  assert.equal(recovered.turns[0].promptRaw, "raw prompt");
  assert.deepEqual(recovered.turns[0].refs, ["reference.png"]);
  assert.deepEqual(recovered.turns[0].refAssets, [{ id: "asset-ref" }]);
  assert.deepEqual(recovered.turns[0].images, ["live-image.png"]);
  assert.equal(recovered.turns[0].provider, "live-provider");
  assert.equal(recovered.turns[1], laterTurn);
  assert.equal(state.jobs.retained.lastPrompt, "keep me");
  assert.deepEqual(state.order, ["retained", "job-1"]);
});
