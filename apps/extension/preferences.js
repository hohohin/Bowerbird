(() => {
  "use strict";

  const POSITION_KEY = "bowerbird_button_position";
  const siteKey = sender => {
    try {
      const url = new URL(sender.url);
      return /^https?:$/.test(url.protocol) ? `bowerbird_hidden_site:${url.hostname}` : null;
    } catch { return null; }
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "button_position_get") {
      chrome.storage.local.get(POSITION_KEY, data => sendResponse({ position: data?.[POSITION_KEY] || null }));
      return true;
    }
    if (message?.type === "button_position_set") {
      const position = message.position;
      if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) return false;
      const dock = position.dock === "left" || position.dock === "right" ? position.dock : null;
      const saved = { x: position.x, y: position.y, dock };
      if (Number.isFinite(position.yRatio) && position.yRatio >= 0 && position.yRatio <= 1) saved.yRatio = position.yRatio;
      chrome.storage.local.set({ [POSITION_KEY]: saved }, () => sendResponse({ ok: !chrome.runtime.lastError }));
      return true;
    }
    if (message?.type === "site_visibility_get") {
      const key = siteKey(sender);
      if (!key) return false;
      chrome.storage.local.get(key, data => sendResponse({ ok: !chrome.runtime.lastError, hidden: data?.[key] === true }));
      return true;
    }
    if (message?.type === "site_visibility_set") {
      const key = siteKey(sender);
      if (!key || typeof message.hidden !== "boolean") return false;
      const done = () => sendResponse({ ok: !chrome.runtime.lastError, hidden: message.hidden });
      if (message.hidden) chrome.storage.local.set({ [key]: true }, done);
      else chrome.storage.local.remove(key, done);
      return true;
    }
    if (message?.type === "open_pairing_options") {
      chrome.runtime.openOptionsPage(() => sendResponse({ ok: !chrome.runtime.lastError }));
      return true;
    }
    return false;
  });

  chrome.action?.onClicked.addListener(tab => {
    if (tab.id == null) return;
    chrome.tabs.sendMessage(tab.id, { type: "bowerbird_toolbar_action" }, { frameId: 0 }, () => {
      void chrome.runtime.lastError;
    });
  });
})();
