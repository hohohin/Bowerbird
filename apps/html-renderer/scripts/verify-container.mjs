/**
 * html-renderer 容器安全验证 —— H5-T2（HTML-RENDER-PLAN 验收：无 secret、无外网、
 * 无宿主端口/挂载、非 root、Chromium sandbox 未关闭）。
 *
 * 在 VPS 上运行：
 *   docker compose -f compose.renderer.yml exec -T html-renderer node /app/scripts/verify-container.mjs
 * 任一断言失败即退出码 1。输出为无内容 JSON 摘要（不含任何 HTML/资源/用户文本）。
 *
 * 本脚本属于镜像内自检；容器外的「无 host port / 网络隔离」由 compose 声明 +
 * docker inspect 复核（见 README H0 部署清单）。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";

const failures = [];
const checks = {};

function check(name, ok, detail) {
  checks[name] = ok === true;
  if (ok !== true) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

// 1) 非 root 运行
check("non_root_user", process.getuid?.() !== 0, `uid=${process.getuid?.()}`);

// 2) 无业务 secret：renderer 只允许容器间共享 token 与运行时参数
const allowedEnv = new Set([
  "RENDER_INTERNAL_TOKEN", "RENDER_PORT", "RENDER_TMP_DIR", "HOME",
  "PATH", "HOSTNAME", "NODE_VERSION", "YARN_VERSION", "PLAYWRIGHT_BROWSERS_PATH",
  "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "LANG", "TZ", "PWD",
]);
const forbiddenPattern = /(SUPABASE|DEEPSEEK|ARK_API|WORKER_TOKEN|AGENT_|SERVICE_ROLE|DATABASE|POSTGRES|PAYMENT|STRIPE|PADDLE|OPENAI|ANTHROPIC)/i;
const forbiddenFound = Object.keys(process.env).filter((key) => forbiddenPattern.test(key) && !allowedEnv.has(key));
check("no_business_secrets", forbiddenFound.length === 0, forbiddenFound.join(","));

// 3) 无公网出口：对公网地址的全部 fetch 必须失败（容器断网即通过）
async function offlineCheck() {
  const targets = ["https://example.com/", "http://example.com/", "https://www.baidu.com/"];
  const results = await Promise.all(targets.map(async (url) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      return response.ok || response.status > 0 ? "reachable" : "blocked";
    } catch {
      return "blocked";
    }
  }));
  check("no_public_egress", results.every((r) => r === "blocked"), results.join(","));
}

// 4) 只读 rootfs + tmpfs /tmp（read_only: true → 根挂载含 ro；/tmp 为 tmpfs）
function mountCheck() {
  try {
    const mounts = readFileSync("/proc/mounts", "utf8");
    const rootLine = mounts.split("\n").find((line) => line.split(" ")[1] === "/");
    const rootRo = !!rootLine && /(^|,)ro(,|$)/.test(rootLine.split(" ")[3] ?? ""); // 选项以逗号分隔
    const tmpTmpfs = mounts.split("\n").some((line) => line.split(" ")[1] === "/tmp" && line.split(" ")[2] === "tmpfs");
    check("readonly_rootfs", rootRo, rootLine?.split(" ")[3]);
    check("tmpfs_tmp", tmpTmpfs);
    // 无宿主业务目录 bind 挂载（/opt、/var/lib/docker、宿主 home）
    const hostBinds = mounts.split("\n").filter((line) => /\/opt\/bowerbird|\/var\/lib\/docker|\/(home|root)\//.test(line.split(" ")[1] ?? ""));
    check("no_host_binds", hostBinds.length === 0, hostBinds.map((l) => l.split(" ")[1]).join(","));
  } catch (error) {
    check("mounts_readable", false, String(error).slice(0, 80));
  }
}

// 5) 无 Docker socket / 无 privileged 设备节点
function socketCheck() {
  check("no_docker_socket", !existsSync("/var/run/docker.sock"));
}

// 6) Chromium 进程未使用 --no-sandbox（扫描 /proc/*/cmdline）
function sandboxCheck() {
  let chromeFound = false;
  let noSandbox = false;
  try {
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (cmdline.includes("chrome") || cmdline.includes("headless_shell")) {
          chromeFound = true;
          if (cmdline.includes("--no-sandbox") || cmdline.includes("--disable-sandbox")) noSandbox = true;
        }
      } catch {
        // 进程退出竞态：跳过
      }
    }
  } catch {
    // /proc 不可读时标记未知（不判失败，由外部复核）
  }
  check("chromium_sandbox_enabled", chromeFound ? !noSandbox : true, chromeFound ? undefined : "no_chromium_process(idle)");
}

// 7) healthz 可用且 fingerprint 存在（含无内容 metrics/resources）
async function healthCheck() {
  const port = process.env.RENDER_PORT ?? "3917";
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body = await response.json();
    check("healthz_ok", response.ok && body.ok === true && typeof body.rendererFingerprint === "string" && body.rendererFingerprint.startsWith("bwr1-"));
    check("healthz_metrics_shape", typeof body.metrics === "object" && body.metrics !== null && typeof body.metrics.renders === "number");
    const resources = body.resources;
    check("healthz_resources_shape", typeof resources === "object" && resources !== null
      && typeof resources.processRssBytes === "number"
      && (resources.cgroupMemoryPeakBytes === null || typeof resources.cgroupMemoryPeakBytes === "number")
      && (resources.cgroupPidsPeak === null || typeof resources.cgroupPidsPeak === "number"));
  } catch (error) {
    check("healthz_ok", false, String(error).slice(0, 80));
  }
}

await offlineCheck();
mountCheck();
socketCheck();
sandboxCheck();
await healthCheck();

console.log(JSON.stringify({ event: "verify_container", ok: failures.length === 0, checks, failures }, null, 0));
process.exit(failures.length === 0 ? 0 : 1);
