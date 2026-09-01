const ENDPOINT_ENV = "BOWERBIRD_TOOL_BRIDGE_ENDPOINT";
const CAPABILITY_ENV = "BOWERBIRD_TOOL_BRIDGE_CAPABILITY";
const ENDPOINT = /^http:\/\/127\.0\.0\.1:\d+\/v1\/run-tools\/call$/;
const CAPABILITY = /^[0-9a-f]{64}$/;

function configuration(environment = process.env) {
  const endpoint = environment[ENDPOINT_ENV];
  const capability = environment[CAPABILITY_ENV];
  if (typeof endpoint !== "string" || !ENDPOINT.test(endpoint) ||
      typeof capability !== "string" || !CAPABILITY.test(capability)) {
    throw new Error("bowerbird_tool_bridge_unavailable");
  }
  return { endpoint, capability };
}

function exactRecord(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
    ? value
    : null;
}

export async function callBowerbirdPlanningBridge(toolName, args, signal, environment = process.env) {
  const { endpoint, capability } = configuration(environment);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${capability}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ toolName, arguments: args }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new Error("bowerbird_tool_bridge_cancelled");
    throw new Error("bowerbird_tool_bridge_unreachable");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("bowerbird_tool_bridge_response_invalid");
  }
  if (response.ok) {
    const success = exactRecord(payload, ["ok", "value"]);
    if (!success || success.ok !== true) throw new Error("bowerbird_tool_bridge_response_invalid");
    return success.value;
  }
  const failure = exactRecord(payload, ["error", "ok"]);
  const detail = failure && failure.ok === false ? exactRecord(failure.error, ["code"]) : null;
  const code = detail && typeof detail.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(detail.code)
    ? detail.code
    : "tool_bridge_failed";
  throw new Error(`bowerbird_tool_error:${code}`);
}

export const BOWERBIRD_PLANNING_BRIDGE_ENV = Object.freeze([ENDPOINT_ENV, CAPABILITY_ENV]);
