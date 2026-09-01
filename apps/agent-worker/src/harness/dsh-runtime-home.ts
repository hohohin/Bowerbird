import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const PROFILE_NAME = "bowerbird-u1";
export const DSH_PROFILE_TEMPLATE_FILES = [
  "package.json",
  "cordis.yml",
  "cordis.patch.yml",
  "cordis.bridge.patch.yml",
  "cordis.controlled-model.patch.yml",
  "cordis.html-execution.patch.yml",
  "cordis.content-execution.patch.yml",
] as const;
export const DSH_PROFILE_PLUGIN_FILES = [
  "bowerbird-planning-rpc.mjs",
  "bowerbird-planning-tools.mjs",
  "bowerbird-controlled-model-tools.mjs",
  "bowerbird-html-execution-tools.mjs",
  "bowerbird-content-execution-tools.mjs",
] as const;

export type DshRuntimeHome = {
  home: string;
  profileName: typeof PROFILE_NAME;
  dshBin: string;
  bridgePatch: string;
  controlledModelPatch: string;
  htmlExecutionPatch: string;
  contentExecutionPatch: string;
  dispose(): void;
};

function requiredPath(path: string): string {
  if (!existsSync(path)) throw new Error("dsh_profile_template_incomplete");
  return path;
}

/**
 * Clone only mutable DSH profile metadata into a fresh bounded runtime root.
 * The dependency tree remains immutable and is reached through one directory link.
 */
export function createDshRuntimeHome(options: {
  templateDir: string;
  runtimeRoot: string;
}): DshRuntimeHome {
  const templateDir = resolve(options.templateDir);
  const runtimeRoot = resolve(options.runtimeRoot);
  const filesystemRoot = resolve("/");
  if (runtimeRoot === filesystemRoot || runtimeRoot === templateDir) {
    throw new Error("dsh_runtime_root_unsafe");
  }

  const templateModules = requiredPath(join(templateDir, "node_modules"));
  const dshBin = requiredPath(join(templateModules, "@deepseek-ai", "dsh", "lib", "bin.js"));
  for (const file of DSH_PROFILE_TEMPLATE_FILES) requiredPath(join(templateDir, file));
  for (const file of DSH_PROFILE_PLUGIN_FILES) requiredPath(join(templateDir, "plugins", file));

  mkdirSync(runtimeRoot, { recursive: true });
  const home = mkdtempSync(join(runtimeRoot, "home-"));
  const profileDir = join(home, "profiles", PROFILE_NAME);
  const pluginDir = join(profileDir, "plugins");
  mkdirSync(pluginDir, { recursive: true });
  for (const file of DSH_PROFILE_TEMPLATE_FILES) copyFileSync(join(templateDir, file), join(profileDir, file));
  for (const file of DSH_PROFILE_PLUGIN_FILES) copyFileSync(join(templateDir, "plugins", file), join(pluginDir, file));
  symlinkSync(templateModules, join(profileDir, "node_modules"), process.platform === "win32" ? "junction" : "dir");

  const bridgePatch = join("profiles", PROFILE_NAME, "cordis.bridge.patch.yml");
  const controlledModelPatch = join("profiles", PROFILE_NAME, "cordis.controlled-model.patch.yml");
  const htmlExecutionPatch = join("profiles", PROFILE_NAME, "cordis.html-execution.patch.yml");
  const contentExecutionPatch = join("profiles", PROFILE_NAME, "cordis.content-execution.patch.yml");
  let disposed = false;
  return {
    home,
    profileName: PROFILE_NAME,
    dshBin,
    bridgePatch,
    controlledModelPatch,
    htmlExecutionPatch,
    contentExecutionPatch,
    dispose() {
      if (disposed) return;
      disposed = true;
      const child = relative(runtimeRoot, home);
      if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("dsh_runtime_home_cleanup_unsafe");
      rmSync(home, { recursive: true, force: true });
    },
  };
}
