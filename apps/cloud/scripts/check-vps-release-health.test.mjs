import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectVpsHealth } from "./check-vps-release-health.mjs";

const now = new Date("2026-11-20T02:50:00Z");
const worker = "agent-worker-generation-worker-1";
const localDocker = "--host=unix:///var/run/docker.sock";
const dfHeader = "Filesystem Type 1024-blocks Used Available Capacity Mounted on\n";
const tmpfs = dfHeader + "tmpfs tmpfs 655360 0 655360 0% /tmp\n"
  + "tmpfs tmpfs 262144 0 262144 0% /workspaces\ntmpfs tmpfs 32768 0 32768 0% /dsh-runtime\n";
const ok = (stdout, status = 0) => ({ status, stdout });
const agent = (metrics = {}, alerts = []) => ok(JSON.stringify({ event: "agent_health_probe", alerts,
  metrics: { queueDepth: 2, oldestQueuedAgeSeconds: 30, activeRuns: 3, expiredLeases: 0,
    ttlBacklog: { runs: 0, artifacts: 0 }, ...metrics } }), Number(alerts.length > 0));
const journal = (message, timestamp) => JSON.stringify({ MESSAGE: JSON.stringify(message), __REALTIME_TIMESTAMP: String(timestamp * 1000) });

function fixture({ current = now, overrides = {} } = {}) {
  const command = (program, args) => {
    const operation = program === "docker" ? args[1] : args[0];
    const suffix = args.at(-1);
    const key = `${program === process.execPath ? "node" : program}:${program === "df" ? suffix : operation}`;
    if (Object.hasOwn(overrides, key)) return overrides[key];
    if (program === "df") return ok(`${dfHeader}/dev/vda1 ext4 52428800 30000000 22428800 58% /\n`);
    if (program === "docker") {
      assert.equal(args[0], localDocker);
      if (operation === "info") return ok("/var/lib/docker\n");
      if (operation === "inspect") {
        assert.equal(suffix, worker);
        return ok('"running"\t0\tfalse\t"unless-stopped"\n');
      }
      assert.deepEqual(args.slice(1), ["exec", worker, "df", "-P", "-T", "-k", "/tmp", "/workspaces", "/dsh-runtime"]);
      return ok(tmpfs);
    }
    if (program === process.execPath) {
      assert.match(operation, /check-agent-runtime-health\.mjs$/);
      return overrides.agent ?? agent();
    }
    if (program === "systemctl") {
      assert.equal(operation, "show");
      assert.match(suffix, /^bowerbird-wechatpay-(?:reconcile|bill)\.(?:timer|service)$/);
      return overrides[suffix] ?? ok(suffix.endsWith(".timer") ? "active\n" : "success\n");
    }
    assert.equal(program, "journalctl");
    const isBill = args.includes("--unit=bowerbird-wechatpay-bill.service");
    return overrides[isBill ? "billJournal" : "reconcileJournal"] ?? ok(isBill
      ? journal({ ok: true, task: "bill", bill_date: "2026-11-19", status: "matched", difference_count: 0 }, current.getTime() - 120_000)
      : journal({ ok: true, task: "reconcile", processed: 0, failed: 0 }, current.getTime() - 30_000));
  };
  return collectVpsHealth({ command, now: current });
}

test("aggregates healthy disk, Docker, queue and recent payment evidence", () => {
  const report = fixture();
  assert.equal(report.status, "ok");
  assert.deepEqual(report.alerts, []);
  assert.equal(report.checks.docker_disk.usedPercent, 58);
  assert.equal(report.checks.worker_tmpfs["/tmp"].sizeBytes, 640 * 1024 ** 2);
  assert.equal(report.checks.agent_queue.queueDepth, 2);
  assert.equal(report.checks.payment_bill.expectedBillDate, "2026-11-19");
  assert.equal(report.checks.payment_reconcile.serviceSuccessful, true);
});

test("reports disk pressure, restarts, tmpfs changes, and queue thresholds", () => {
  const report = fixture({ overrides: {
    "df:/": ok(`${dfHeader}/dev/vda1 ext4 52428800 50000000 2428800 96% /\n`),
    "docker:inspect": ok('"restarting"\t2\ttrue\t"no"\n'),
    "docker:exec": ok(dfHeader + "tmpfs tmpfs 655360 650000 5360 100% /tmp\n"
      + "tmpfs tmpfs 262144 0 262144 0% /workspaces\noverlay overlay 50000000 30000000 20000000 60% /\n"),
    agent: agent({ queueDepth: 90 }, ["queue_depth=90"]),
  } });
  assert.equal(report.status, "attention");
  assert.deepEqual(report.alerts, ["root_disk_low_space", "worker_not_running", "worker_restarted", "worker_oom_killed",
    "worker_restart_policy_changed", "worker_tmpfs_mount_missing", "worker_tmpfs_low_space", "agent_queue_threshold_hit"]);
  assert.equal(report.checks.worker_tmpfs["/dsh-runtime"], null);
  assert.deepEqual(report.checks.agent_queue.thresholds, ["queue_depth"]);
});

test("reports failed payment maintenance and stale successful runs without leaking the journal", () => {
  const secret = "untrusted-journal-content-should-not-escape";
  const report = fixture({ overrides: {
    "bowerbird-wechatpay-reconcile.timer": ok("inactive\n"),
    "bowerbird-wechatpay-reconcile.service": ok("exit-code\n"),
    reconcileJournal: ok(journal({ ok: false, code: secret, summary: { order: secret } }, now.getTime() - 30_000)
      + "\n" + journal({ ok: true, task: "reconcile", processed: 0, failed: 0 }, now.getTime() - 6 * 60_000)),
    billJournal: ok(journal({ ok: true, task: "bill", bill_date: "2026-11-18", status: "matched", difference_count: 0 }, now.getTime() - 80_000_000)),
  } });
  assert.equal(report.status, "attention");
  assert.deepEqual(report.alerts, ["payment_reconcile_timer_inactive", "payment_reconcile_service_failed",
    "payment_reconcile_success_missing_or_stale", "payment_reconcile_reported_failure", "payment_bill_success_missing_or_stale"]);
  assert.equal(report.checks.payment_reconcile.reportedFailures, 1);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
});

test("allows a bill during its grace period and retains the newest matched bill after historical backfill", () => {
  const current = new Date("2026-11-20T02:40:00Z");
  assert.equal(fixture({ current }).checks.payment_bill.current, true);
  const report = fixture({ overrides: { billJournal: ok(
    journal({ ok: true, task: "bill", bill_date: "2026-11-17", status: "matched", difference_count: 0 }, now.getTime() - 60_000)
    + "\n" + journal({ ok: true, task: "bill", bill_date: "2026-11-19", status: "matched", difference_count: 0 }, now.getTime() - 120_000),
  ) } });
  assert.equal(report.checks.payment_bill.successfulBillDate, "2026-11-19");
  assert.equal(report.status, "ok");
});

test("preserves independent evidence when probes time out, return bad data or have no accepted status", () => {
  const secret = "secret-response";
  const report = fixture({ overrides: {
    "docker:info": { error: new Error(secret), stdout: secret },
    agent: agent({ ttlBacklog: {} }),
    reconcileJournal: { status: 1, stderr: secret },
    billJournal: ok(""),
  } });
  assert.equal(report.status, "incomplete");
  assert.deepEqual(report.alerts, ["docker_disk_unavailable", "agent_queue_unavailable", "payment_reconcile_unavailable",
    "payment_bill_success_missing_or_stale"]);
  assert.equal(report.checks.docker_disk, null);
  assert.equal(report.checks.worker.state, "running");
  assert.equal(report.checks.payment_bill.latestOutcome, "missing");
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
});

test("CLI rejects invalid arguments before invoking health commands", () => {
  const script = fileURLToPath(new URL("./check-vps-release-health.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "unexpected"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout).alerts, ["invalid_probe_argument"]);
});
