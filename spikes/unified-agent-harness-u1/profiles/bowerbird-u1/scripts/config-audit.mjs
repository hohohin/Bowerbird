import assert from "node:assert/strict";
import yaml from "js-yaml";

const dshExpressionType = new yaml.Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  construct: (source) => source,
});
const dshDumpSchema = yaml.DEFAULT_SCHEMA.extend([dshExpressionType]);

export const forbiddenRows = [
  "hmr",
  "subprocess",
  "sandbox",
  "bash-sandbox",
  "pwsh-sandbox",
  "shell-env",
  "tool-bash",
  "tool-pwsh",
  "tool-jobs",
  "fs-observation-policy",
  "tool-fs",
  "tool-fs-search",
  "agent-instructions",
  "skill",
  "skill-filesystem",
  "tool-skill",
  "subagent",
  "subagent-spawn-in-process",
  "subagent-fork-in-process",
  "tool-subagent-control",
  "tool-subagent-list-agents",
  "tool-subagent",
  "tool-subagent-fork",
  "tool-subagent-report",
  "workflow-worker-thread",
  "tool-workflow",
  "tool-ralph",
  "tool-str-replace-editor",
  "web",
  "web-search-deepseek",
  "tool-web",
  "fs-sandbox",
];

export function parseComposedConfig(text) {
  const parsed = yaml.load(text, { schema: dshDumpSchema });
  assert.ok(Array.isArray(parsed), "composed DSH config must be a top-level row array");
  return parsed;
}

export function auditComposedConfig(rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));

  for (const id of forbiddenRows) {
    const row = byId.get(id);
    assert.ok(!row || row.disabled === true, `${id} must be absent or disabled`);
  }

  const acp = byId.get("acp");
  assert.equal(acp?.name, "@deepseek-ai/dsh-acp");
  assert.deepEqual(acp?.config, {
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
  });

  const deepseek = byId.get("llm-deepseek");
  assert.equal(deepseek?.name, "@deepseek-ai/dsh-llm-deepseek");
  assert.equal(deepseek?.config?.apiKeyEnv, "DEEPSEEK_API_KEY");
  assert.equal(deepseek?.config?.thinking, "disabled");
  assert.equal(deepseek?.config?.reasoningEffort, "off");

  assert.equal(byId.get("session-telemetry-otel")?.disabled, true);
  assert.equal(byId.get("credentials")?.disabled, true);
  assert.equal(byId.get("llm-pi-ai")?.disabled, true);

  return {
    totalRows: rows.length,
    enabledRows: rows.filter((row) => row.disabled !== true).map((row) => row.id),
    forbiddenRowsChecked: forbiddenRows.length,
  };
}
