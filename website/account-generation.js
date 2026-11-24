import { reportUserError } from "./user-error.js";

const endpoint = "/api/cloud/functions/v1/generate-proxy";

async function openRequests() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("bowerbird.website-generation", 2);
    request.onupgradeneeded = event => {
      if (event.oldVersion < 1) request.result.createObjectStore("requests");
      const images = request.result.createObjectStore("images", { keyPath: ["owner", "jobId"] });
      images.createIndex("owner", "owner");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function stored(db, mode, operation, storeName = "requests") {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = operation(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error || request.error);
  });
}

async function checkedImage(job, cloudUrl, signal) {
  const artifact = job.artifact;
  const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[artifact?.mime];
  if (!extension || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > 20 * 1024 * 1024) {
    throw new Error("云图片格式或大小无效");
  }
  const url = new URL(artifact.url);
  const path = `/storage/v1/object/sign/generation-temp/jobs/${job.job_id}/outputs/result.${extension}`;
  if (url.origin !== new URL(cloudUrl).origin || url.pathname !== path) throw new Error("云图片下载地址无效");
  const response = await fetch("/api/cloud" + url.pathname + url.search, { signal, redirect: "error" });
  if (!response.ok || !response.body) throw new Error("暂时无法下载，请稍后取回原任务");
  const data = new Uint8Array(artifact.bytes);
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (size + value.length > data.length) {
      await reader.cancel();
      throw new Error("云图片超过声明大小");
    }
    data.set(value, size);
    size += value.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const hash = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  if (size !== data.length || hash !== artifact.sha256) throw new Error("云图片完整性校验失败");
  return new Blob([data], { type: artifact.mime });
}

// A page refresh may look up an accepted job. Only a user click can submit
// the original input again after the service confirms it still needs it.
export async function accountGeneration({ owner, token, cloudUrl, input, signal, display, onPending,
  replaceUnknown, archivedKey, retryKey, onRecoveryList }) {
  const db = await openRequests();
  try {
    if (!input) {
      const images = await stored(db, "readonly", s => s.index("owner").getAll(owner), "images");
      if (!token()) return;
      for (const image of images.sort((a, b) => a.created - b.created)) display(image.blob, image.jobId, false);
    }
    return await navigator.locks.request("bowerbird.generate." + owner, { ifAvailable: true }, async lock => {
      if (!lock) {
        if (input) throw new Error("另一页面正在处理该账号的生成任务");
        return;
      }
      if (!token()) return;
      const rowKey = archivedKey ? [owner, archivedKey] : owner;
      let record = await stored(db, "readonly", s => s.get(rowKey));
      let recovering = Boolean(record);
      if (retryKey && record?.key !== retryKey) throw new Error("任务已变化，请先查看当前任务");
      if (replaceUnknown) {
        // One locked transaction: a second tab still showing the old button
        // cannot archive its successor or create another charge.
        if (!input || archivedKey || record?.key !== replaceUnknown || !record.unknown) {
          throw new Error("任务已变化，请先查看当前任务");
        }
        const previous = record;
        record = { key: crypto.randomUUID(), input };
        await stored(db, "readwrite", s => {
          s.add({ key: previous.key, label: previous.input?.prompt?.slice(0, 32), created: previous.created }, [owner, previous.key]);
          return s.put(record, owner);
        });
        recovering = false;
      }
      if (!record) {
        if (!input || archivedKey) return;
        record = { key: crypto.randomUUID(), input };
        await stored(db, "readwrite", s => s.add(record, owner));
      }
      onPending();
      const clear = () => stored(db, "readwrite", s => s.delete(rowKey));
      const send = async (url, body) => {
        const bearer = token();
        if (!bearer) throw new Error("请用原账号登录后取回任务");
        const response = await fetch(url, { method: "POST", redirect: "error", signal,
          headers: { Authorization: "Bearer " + bearer, "Content-Type": "application/json" },
          body: JSON.stringify(body) });
        const payload = await response.json();
        if (!response.ok && !(response.status === 404 && body.action === "get_by_key" && payload.status === "not_found")) {
          // A status code alone cannot prove the job was never accepted.
          if (url === "/api/generate" && [400, 402, 413, 415, 422].includes(response.status)) {
            const original = await send(endpoint, { action: "get_by_key", idempotency_key: record.key });
            if (original.status === "not_found") await clear();
          }
          throw Object.assign(new Error(payload.error?.message || (typeof payload.error === "string" && payload.error) || "暂时无法查询云任务"),
            { code: payload.error?.code, status: response.status });
        }
        return payload;
      };
      let job = recovering ? await send(endpoint, { action: "get_by_key", idempotency_key: record.key }) : null;
      if (!job || ["not_found", "uploading"].includes(job.status)) {
        if (archivedKey || record.unknown) throw new Error("旧任务暂未返回结果，请稍后再查询");
        if (!input) throw new Error("原请求待续办，请点击生成按钮继续原任务");
        job = await send("/api/generate", { ...record.input, idempotency_key: record.key });
      }
      while (["uploading", "queued", "leased", "running", "cancel_requested"].includes(job.status)) {
        if (!job.job_id) throw new Error("云任务缺少标识，请稍后取回原任务");
        await new Promise(resolve => setTimeout(resolve, 1500));
        job = await send(endpoint, { action: "get", job_id: job.job_id });
      }
      if (job.status !== "succeeded") {
        if (["cancelled", "failed", "artifact_expired"].includes(job.status)) await clear();
        if (job.status === "outcome_unknown" && !archivedKey) {
          record.unknown = true;
          record.created ??= Date.now();
          await stored(db, "readwrite", s => s.put(record, owner));
          throw new Error("原任务结果待确认，可继续查询或单独创建新任务");
        }
        throw new Error(job.error?.message || "云任务结果待确认，请稍后取回原任务");
      }
      const image = await checkedImage(job, cloudUrl, signal);
      if (!token()) throw new Error("请用原账号登录后取回任务");
      await stored(db, "readwrite", s => s.put({ owner, jobId: job.job_id, blob: image, created: Date.now() }), "images");
      if (!token()) throw new Error("请用原账号登录后取回任务");
      display(image, job.job_id, true);
      await send(endpoint, { action: "artifact_received", job_id: job.job_id });
      await clear();
    });
  } finally {
    try {
      if (onRecoveryList && token()) {
        const active = await stored(db, "readonly", s => s.get(owner));
        const archived = await stored(db, "readonly", s => s.getAll(IDBKeyRange.bound([owner], [owner, []])));
        if (token()) onRecoveryList(active?.unknown ? active.key : null, archived);
      }
    } finally { db.close(); }
  }
}

export function loadAccountSDK() {
  return new Promise(resolve => {
    const script = document.createElement("script");
    script.src = "./account-sdk.js";
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
}

export function createAccountGenerationUI({ button, readInput, token, cloudUrl, show, updateGraph, displayImage }) {
  let owner = null;
  let active = false;
  const displayed = new Map();
  let activeController;
  let currentUnknown = null;
  const recovery = document.createElement("div");
  recovery.hidden = true;
  button.parentElement.after(recovery);
  function renderRecovery(unknown, archived) {
    currentUnknown = unknown;
    recovery.replaceChildren();
    button.querySelector("span").textContent = unknown ? "查询原任务" : "创作图片";
    const add = (label, callback) => {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "generate-button";
      action.textContent = label;
      action.onclick = callback;
      recovery.append(action);
    };
    if (unknown) add("按当前输入另建任务（单独计费）", () => run(readInput(), { replaceUnknown: unknown }));
    for (const record of archived) {
      add("查询旧任务：" + (record.label || "生成图片") + " · " + record.key.slice(0, 8),
        () => run(null, { archivedKey: record.key }));
    }
    recovery.hidden = !recovery.childElementCount;
  }
  async function run(input, selection = {}) {
    if (active) return;
    if (input && currentUnknown && !selection.replaceUnknown) selection = { retryKey: currentUnknown };
    active = true;
    button.disabled = true;
    recovery.inert = true;
    const expectedOwner = owner;
    const controller = new AbortController();
    activeController = controller;
    const timer = setTimeout(() => controller.abort(), 135000);
    try {
      await accountGeneration({ owner, token: () => expectedOwner === owner && token(),
        cloudUrl: cloudUrl(), input, signal: controller.signal, ...selection, onRecoveryList: renderRecovery,
        onPending() {
          button.hidden = false;
          button.disabled = true;
          updateGraph("loading");
          show("正在等待云端原任务", "刷新后可用同一账号继续取回图片", "loading");
        },
        display(blob, jobId, finished) {
          if (!displayed.has(jobId)) {
            const url = URL.createObjectURL(blob);
            displayed.set(jobId, { url, remove: displayImage(url) });
          }
          if (!finished) return;
          updateGraph("complete");
          show("生成完成，已自动入库", "新作品已进入左侧素材库");
        },
      });
    } catch (error) {
      if (expectedOwner === owner) {
        updateGraph("error");
        show("暂未获得生成结果", reportUserError(error, "请点击生成按钮继续查询原任务。"), "error");
      }
    } finally {
      clearTimeout(timer);
      active = false;
      recovery.inert = false;
      activeController = null;
      button.disabled = false;
      if (owner) button.hidden = false;
      if (owner && owner !== expectedOwner) void run(null);
    }
  }
  return {
    run,
    get active() { return active; },
    get owner() { return owner; },
    updateOwner(session) {
      const next = session?.user?.id || null;
      if (next === owner) return;
      owner = next;
      activeController?.abort();
      renderRecovery(null, []);
      for (const { url, remove } of displayed.values()) {
        remove();
        URL.revokeObjectURL(url);
      }
      displayed.clear();
      if (owner) void run(null);
    },
  };
}
