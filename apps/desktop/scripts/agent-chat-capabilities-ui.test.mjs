import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
import { canvasToolMenuItem } from "./fixtures/canvas-reference/place-card.mjs";

const server = await createServer({ cacheDir: ".tmp/agent-chat-capabilities/vite", server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1760, height: 1160 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const counts = () => page.evaluate(async () => {
  const { calls } = await import("/scripts/fixtures/local-chat/mock.ts");
  return ["local_chat_models", "local_chat_dsh_status", "local_chat_quote"].map(command => calls.filter(call => call.command === command).length);
});
try {
  await page.goto(server.resolvedUrls.local[0] + "scripts/fixtures/local-chat/preview.html?settings&toolbar-pro");
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  assert.deepEqual(await counts(), [1, 1, 1], "startup and StrictMode share one probe per capability");

  const stage = page.locator("[data-canvas-stage]");
  for (const y of [160, 470]) {
    const tool = await canvasToolMenuItem(page, "Agent 卡片");
    await tool.dragTo(stage, { targetPosition: { x: 680, y } });
  }
  const cards = page.locator(".workflow-card.is-agent");
  await cards.nth(1).waitFor();
  for (const card of await cards.all()) {
    await card.getByLabel("Codex 模型", { exact: true }).click();
    await page.getByRole("option", { name: "Codex 测试模型", exact: true }).click();
    await card.getByLabel("Codex 推理强度", { exact: true }).click();
    await page.getByRole("option", { name: "高", exact: true }).click();
  }
  assert.deepEqual(await counts(), [1, 1, 1], "creating, selecting and configuring two cards adds no probes");

  const fault = page.getByRole("combobox", { name: "测试故障" });
  await fault.selectOption("models");
  await cards.first().getByRole("button", { name: /选择对话模型$/ }).click();
  const menu = page.getByRole("dialog", { name: "对话模型" });
  assert.equal(await menu.locator(".model-select-footer").count(), 0);
  assert.equal(await menu.getByRole("button", { name: "重新检查", exact: true }).count(), 0);
  await page.keyboard.press("Escape");
  await page.evaluate(async () => (await import('/src/lib/chatCapabilities.ts')).refreshChatCapabilities());
  const retry = card => card.getByRole("button", { name: "重试模型列表" });
  await retry(cards.nth(1)).waitFor();
  await fault.selectOption("none");
  await retry(cards.first()).click();
  await retry(cards.nth(1)).waitFor({ state: "detached" });
  assert.deepEqual(await counts(), [3, 2, 2], "manual refresh checks all, model retry only reads models once for every card");

  // Let A finish after B, and after signing out. Neither completion may restore A's price.
  const scope = await page.evaluate(async () => {
    const { useStore } = await import("/src/store.ts");
    const { chatQuote } = await import("/src/lib/chatCapabilities.ts");
    const ipc = window.__TAURI_INTERNALS__, original = ipc.invoke;
    const pending = [];
    ipc.invoke = (command, args) => command === "local_chat_quote"
      ? new Promise(resolve => pending.push(resolve)) : original(command, args);
    const auth = useStore.getState().cloudAuth;
    const current = chatQuote.store.getState().value;
    const login = user_id => useStore.setState({ cloudAuth: { ...auth, logged_in: !!user_id, user_id } });
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    login("A"); login("B");
    pending[1]({ ...current, pricing_version: 2 }); await settle();
    pending[0]({ ...current, pricing_version: 1 }); await settle();
    const b = chatQuote.store.getState().value.pricing_version;
    login("A"); login(null);
    pending[2](current); await settle();
    ipc.invoke = original;
    return [b, chatQuote.store.getState().value];
  });
  assert.deepEqual(scope, [2, null]);
  const concurrent = await page.evaluate(async () => {
    const {setupChatDsh} = await import('/src/lib/chatCapabilities.ts');
    const {calls} = await import('/scripts/fixtures/local-chat/mock.ts');
    const before = calls.filter(c => c.command === 'local_chat_dsh_setup').length;
    const [first, second, manual] = await Promise.allSettled([
      setupChatDsh({mode:'auto'}), setupChatDsh({mode:'auto'}), setupChatDsh({mode:'local', url:'http://127.0.0.1:3081'}),
    ]);
    return [first.status, second.status, manual.status, calls.filter(c => c.command === 'local_chat_dsh_setup').length - before];
  });
  assert.deepEqual(concurrent, ['fulfilled', 'fulfilled', 'rejected', 1]);
  const select = async label => {
    await cards.first().getByRole('button', {name:/选择对话模型$/}).click();
    const menu = page.getByRole('dialog', {name:'对话模型'});
    assert.equal(await menu.getByRole('button', {name:/DSH 设置|连接本机 DSH/}).count(), 0);
    await menu.getByRole('button', {name:label, exact:true}).click();
    await cards.first().getByRole('button', {name:new RegExp(label + '.*选择对话模型$')}).waitFor();
  };
  const dshCalls = () => page.evaluate(async () => (await import('/scripts/fixtures/local-chat/mock.ts')).calls.filter(c =>
    ['local_chat_dsh_setup', 'local_chat_dsh_account', 'local_chat_dsh_status'].includes(c.command)).length);
  const before = await dshCalls();
  await select('本机 DSH');
  await select('本机 Codex');
  await select('本机 DSH');
  assert.equal(await dshCalls(), before, 'switches use shared readiness and never start setup or an account probe');
  assert.equal(await page.getByRole('dialog', {name:/设置/}).count(), 0);
  await page.evaluate(async () => {
    const {localChat} = await import('/src/lib/localChat.ts');
    localChat.dshAccount = async () => ({state:'signedOut', modelConfigured:false});
    (await import('/src/lib/chatCapabilities.ts')).refreshChatCapabilities();
  });
  await page.waitForFunction(async () => (await import('/src/lib/chatCapabilities.ts')).chatDshStatus.store.getState().value?.localAvailable === false);
  assert.equal(await cards.first().getByRole('button', {name:'运行此卡片', exact:true}).isDisabled(), true);
  await cards.first().getByRole('button', {name:/选择对话模型$/}).click();
  assert.equal(await page.getByRole('button', {name:'本机 DSH', exact:true}).isDisabled(), true);
  assert.equal(await page.getByRole('dialog', {name:/设置/}).count(), 0);
  await page.evaluate(async () => {
    const {localChat} = await import('/src/lib/localChat.ts');
    const {chatDshStatus, publishDshAccount} = await import('/src/lib/chatCapabilities.ts');
    let release;
    const pending = new Promise(started => {
      localChat.dshAccount = () => new Promise(resolve => { release = resolve; started(); });
    });
    chatDshStatus.check('local', true);
    await pending;
    publishDshAccount({state:'signedOut', modelConfigured:true});
    release({state:'signedOut', modelConfigured:false});
  });
  await page.waitForFunction(async () => (await import('/src/lib/chatCapabilities.ts')).chatDshStatus.store.getState().value?.localAvailable);
  assert.equal(await page.getByRole('button', {name:'本机 DSH', exact:true}).isEnabled(), true, 'configured API model becomes available without repeating login');
  assert.deepEqual(errors, []);
  console.log("PASS: startup probes, two real cards with no repeated reads, shared error/retry, account switch/logout with delayed quotes");
} finally {
  await browser.close();
  await server.close();
}
