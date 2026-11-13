import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
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
  chat?: boolean;
  nativeSession?: {dir: string; sessionId:string};
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
  let disposed = false;
  function dispose() {
    if (disposed) return;
    const child = relative(runtimeRoot, home);
    if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("dsh_runtime_home_cleanup_unsafe");
    rmSync(home, { recursive: true, force: true });
    disposed = true;
  }
  try {
    mkdirSync(pluginDir, { recursive: true });
    for (const file of DSH_PROFILE_TEMPLATE_FILES) copyFileSync(join(templateDir, file), join(profileDir, file));
    for (const file of DSH_PROFILE_PLUGIN_FILES) copyFileSync(join(templateDir, "plugins", file), join(pluginDir, file));
    if (options.chat) {
      copyFileSync(join(import.meta.dirname, "../cloud-chat/cordis.chat.patch.yml"), join(profileDir, "cordis.chat.patch.yml"));
      copyFileSync(join(import.meta.dirname, "../cloud-chat/chat-cards.mjs"), join(pluginDir, "chat-cards.mjs"));
      copyFileSync(join(import.meta.dirname, "../../../cloud/supabase/functions/_shared/chat-card-tool.json"), join(pluginDir, "chat-card-tool.json"));
      if (options.nativeSession) {
        copyFileSync(join(import.meta.dirname, "../cloud-chat/native-chat-acp.mjs"), join(pluginDir, "native-chat-acp.mjs"));
        const file = join(profileDir, "cordis.chat.patch.yml");
        const patch = readFileSync(file, "utf8");
        writeFileSync(file, patch + "\n- id: acp\n  disabled: true\n- insert:\n    - id: native-chat-acp\n      name: './plugins/native-chat-acp.mjs'\n" +
          "- id: compaction-basic\n  config:\n    auto: true\n- id: session-persistence-jsonl\n  config:\n    root: " + JSON.stringify(options.nativeSession.dir) + "\n", "utf8");
      }
    }
    symlinkSync(templateModules, join(profileDir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    dispose();
    throw error;
  }

  const bridgePatch = join("profiles", PROFILE_NAME, "cordis.bridge.patch.yml");
  const controlledModelPatch = join("profiles", PROFILE_NAME, "cordis.controlled-model.patch.yml");
  const htmlExecutionPatch = join("profiles", PROFILE_NAME, "cordis.html-execution.patch.yml");
  const contentExecutionPatch = join("profiles", PROFILE_NAME, "cordis.content-execution.patch.yml");
  return {
    home,
    profileName: PROFILE_NAME,
    dshBin,
    bridgePatch,
    controlledModelPatch,
    htmlExecutionPatch,
    contentExecutionPatch,
    dispose,
  };
}
