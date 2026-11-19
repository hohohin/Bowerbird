// Preloaded only into the Bowerbird-owned DSH CLI process. The official adapter
// keeps transport, credential handling, validation, replay and tool dispatch.
const { createHash } = require("node:crypto");
const { registerHooks } = require("node:module");
const { readFileSync } = require("node:fs");
const { fileURLToPath } = require("node:url");

const digest = "955dc7bc7ca6c857ff4a7e373b87c143b96a4c43fc80325b67dc0982600dcc75";
const entry = "/@deepseek-ai/dsh-llm-deepseek/lib/index.js";
const controllerEntry = "/@deepseek-ai/dsh-api-session-controller/lib/index.js";
const controllerDigest = "4cf6c66e65cce865d270fa89405b96d048ffa62e493e4ffbd1a826be2207a4cd";

// The Web controller normally keeps every AgentHandle for the host's lifetime.
// Keep the original handle for a card's one turn and let DSH drain its writer.
function handoffAfterTurn(handle) {
  const { agent } = handle;
  let waiting = false;
  const unsubscribe = agent.ctx.on("session/event", (session, event) => {
    if (session !== agent.session || event.type !== "turn/end" || waiting) return;
    waiting = true;
    setImmediate(async () => {
      try {
        await agent.whenIdle();
        if (agent.status !== "idle" || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) return;
        unsubscribe();
        await handle.dispose();
      } catch {
        console.warn("[bowerbird-dsh] failed to release completed session", agent.id);
      } finally {
        waiting = false;
      }
    });
  });
}

function patchController(source) {
  const begin = "return (await this.ctx.agents.create({";
  const end = "setup: composition.setup\n\t\t})).agent;\n\t}\n\tagentOptions() {";
  if (source.split(begin).length !== 2 || source.split(end).length !== 2) return;
  // Mount the managed card tools for this live agent. Persist the host default
  // for later activation, including Desktop profiles without this card preset.
  return source.replace("var ApiSessionAgentController = class {",
    `${handoffAfterTurn}\nvar ApiSessionAgentController = class {\n bowerbirdLivePresets = new WeakMap();`)
    .replace(begin, `const card = /^session-bowerbird-chat-[a-f0-9]{64}$/.test(sessionId)
      && /^bowerbird-chat-[a-f0-9]{16}$/.test(composition.agentPreset ?? "");
    const handle = await this.ctx.agents.create({`)
    .replace("...composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset }",
      "...card || composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset }")
    .replace(end, `setup: composition.setup
    });
    if (card) {
      this.bowerbirdLivePresets.set(handle.agent.session, composition.agentPreset);
      handoffAfterTurn(handle);
    }
    return handle.agent;
  }
  agentOptions() {`)
    .replace('return this.ctx.get("agentPresets")?.presetForSession(session)',
      'return this.bowerbirdLivePresets.get(session) ?? this.ctx.get("agentPresets")?.presetForSession(session)');
}

function repairCandidate(block) {
  const { content } = block;
  if (content.type !== "tool-call" || !content.id || content.name !== "create_canvas_cards") return;
  const raw = content.arguments;
  try {
    JSON.parse(raw);
    return;
  } catch {
    const candidate = raw.replace(/\}([ \t\r\n]*)$/u, "$1");
    if (candidate === raw) return;
    try {
      const value = JSON.parse(candidate);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) return candidate;
    } catch { /* The original strict validation reports the malformed response. */ }
  }
}

// Byte-pinned translations of dsh-0.2.2-rc.1-card-arguments.patch to the
// published JS. Leave source deltas intact; defer only a candidate block-end.
function patch(source) {
  const edits = [
    ["async function* translate(events, model) {", `
import { createHash as bowerbirdCreateHash } from "node:crypto";
${repairCandidate}
async function* translate(events, model, sessionId) {
  const cardSession = /^session-bowerbird-chat-[a-f0-9]{64}$/.test(sessionId ?? "");
  const deferred = new Map();`],
    ["translate(parseSse(response.body, activity), options.model)", "translate(parseSse(response.body, activity), options.model, options.sessionId)"],
    ["block.content.arguments = block.json;", `block.content.arguments = block.json;
        const candidate = cardSession ? repairCandidate(block) : undefined;
        if (candidate !== undefined) {
          deferred.set(block.index, candidate);
          continue;
        }`],
    ['for (const { content } of blocks.values()) {\n\t\t\t\tif (content.type !== "tool-call") continue;', `for (const { index, content } of blocks.values()) {
        if (content.type !== "tool-call") continue;
        if (reason.kind === "tool-calls" && deferred.has(index)) content.arguments = deferred.get(index);`],
    ["usage.totalTokens = usage.inputTokens", `for (const block of blocks.values()) {
          if (!deferred.has(block.index)) continue;
          if (reason.kind === "tool-calls") {
            const sha256 = bowerbirdCreateHash("sha256").update(block.json).digest("hex");
            console.info("[bowerbird-dsh-card-json]", JSON.stringify({ sessionId, callId: block.content.id, sha256, reason: "surplus-trailing-brace" }));
          }
          yield { type: "block-end", index: block.index, block: { ...block.content } };
        }
        usage.totalTokens = usage.inputTokens`],
  ];
  for (const [before, after] of edits) {
    if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) return;
    source = source.replace(before, () => after);
  }
  return source;
}

if (typeof registerHooks === "function") {
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (!url.startsWith("file:") || loaded.format !== "module") return loaded;
      const path = new URL(url);
      const controller = path.pathname.endsWith(controllerEntry);
      if (!controller && !path.pathname.endsWith(entry)) return loaded;
      const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source ?? "").toString("utf8");
      if (createHash("sha256").update(source).digest("hex") !== (controller ? controllerDigest : digest)) return loaded;
      try {
        const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", path)), "utf8"));
        if (manifest.version !== "0.2.2-rc.1") return loaded;
      } catch {
        return loaded;
      }
      const adapted = controller ? patchController(source) : patch(source);
      if (adapted === undefined) return loaded;
      return { ...loaded, source: adapted };
    },
  });
}

// Only the Bowerbird-owned host receives this pipe. An abrupt desktop exit
// closes its write end even when the normal Rust child cleanup cannot run.
if (process.env.BOWERBIRD_DSH_PARENT_PIPE === "1") {
  delete process.env.BOWERBIRD_DSH_PARENT_PIPE;
  process.stdin.once("end", () => process.exit(0));
  process.stdin.resume();
}
