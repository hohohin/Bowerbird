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

  try {
    const home = createDshRuntimeHome({ templateDir: template, runtimeRoot: runtime });
    const profile = join(home.home, "profiles", home.profileName);
    assert.equal(readFileSync(join(profile, "cordis.bridge.patch.yml"), "utf8"), "cordis.bridge.patch.yml");
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

function canonicalTemplate(template: string): void {
  mkdirSync(join(template, "plugins"), { recursive: true });
  mkdirSync(join(template, "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  for (const file of ["package.json", "cordis.yml", "cordis.patch.yml", "cordis.bridge.patch.yml", "cordis.controlled-model.patch.yml", "cordis.html-execution.patch.yml", "cordis.content-execution.patch.yml"]) {
    writeFileSync(join(template, file), file, "utf8");
  }
  for (const file of ["bowerbird-planning-rpc.mjs", "bowerbird-planning-tools.mjs", "bowerbird-controlled-model-tools.mjs", "bowerbird-html-execution-tools.mjs", "bowerbird-content-execution-tools.mjs"]) {
    writeFileSync(join(template, "plugins", file), file, "utf8");
  }
  writeFileSync(join(template, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), "bin", "utf8");
}

test("DSH runtime home copies the optional agent-ds group only when fully present", () => {
  const root = fixtureRoot("dsh-home-agent-ds");
  try {
    const withGroup = join(root, "with-group");
    canonicalTemplate(withGroup);
    writeFileSync(join(withGroup, "cordis.agent-ds.patch.yml"), "agent-ds", "utf8");
    writeFileSync(join(withGroup, "plugins", "bowerbird-agent-ds-tools.mjs"), "tools", "utf8");
    const home = createDshRuntimeHome({ templateDir: withGroup, runtimeRoot: join(root, "runtime") });
    const profile = join(home.home, "profiles", home.profileName);
    assert.equal(readFileSync(join(profile, "cordis.agent-ds.patch.yml"), "utf8"), "agent-ds");
    assert.equal(readFileSync(join(profile, "plugins", "bowerbird-agent-ds-tools.mjs"), "utf8"), "tools");
    assert.equal(home.agentDsPatch, "profiles\\bowerbird-u1\\cordis.agent-ds.patch.yml".replaceAll("\\", process.platform === "win32" ? "\\" : "/"));
    home.dispose();

    const withoutGroup = join(root, "without-group");
    canonicalTemplate(withoutGroup);
    const plain = createDshRuntimeHome({ templateDir: withoutGroup, runtimeRoot: join(root, "runtime-2") });
    assert.equal(plain.agentDsPatch, undefined);
    assert.equal(existsSync(join(plain.home, "profiles", plain.profileName, "cordis.agent-ds.patch.yml")), false);
    plain.dispose();

    const halfGroup = join(root, "half-group");
    canonicalTemplate(halfGroup);
    writeFileSync(join(halfGroup, "cordis.agent-ds.patch.yml"), "agent-ds", "utf8");
    assert.throws(
      () => createDshRuntimeHome({ templateDir: halfGroup, runtimeRoot: join(root, "runtime-3") }),
      /dsh_profile_template_incomplete/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
