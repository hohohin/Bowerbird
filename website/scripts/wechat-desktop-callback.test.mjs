import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { userErrorMessage } from "../user-error.js";

const html = await readFile(new URL("../wechat-callback.html", import.meta.url), "utf8");
const moduleSource = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
assert.ok(moduleSource, "the production callback module must exist");
const errorImport = 'import { reportUserError } from "./user-error.js";';
assert.ok(moduleSource.includes(errorImport));
const source = moduleSource.replace(errorImport, "");

// Execute the production callback with a fake Location. No browser or OS protocol
// handler is opened, and every attempted network exchange is recorded locally.
async function runCallback(query, {
  rejectNavigation = false, storedState = null, enableWeb = false,
  exchangeStatus = 200, sdkLoadError = false, sessionResult = { error: null },
} = {}) {
  // Read initial hidden attributes from the real markup, rather than assuming
  // that the button is hidden or that JavaScript will always change visibility.
  const elements = {};
  for (const [, tagName, attributesText] of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const attributes = Object.fromEntries([...attributesText.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)]
      .map(([, name, quoted, singleQuoted, unquoted]) => [name, quoted ?? singleQuoted ?? unquoted ?? ""]));
    if (!attributes.id) continue;
    const classes = new Set((attributes.class || "").split(/\s+/));
    const dataset = Object.fromEntries(Object.entries(attributes).filter(([key]) => key.startsWith("data-")).map(([key, value]) => [key.slice(5), value]));
    elements[attributes.id] = {
      tagName: tagName.toUpperCase(), textContent: "", className: attributes.class || "",
      attributes, classes, dataset, hidden: Object.hasOwn(attributes, "hidden"),
      setAttribute(name, value) { this.attributes[name] = value; if (name.startsWith("data-")) this.dataset[name.slice(5)] = value; },
      classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); } },
    };
  }
  const calls = { navigation: [], timers: [], fetch: [], storage: [], errors: [], scripts: [], clients: [], sessions: [] };
  const state = () => elements["login-card"]?.dataset.state;
  const primarySnapshot = () => ({
    href: elements.primary.attributes.href,
    text: elements["primary-label"]?.textContent ?? elements.primary.textContent,
    visible: !elements.primary.hidden && !elements.primary.classes.has("hidden"),
  });
  const setTimeout = (callback, delay) => { calls.timers.push({ callback, delay }); };
  const context = {
    URLSearchParams, encodeURIComponent, Promise,
    document: {
      getElementById: id => elements[id],
      createElement: tag => ({ tagName: tag.toUpperCase() }),
      head: { appendChild(script) {
        calls.scripts.push(script.src);
        queueMicrotask(() => sdkLoadError ? script.onerror() : script.onload());
      } },
    },
    window: {
      setTimeout,
      location: {
        search: `?${new URLSearchParams(query)}`,
        replace(href) {
          calls.navigation.push({ href, primary: primarySnapshot() });
          if (rejectNavigation) throw new Error("synthetic browser refusal");
        },
      },
      sessionStorage: {
        getItem(key) { calls.storage.push({ operation: "get", key }); return storedState; },
        removeItem(key) { calls.storage.push({ operation: "remove", key }); },
      },
      supabase: {
        createClient(...args) {
          calls.clients.push(args);
          return { auth: { setSession(tokens) {
            calls.sessions.push({ tokens, state: state(), title: elements["status-title"]?.textContent });
            return Promise.resolve(sessionResult);
          } } };
        },
      },
    },
    setTimeout,
    fetch(url, options) {
      calls.fetch.push({ url, options });
      if (!enableWeb) return Promise.reject(new Error("network disabled in callback test"));
      if (url === "/api/image-config") return Promise.resolve({ ok: true, json: async () => ({
        supabaseUrl: "https://wechat-callback.fixture.invalid", supabasePublishableKey: "synthetic-key",
      }) });
      assert.equal(url, "https://wechat-callback.fixture.invalid/functions/v1/wechat-login?forceFunctionRegion=ap-northeast-1");
      return Promise.resolve({ ok: exchangeStatus === 200, status: exchangeStatus, json: async () => exchangeStatus === 200
        ? { access_token: "synthetic-access", refresh_token: "synthetic-refresh" }
        : { error: { message: "synthetic upstream SQL_ERROR /private/config" } } });
    },
    reportUserError(error, fallback) { calls.errors.push(error); return userErrorMessage(error, fallback); },
  };
  assert.doesNotThrow(() => vm.runInNewContext(source, context, { timeout: 1000 }));
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  return { elements, calls, primarySnapshot, state, flush };
}

function assertDesktopOnly(calls) {
  assert.deepEqual(calls.fetch, [], "desktop codes must only be exchanged by the desktop app");
  assert.deepEqual(calls.storage, [], "desktop callbacks must not use website login state");
  assert.deepEqual(calls.scripts, [], "desktop callbacks must not load the website account SDK");
  assert.deepEqual(calls.sessions, []);
  assert.deepEqual(calls.errors, []);
}

test("desktop callback prepares a native manual link before automatic navigation", async () => {
  assert.match(html, /<a\b[^>]*\bid="primary"[^>]*>/);
  assert.doesNotMatch(html, /onclick\s*=|\.onclick\s*=|addEventListener\(["']click/);
  const code = "synthetic_code_0123456789";
  const state = "dt_01SYNTHETIC0123456789ABCDEF";
  const { calls, primarySnapshot, elements, state: currentState } = await runCallback({ code, state });
  const href = `bowerbird://wechat/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
  assert.deepEqual(calls.navigation, [{ href, primary: { href, text: "打开 Bowerbird", visible: true } }]);
  assert.equal(elements["status-title"].textContent, "准备返回 Bowerbird");
  assert.equal(currentState(), "returning", "opening the app does not establish a website session");
  assert.equal(calls.timers.length, 1);
  assert.equal(calls.timers[0].delay, 1200);
  calls.timers[0].callback();
  assert.deepEqual(primarySnapshot(), { href, text: "再次打开 Bowerbird", visible: true });
  assert.equal(elements["status-title"].textContent, "回到应用，继续登录");
  assert.equal(currentState(), "retry");
  assertDesktopOnly(calls);
});

test("desktop callback encodes query values without changing their contents", async () => {
  // Deliberately synthetic reserved characters verify URL construction only;
  // the desktop and server remain responsible for code/state validation.
  const code = "synthetic+code /?=&%中文";
  const state = "dt_synthetic+state /?=&%";
  const { calls, primarySnapshot } = await runCallback({ code, state });
  const target = new URL(calls.navigation[0].href);
  assert.equal(target.protocol, "bowerbird:");
  assert.equal(target.hostname, "wechat");
  assert.equal(target.pathname, "/callback");
  assert.equal(target.searchParams.get("code"), code);
  assert.equal(target.searchParams.get("state"), state);
  assert.deepEqual([...target.searchParams.keys()], ["code", "state"]);
  assert.equal(primarySnapshot().href, target.href);
  assertDesktopOnly(calls);
});

test("a refused automatic navigation leaves the native manual link usable", async () => {
  const { calls, primarySnapshot, elements, state } = await runCallback({
    code: "synthetic_code_0123456789", state: "dt_01SYNTHETIC0123456789ABCDEF",
  }, { rejectNavigation: true });
  assert.equal(calls.navigation.length, 1);
  assert.equal(calls.navigation[0].primary.visible, true);
  assert.equal(primarySnapshot().visible, true);
  assert.equal(primarySnapshot().href, calls.navigation[0].href);
  assert.equal(calls.timers.length, 1);
  calls.timers[0].callback();
  assert.equal(primarySnapshot().visible, true);
  assert.equal(primarySnapshot().text, "再次打开 Bowerbird");
  assert.equal(elements["status-title"].textContent, "回到应用，继续登录");
  assert.equal(state(), "retry");
  assert.doesNotMatch(elements.status.textContent, /synthetic browser refusal/);
  assertDesktopOnly(calls);
});

test("missing, rejected or unrecognized callback parameters never open the app", async () => {
  for (const query of [
    { state: "dt_synthetic" }, { code: "synthetic" },
    { code: "synthetic", state: "dt_synthetic", error_description: "synthetic rejection" },
    { code: "synthetic", state: "unknown_synthetic" },
  ]) {
    const { calls, primarySnapshot, elements, state } = await runCallback(query);
    assert.deepEqual(calls.navigation, []);
    assert.deepEqual(calls.timers, []);
    assert.deepEqual(primarySnapshot(), { href: "/", text: "回到官网", visible: true });
    assert.equal(state(), "error");
    assert.doesNotMatch(elements["status-title"].textContent + elements.status.textContent, /登录成功|synthetic rejection/);
    assertDesktopOnly(calls);
  }
});

test("website state validation remains required before any token exchange", async () => {
  for (const storedState of [null, "web_another_synthetic_state"]) {
    const { calls, primarySnapshot, elements, state } = await runCallback({
      code: "synthetic", state: "web_synthetic_state",
    }, { storedState });
    assert.deepEqual(calls.navigation, []);
    assert.deepEqual(calls.fetch, []);
    assert.deepEqual(calls.storage, [{ operation: "get", key: "bowerbird.wechatLoginState" }]);
    assert.equal(primarySnapshot().href, "/");
    assert.equal(state(), "error");
    assert.match(elements.status.textContent, /登录会话不匹配/);
  }
});

test("website login only reports success after setSession has completed", async () => {
  let finishSession;
  const sessionResult = new Promise(resolve => { finishSession = resolve; });
  const code = "synthetic_web_code";
  const webState = "web_synthetic_matching_state";
  const { calls, elements, state, flush } = await runCallback({ code, state: webState }, {
    storedState: webState, enableWeb: true, sessionResult,
  });
  assert.equal(calls.fetch.length, 2);
  assert.equal(calls.fetch[1].options.method, "POST");
  assert.deepEqual(JSON.parse(calls.fetch[1].options.body), { code, state: webState });
  assert.equal(calls.sessions.length, 1);
  assert.equal(calls.sessions[0].tokens.access_token, "synthetic-access");
  assert.equal(calls.sessions[0].tokens.refresh_token, "synthetic-refresh");
  assert.notEqual(calls.sessions[0].state, "success");
  assert.notEqual(state(), "success");
  assert.doesNotMatch(elements["status-title"].textContent + elements.status.textContent, /登录成功/);
  assert.deepEqual(calls.navigation, []);
  assert.deepEqual(calls.timers, []);
  assert.deepEqual(calls.storage, [{ operation: "get", key: "bowerbird.wechatLoginState" }]);

  finishSession({ error: null });
  await flush();
  assert.equal(state(), "success");
  assert.equal(elements["status-title"].textContent, "微信登录成功");
  assert.equal(elements.status.textContent, "正在回到官网…");
  assert.deepEqual(calls.storage, [
    { operation: "get", key: "bowerbird.wechatLoginState" },
    { operation: "remove", key: "bowerbird.wechatLoginState" },
  ]);
  assert.equal(calls.timers.length, 1);
  assert.equal(calls.timers[0].delay, 600);
  assert.deepEqual(calls.navigation, []);
  calls.timers[0].callback();
  assert.equal(calls.navigation.length, 1);
  assert.equal(calls.navigation[0].href, "/");
  assert.deepEqual(calls.errors, []);
});

test("website exchange, SDK and session errors never clear state or report login success", async () => {
  for (const failure of [
    { exchangeStatus: 503 },
    { sdkLoadError: true },
    { sessionResult: { error: { message: "synthetic session SQL_ERROR /private/config" } } },
  ]) {
    const webState = "web_synthetic_matching_state";
    const { calls, elements, primarySnapshot, state } = await runCallback({ code: "synthetic_web_code", state: webState }, {
      storedState: webState, enableWeb: true, ...failure,
    });
    assert.equal(state(), "error");
    assert.equal(primarySnapshot().href, "/");
    assert.doesNotMatch(elements["status-title"].textContent + elements.status.textContent, /登录成功|SQL_ERROR|private\/config/);
    assert.deepEqual(calls.navigation, []);
    assert.deepEqual(calls.timers, []);
    assert.deepEqual(calls.storage, [{ operation: "get", key: "bowerbird.wechatLoginState" }]);
    assert.equal(calls.errors.length, 1);
    assert.equal(calls.sessions.length, failure.sessionResult ? 1 : 0);
  }
});
