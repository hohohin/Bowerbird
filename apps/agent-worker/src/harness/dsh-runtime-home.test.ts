import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDshRuntimeHome } from "./dsh-runtime-home.ts";

function fixtureRoot(name: string): string {
  return join(tmpdir(), `bowerbird-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

test("DSH runtime home keeps dependencies immutable and cleans only its fresh child", () => {
  const root = fixtureRoot("dsh-home");
  const template = join(root, "template");
  const runtime = join(root, "runtime");
  mkdirSync(join(template, "plugins"), { recursive: true });
  mkdirSync(join(template, "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  for (const file of ["package.json", "cordis.yml", "cordis.patch.yml", "cordis.bridge.patch.yml", "cordis.controlled-model.patch.yml", "cordis.html-execution.patch.yml", "cordis.content-execution.patch.yml"]) {
    writeFileSync(join(template, file), file, "utf8");
  }
  for (const file of ["bowerbird-planning-rpc.mjs", "bowerbird-planning-tools.mjs", "bowerbird-controlled-model-tools.mjs", "bowerbird-html-execution-tools.mjs", "bowerbird-content-execution-tools.mjs"]) {
    writeFileSync(join(template, "plugins", file), file, "utf8");
  }
  writeFileSync(join(template, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), "bin", "utf8");
  writeFileSync(join(template, "node_modules", "immutable-proof.txt"), "immutable", "utf8");
  const planningFile = "cordis.bridge.patch.yml";
  const templateProfile = readFileSync(join(import.meta.dirname, "../../../../spikes/unified-agent-harness-u1/profiles/bowerbird-u1", planningFile), "utf8");
  writeFileSync(join(template, planningFile), templateProfile, "utf8");

  try {
    const home = createDshRuntimeHome({ templateDir: template, runtimeRoot: runtime });
    const profile = join(home.home, "profiles", home.profileName);
    assert.equal(readFileSync(join(profile, planningFile), "utf8"), templateProfile);
    assert.equal(readFileSync(join(profile, "cordis.controlled-model.patch.yml"), "utf8"), "cordis.controlled-model.patch.yml");
    assert.equal(readFileSync(join(profile, "cordis.html-execution.patch.yml"), "utf8"), "cordis.html-execution.patch.yml");
    assert.equal(readFileSync(join(profile, "cordis.content-execution.patch.yml"), "utf8"), "cordis.content-execution.patch.yml");
    assert.equal(readFileSync(join(profile, "node_modules", "immutable-proof.txt"), "utf8"), "immutable");
    assert.equal(home.bridgePatch, "profiles\\bowerbird-u1\\cordis.bridge.patch.yml".replaceAll("\\", process.platform === "win32" ? "\\" : "/"));
    assert.equal(home.controlledModelPatch, "profiles\\bowerbird-u1\\cordis.controlled-model.patch.yml".replaceAll("\\", process.platform === "win32" ? "\\" : "/"));
    assert.equal(home.htmlExecutionPatch, "profiles\\bowerbird-u1\\cordis.html-execution.patch.yml".replaceAll("\\", process.platform === "win32" ? "\\" : "/"));
    assert.equal(home.contentExecutionPatch, "profiles\\bowerbird-u1\\cordis.content-execution.patch.yml".replaceAll("\\", process.platform === "win32" ? "\\" : "/"));
    home.dispose();
    assert.equal(existsSync(home.home), false);
    assert.equal(existsSync(template), true);
    const optimizer = createDshRuntimeHome({ templateDir: template, runtimeRoot: runtime, planningReasoningEffort: "high" });
    try {
      const profile = readFileSync(join(optimizer.home, optimizer.bridgePatch), "utf8");
      assert.match(profile, /^ +thinking: enabled$/m);
      assert.match(profile, /^ +reasoningEffort: high$/m);
      assert.match(profile, /id: deepseek-flash/);
      assert.equal(readFileSync(join(template, planningFile), "utf8"), templateProfile);
    } finally { optimizer.dispose(); }
    for (const imageCardProvider of [false, true]) for (const videoCardOptions of [undefined, false, true]) for (const h3R2v of [false, true]) {
      const chat = createDshRuntimeHome({ templateDir: template, runtimeRoot: runtime, chat: true, imageCardProvider, videoCardOptions, h3R2v, chatOptions: { model: "deepseek-v4-pro", reasoningEffort: "max" } });
      try {
        const schema = JSON.parse(readFileSync(join(chat.home, "profiles", chat.profileName, "plugins", "chat-card-tool.json"), "utf8"));
        const profile = readFileSync(join(chat.home, "profiles", chat.profileName, "cordis.chat.patch.yml"), "utf8");
        assert.match(profile, /id: deepseek-v4-pro/);
        assert.match(profile, /thinking: enabled/);
        assert.match(profile, /reasoningEffort: max/);
        const fields = schema.inputSchema.properties.cards.items.properties;
        assert.equal(!!fields.videoOptions, videoCardOptions === true);
        assert.equal(!!fields.videoChannel, videoCardOptions === true);
        assert.equal(fields.mode.enum.includes("reference"), videoCardOptions === true);
        assert.equal(fields.resolution.enum.includes(0.98), videoCardOptions === true);
        const supportsR2v = h3R2v && videoCardOptions === true;
        assert.equal(fields.mode.enum.includes("r2v"), supportsR2v);
        assert.equal(schema.inputSchema.properties.connections.items.properties.input.enum.includes("reference-video"), supportsR2v);
        assert.equal(schema.description.includes("H3 R2V"), supportsR2v);
        const field = fields.provider;
        if (imageCardProvider) assert.ok(field.enum.includes("dreamina-web55"));
        else assert.equal(field, undefined);
      } finally { chat.dispose(); }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DSH runtime home rejects the filesystem root", () => {
  assert.throws(
    () => createDshRuntimeHome({ templateDir: fixtureRoot("missing"), runtimeRoot: "/" }),
    /dsh_runtime_root_unsafe/,
  );
});
