import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("site visibility is keyed by the browser-reported hostname and can be restored from the toolbar", () => {
  let handleMessage;
  let handleAction;
  const storage = {};
  const messages = [];
  const chrome = {
    runtime: { onMessage: { addListener: fn => { handleMessage = fn; } } },
    action: { onClicked: { addListener: fn => { handleAction = fn; } } },
    tabs: { sendMessage: (tabId, message, options, done) => { messages.push([tabId, message.type, options.frameId]); done(); } },
    storage: { local: {
      get: (key, done) => done({ [key]: storage[key] }),
      set: (data, done) => { Object.assign(storage, data); done(); },
      remove: (key, done) => { delete storage[key]; done(); },
    } },
  };
  runInNewContext(readFileSync(new URL("preferences.js", import.meta.url), "utf8"), { chrome, URL });
  const send = (url, type, data = {}) => {
    let reply;
    handleMessage({ type, ...data }, { url }, response => { reply = response; });
    return reply;
  };

  const current = "https://photos.example/gallery";
  const same = "http://photos.example:8000/other";
  const other = "https://another.example/";
  assert.equal(send(current, "site_visibility_set", { hidden: true, hostname: "another.example" }).ok, true);
  assert.equal(send(same, "site_visibility_get").hidden, true);
  assert.equal(send(other, "site_visibility_get").hidden, false);
  assert.equal(send("file:///index.html", "site_visibility_set", { hidden: true }), undefined);
  handleAction({ id: 13 });
  assert.deepEqual(messages, [[13, "bowerbird_toolbar_action", 0]]);
  assert.equal(send(current, "site_visibility_set", { hidden: false }).hidden, false);
  assert.equal(send(current, "site_visibility_get").hidden, false);
  assert.deepEqual(Object.keys(storage), []);
});
