const BowerbirdImageBatch = (() => {
  "use strict";
  const CONCURRENCY = 4;
  const PORT_NAME = "collect_image_batch";
  const cancelled = { ok: false, code: "cancelled" };
  const unavailable = { ok: false, code: "desktop_unavailable" };
  const unknown = { ok: false, code: "result_unknown" };

  function uploadSession() {
    let socket;

    function close() {
      const previous = socket;
      socket = undefined;
      try { previous?.close(); } catch { /* already disconnected */ }
    }

    async function save(bytes, metadata, signal) {
      if (signal.aborted) return cancelled;
      if (socket?.readyState !== WebSocket.OPEN) {
        close();
        const access = await BowerbirdCollection.socketAccess();
        if (signal.aborted) return cancelled;
        if (!access.ok) return access;
        try {
          socket = BowerbirdCollection.openSocket(access.protocols);
        } catch { return unavailable; }
      }
      const ws = socket;
      return new Promise(resolve => {
        let settled = false;
        let sent = false;
        const finish = (result, keepSocket) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          if (keepSocket) {
            ws.onopen = ws.onmessage = null;
            ws.onerror = ws.onclose = () => { if (socket === ws) close(); };
          } else close();
          resolve(result);
        };
        const disconnected = () => finish(sent ? unknown : unavailable, false);
        const abort = () => { if (!sent) finish(cancelled, false); };
        const timer = setTimeout(disconnected, BowerbirdCollection.UPLOAD_TIMEOUT_MS);
        const send = () => {
          try {
            ws.send(JSON.stringify({ type: "save_blob", ...metadata }));
            ws.send(bytes);
            sent = true;
          } catch { disconnected(); }
        };
        signal.addEventListener("abort", abort, { once: true });
        ws.onerror = ws.onclose = disconnected;
        ws.onmessage = event => {
          try {
            const result = JSON.parse(event.data);
            if (!sent || typeof result?.ok !== "boolean") throw new Error("invalid receipt");
            finish(result, true);
          } catch { finish(unknown, false); }
        };
        if (ws.readyState === WebSocket.OPEN) send();
        else ws.onopen = send;
      });
    }

    return { save, close };
  }

  function listen(readCandidate) {
    chrome.runtime.onConnect?.addListener(port => {
      if (port.name !== PORT_NAME || port.sender?.id !== chrome.runtime.id || !port.sender.tab) return;
      const controller = new AbortController();
      const session = uploadSession();
      const queue = [];
      let items;
      let nextRead = 0;
      let nextSave = 0;
      let saving = false;
      let disconnected = false;

      function fill() {
        while (!controller.signal.aborted && nextRead < items.length && queue.length < CONCURRENCY) {
          const item = items[nextRead++];
          queue.push(readCandidate(item, controller.signal));
        }
      }

      function cancel() {
        controller.abort();
        queue.length = 0;
        if (!saving) session.close();
      }

      port.onDisconnect.addListener(() => { disconnected = true; cancel(); });
      port.onMessage.addListener(async message => {
        if (message?.type === "cancel") { cancel(); return; }
        if (message?.type === "start" && !items && Array.isArray(message.items)) {
          items = message.items.slice(0, BowerbirdCollection.MAX_ITEMS);
          fill();
          return;
        }
        if (message?.type !== "save" || !items || saving || !Number.isInteger(message.index) || message.index !== items[nextSave]?.index) return;
        saving = true;
        let result = cancelled;
        try {
          if (!controller.signal.aborted) {
            const entry = await queue.shift();
            if (!controller.signal.aborted) {
              result = entry.ok ? await session.save(entry.bytes, entry.metadata, controller.signal) : entry;
            }
          }
          nextSave += 1;
          fill();
        } finally {
          saving = false;
          if (controller.signal.aborted || nextSave === items.length) session.close();
        }
        if (!disconnected) {
          try { port.postMessage({ index: message.index, result }); } catch { cancel(); }
        }
      });
    });
  }

  return { listen };
})();
