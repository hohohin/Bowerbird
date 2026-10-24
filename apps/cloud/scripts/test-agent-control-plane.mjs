// Retired entry point: current agent-run creates only unified DSH Runs.
// Historical implementation is available in Git history. No credentials are read.
const message = "此旧 controlled Agent 脚本已退役：当前只允许新建 unified DSH Run。控制面验证使用 test-agent-runtime-selection-remote.mjs；真实 HTML E2E 使用 test-unified-agent-e2e.mjs（保留其费用双闸）。旧恢复证据不由新建脚本重放。";
if (process.argv.includes("--help")) {
  console.log(message);
} else {
  console.error(message);
  process.exitCode = 2;
}
