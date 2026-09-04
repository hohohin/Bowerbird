import { ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  DSH_PROFILE_PLUGIN_FILES,
  DSH_PROFILE_TEMPLATE_FILES,
} from "./dsh-runtime-home.ts";

test("candidate image copies every file required by an isolated DSH runtime home", () => {
  const dockerfile = readFileSync(
    resolve(import.meta.dirname, "../../Dockerfile.unified-harness-candidate"),
    "utf8",
  );
  for (const file of DSH_PROFILE_TEMPLATE_FILES) {
    ok(dockerfile.includes(file), `candidate Dockerfile is missing ${file}`);
  }
  for (const file of DSH_PROFILE_PLUGIN_FILES) {
    ok(dockerfile.includes(`plugins/${file}`), `candidate Dockerfile is missing plugins/${file}`);
  }
  ok(dockerfile.includes("pnpm-workspace.yaml"));
  for (const path of [
    "/root/.cache/node/corepack",
    "/usr/local/lib/node_modules/corepack",
    "/usr/local/lib/node_modules/npm",
    "/usr/local/bin/pnpm",
  ]) {
    ok(dockerfile.includes(path), `candidate Dockerfile does not remove ${path}`);
  }
});

test("production compose builds the vetted DSH candidate with a bounded writable runtime root", () => {
  const compose = readFileSync(
    resolve(import.meta.dirname, "../../compose.generation.yml"),
    "utf8",
  );
  ok(compose.includes("dockerfile: Dockerfile.unified-harness-candidate"));
  ok(compose.includes(
    "dsh-profile: ${BOWERBIRD_DSH_BUILD_CONTEXT:-../../spikes/unified-agent-harness-u1/profiles/bowerbird-u1}",
  ));
  ok(compose.includes("/dsh-runtime:size=32m,mode=0700,uid=1000,gid=1000"));
});
