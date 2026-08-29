import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const profileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const spikeRoot = path.resolve(profileDir, "..", "..");
const dshBin = path.join(profileDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

const WINDOWS_RUNTIME_ENV = ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"];
const POSIX_RUNTIME_ENV = ["PATH", "TMPDIR", "LANG", "LC_ALL"];

export function buildDshEnv(parentEnv = process.env, { allowNetwork = false } = {}) {
  const env = Object.create(null);
  const allowedRuntimeKeys = process.platform === "win32" ? WINDOWS_RUNTIME_ENV : POSIX_RUNTIME_ENV;

  for (const key of allowedRuntimeKeys) {
    if (parentEnv[key]) env[key] = parentEnv[key];
  }

  env.DSH_HOME = spikeRoot;
  env.DSH_TELEMETRY_DISABLED = "1";
  env.DSH_PERMISSION_MODE = "read-only";
  env.BOWERBIRD_U1_SPIKE = "1";

  if (allowNetwork) {
    if (parentEnv.BOWERBIRD_U1_ALLOW_NETWORK !== "1") {
      throw new Error("BOWERBIRD_U1_ALLOW_NETWORK=1 is required for a network smoke");
    }
    if (!parentEnv.DEEPSEEK_API_KEY) {
      throw new Error("DEEPSEEK_API_KEY is required for a network smoke");
    }
    env.DEEPSEEK_API_KEY = parentEnv.DEEPSEEK_API_KEY;
    if (parentEnv.DEEPSEEK_BASE_URL) {
      env.DEEPSEEK_BASE_URL = parentEnv.DEEPSEEK_BASE_URL;
    }
  }

  return env;
}

export function spawnDsh(args, options = {}) {
  return spawn(process.execPath, [dshBin, "--profile", "bowerbird-u1", ...args], {
    cwd: spikeRoot,
    env: buildDshEnv(process.env, options),
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

export async function runDsh(args, options = {}) {
  const child = spawnDsh(args, options);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => (stdout += chunk));
  child.stderr?.on("data", (chunk) => (stderr += chunk));

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? -1));
  });

  return { exitCode, stdout, stderr };
}
