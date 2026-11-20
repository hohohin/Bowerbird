import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { previousChinaDay } from "./wechatpay-maintenance.mjs";

const worker = "agent-worker-generation-worker-1";
const tmpfsPaths = ["/tmp", "/workspaces", "/dsh-runtime"];
const agentProbe = fileURLToPath(new URL("./check-agent-runtime-health.mjs", import.meta.url));
const minute = 60_000;
const diskWarningBytes = 5 * 1024 ** 3;
const count = value => Number.isSafeInteger(value) && value >= 0;
const kibibytesToBytes = value => /^\d+$/.test(value) ? Number(value) * 1024 : NaN;

function runCommand(command, args, timeout = 8_000) {
  return spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    timeout,
    maxBuffer: 1024 ** 2,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function filesystem(row) {
  const fields = row?.trim().split(/\s+/) ?? [];
  if (fields.length !== 7 || !fields[6].startsWith("/") || !/^\d+%$/.test(fields[5])) {
    throw new Error("invalid_df_row");
  }
  const sizeBytes = kibibytesToBytes(fields[2]);
  const availableBytes = kibibytesToBytes(fields[4]);
  const usedPercent = Number.parseInt(fields[5], 10);
  if (!count(sizeBytes) || sizeBytes === 0 || !count(availableBytes) || availableBytes > sizeBytes
      || !count(usedPercent)) throw new Error("invalid_df_capacity");
  return { type: fields[1], sizeBytes, availableBytes, usedPercent, mount: fields[6] };
}

function readAgentQueue(command) {
  const result = command(process.execPath, [agentProbe], 40_000);
  if (result.error || ![0, 1].includes(result.status)) throw new Error("agent_probe_unavailable");
  const report = JSON.parse(result.stdout.split(/\r?\n/, 1)[0]);
  const { queueDepth, oldestQueuedAgeSeconds, activeRuns, expiredLeases, ttlBacklog } = report.metrics ?? {};
  if (report.event !== "agent_health_probe" || !Array.isArray(report.alerts)
    || result.status !== Number(report.alerts.length > 0)
    || ![queueDepth, oldestQueuedAgeSeconds, activeRuns, expiredLeases, ttlBacklog?.runs, ttlBacklog?.artifacts].every(count)) {
    throw new Error("agent_probe_invalid");
  }
  const thresholds = report.alerts.map(alert => {
    const match = /^(queue_depth|oldest_queue_seconds|expired_leases|success_rate|ttl_backlog)=\d+(?:\.\d+)?$/.exec(alert);
    if (!match) throw new Error("agent_probe_invalid_alert");
    return match[1];
  });
  return { queueDepth, oldestQueuedAgeSeconds, activeRuns, expiredLeases, ttlRuns: ttlBacklog.runs,
    ttlArtifacts: ttlBacklog.artifacts, thresholds };
}

function readPayment(mode, read, now) {
  const unit = `bowerbird-wechatpay-${mode}`;
  const timerActive = read("systemctl", ["show", "--property=ActiveState", "--value", `${unit}.timer`]).trim() === "active";
  // A completed oneshot is normally inactive. Its Result distinguishes an exit failure from that state.
  const serviceSuccessful = read("systemctl", ["show", "--property=Result", "--value", `${unit}.service`]).trim() === "success";
  const log = read("journalctl", ["--no-pager", `--unit=${unit}.service`, "--output=json",
    "--reverse", "--lines=200", `--since=${mode === "bill" ? "2 days ago" : "15 minutes ago"}`]);
  let latestOutcome;
  let latestSuccess;
  let reportedFailures = 0;
  for (const line of log.trim().split(/\r?\n/).filter(Boolean)) {
    const entry = JSON.parse(line);
    if (typeof entry.MESSAGE !== "string" || !entry.MESSAGE.startsWith("{")) continue;
    const message = JSON.parse(entry.MESSAGE);
    if (message.ok === false) {
      latestOutcome ??= "failure";
      reportedFailures++;
      continue;
    }
    if (message.ok !== true || message.task !== mode) continue;
    const timestamp = Number(entry.__REALTIME_TIMESTAMP) / 1000;
    if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now.getTime()) continue;
    const validResult = mode === "bill"
      ? message.status === "matched" && message.difference_count === 0 && /^\d{4}-\d{2}-\d{2}$/.test(message.bill_date)
      : count(message.processed) && message.failed === 0;
    latestOutcome ??= validResult ? "success" : "failure";
    if (validResult && (!latestSuccess || (mode === "bill" && message.bill_date > latestSuccess.billDate))) {
      latestSuccess = { timestamp, billDate: mode === "bill" ? message.bill_date : null };
    }
  }
  // The timer is scheduled at 10:30 Beijing time. Allow 15 minutes for a scheduled result.
  const expectedBillDate = mode === "bill" ? previousChinaDay(new Date(now.getTime() - (10 * 60 + 45) * minute)) : null;
  const current = !!latestSuccess && (mode === "bill"
    ? latestSuccess.billDate >= expectedBillDate && latestSuccess.billDate <= previousChinaDay(now)
    : now.getTime() - latestSuccess.timestamp <= 5 * minute);
  return { timerActive, serviceSuccessful, current, latestOutcome: latestOutcome ?? "missing",
    latestSuccessAt: latestSuccess ? new Date(latestSuccess.timestamp).toISOString() : null,
    successfulBillDate: latestSuccess?.billDate ?? null, expectedBillDate, reportedFailures };
}

export function collectVpsHealth({ command = runCommand, now = new Date() } = {}) {
  const alerts = [];
  const checks = {};
  let incomplete = false;
  function read(commandName, args) {
    const result = command(commandName, commandName === "docker" ? ["--host=unix:///var/run/docker.sock", ...args] : args);
    if (result.error || result.status !== 0) throw new Error("command_unavailable");
    return result.stdout;
  }
  function check(name, collect) {
    try {
      checks[name] = collect();
    } catch {
      checks[name] = null;
      alerts.push(`${name}_unavailable`);
      incomplete = true;
    }
  }
  function disk(name, target) {
    const lines = read("df", ["-P", "-T", "-k", "--", target]).trim().split(/\r?\n/);
    const state = filesystem(lines[1]);
    if (state.usedPercent >= 85 || state.availableBytes < diskWarningBytes) alerts.push(`${name}_low_space`);
    return state;
  }
  check("root_disk", () => disk("root_disk", "/"));
  check("bowerbird_disk", () => disk("bowerbird_disk", "/opt/bowerbird"));
  check("docker_disk", () => {
    const target = read("docker", ["info", "--format", "{{.DockerRootDir}}"]).trim();
    if (!target.startsWith("/") || /[\u0000\r\n]/.test(target)) throw new Error("invalid_docker_root");
    return disk("docker_disk", target);
  });
  check("worker", () => {
    const template = "{{json .State.Status}}\t{{json .RestartCount}}\t{{json .State.OOMKilled}}\t{{json .HostConfig.RestartPolicy.Name}}";
    const [state, restartCount, oomKilled, restartPolicy] = read("docker", ["inspect", "--type=container", "--format", template, worker])
      .trim().split("\t").map(value => JSON.parse(value));
    if (!/^(created|running|paused|restarting|removing|exited|dead)$/.test(state) || !count(restartCount)
      || typeof oomKilled !== "boolean" || typeof restartPolicy !== "string") throw new Error("invalid_docker_inspect");
    if (state !== "running") alerts.push("worker_not_running");
    if (restartCount > 0) alerts.push("worker_restarted");
    if (oomKilled) alerts.push("worker_oom_killed");
    if (restartPolicy !== "unless-stopped") alerts.push("worker_restart_policy_changed");
    return { state, restartCount, oomKilled, expectedRestartPolicy: restartPolicy === "unless-stopped" };
  });
  check("worker_tmpfs", () => {
    const rows = read("docker", ["exec", worker, "df", "-P", "-T", "-k", ...tmpfsPaths]).trim().split(/\r?\n/).slice(1).map(filesystem);
    const tmpfs = tmpfsPaths.map(mount => rows.find(row => row.mount === mount && row.type === "tmpfs") ?? null);
    if (tmpfs.some(row => row === null)) alerts.push("worker_tmpfs_mount_missing");
    if (tmpfs.some(row => row && row.usedPercent >= 90)) alerts.push("worker_tmpfs_low_space");
    return Object.fromEntries(tmpfsPaths.map((mount, index) => [mount, tmpfs[index]]));
  });
  check("agent_queue", () => {
    const queue = readAgentQueue(command);
    if (queue.thresholds.length > 0) alerts.push("agent_queue_threshold_hit");
    return queue;
  });
  for (const mode of ["reconcile", "bill"]) {
    const name = `payment_${mode}`;
    check(name, () => {
      const payment = readPayment(mode, read, now);
      if (!payment.timerActive) alerts.push(`${name}_timer_inactive`);
      if (!payment.serviceSuccessful) alerts.push(`${name}_service_failed`);
      if (!payment.current) alerts.push(`${name}_success_missing_or_stale`);
      if (payment.latestOutcome === "failure") alerts.push(`${name}_reported_failure`);
      return payment;
    });
  }
  return { event: "vps_release_health", checkedAt: now.toISOString(),
    status: incomplete ? "incomplete" : alerts.length ? "attention" : "ok", checks, alerts };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const error = process.argv.length !== 2 ? "invalid_probe_argument"
    : process.platform !== "linux" ? "target_linux_host_required" : null;
  if (error) {
    console.log(JSON.stringify({ event: "vps_release_health", status: "incomplete", alerts: [error] }));
    process.exitCode = 2;
  } else {
    const report = collectVpsHealth();
    console.log(JSON.stringify(report));
    process.exitCode = { ok: 0, attention: 1, incomplete: 2 }[report.status];
  }
}
