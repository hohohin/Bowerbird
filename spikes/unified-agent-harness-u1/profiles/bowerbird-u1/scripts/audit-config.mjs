import { auditComposedConfig, parseComposedConfig } from "./config-audit.mjs";
import { runDsh } from "./runtime.mjs";

const result = await runDsh(["--dump-config"]);
if (result.exitCode !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

const report = auditComposedConfig(parseComposedConfig(result.stdout));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
