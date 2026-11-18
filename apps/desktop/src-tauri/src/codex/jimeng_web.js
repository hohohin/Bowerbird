/* Executed only in the task's Jimeng WebView. All controls belong to the public image composer. */
async function composeJimeng(request, state) {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => el && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden";
  const all = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
  const exact = (root, selector, value) => all(root, selector).find(el => el.innerText.trim() === value);
  const wait = async (read, error, timeout = 8000, interval = 150) => {
    const end = Date.now() + timeout;
    do { const result = read(); if (result) return result; await pause(interval); } while (Date.now() < end);
    throw new Error(error);
  };
  const editor = await wait(() => all(document, '[contenteditable=true][aria-label="提示词"]')[0], "editor");
  const form = editor.closest('[class*="main-frame-2026"]');
  if (!form || !form.querySelector('[aria-label="创作类型"]')?.innerText.includes("图片生成")) throw new Error("editor");
  const model = form.querySelector('[aria-label="模型"]');
  if (!model) throw new Error("model");
  if (model.innerText.trim() !== request.model) {
    const trigger = model.querySelector(".lv-select-view-value") || model;
    for (const event of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      trigger.dispatchEvent(new MouseEvent(event, {bubbles: true, cancelable: true, button: 0, view: window}));
    }
    const option = await wait(() => all(document, '[role=option],.lv-select-option').find(el =>
      el.innerText.trim().split(/\n/).some(line => line.trim() === request.model)), "model");
    option.click();
    await wait(() => model.innerText.trim() === request.model, "model");
  }
  const count = () => form.querySelector('button[aria-label^="选择生成数量"]');
  if (!count()) throw new Error("count");
  if (count().innerText.trim() !== "1张") {
    count().click();
    (await wait(() => exact(document, '[class*="generate-count-radio-group"] label', "1"), "count")).click();
    await wait(() => count()?.innerText.trim() === "1张", "count");
  }
  const size = () => all(form, "button").find(el => /(?:1\.5|2)K/.test(el.innerText));
  const ratio = request.ratio || "智能比例";
  const hasSize = () => size()?.innerText.includes("2K") && size().innerText.includes(ratio);
  if (!hasSize()) {
    if (!size()) throw new Error("size");
    size().click();
    for (const value of [ratio === "智能比例" ? "智能" : ratio, "2K"]) {
      (await wait(() => exact(document, '[role=radiogroup] label', value), "size")).click();
    }
    await wait(hasSize, "size");
    editor.click();
  }

  editor.focus();
  const selection = getSelection();
  selection.selectAllChildren(editor);
  document.execCommand("insertText", false, request.prompt);
  const normalize = text => text.replace(/\s+/g, " ").trim();
  const mentionSelector = '.node-referenceMentionTag[contenteditable="false"]';
  const matches = el => {
    if (!el.querySelector(mentionSelector)) return normalize(el.innerText) === normalize(request.prompt);
    const copy = el.cloneNode(true);
    copy.querySelectorAll(mentionSelector).forEach(node => node.remove());
    copy.querySelectorAll("br").forEach(node => node.replaceWith("\n"));
    copy.querySelectorAll("p,div").forEach(node => node.append("\n"));
    return normalize(copy.textContent) === normalize(request.prompt);
  };
  await wait(() => matches(editor), "prompt");
  const references = () => form.querySelector("[data-content-generator-references]");
  const attached = () => [...(references()?.querySelectorAll("[data-index]") ?? [])].filter(slot => slot.querySelector("img"));
  if (attached().length) throw new Error("existing-refs");
  if (request.files.length) {
    const upload = await wait(() => references()?.querySelector('[aria-label="上传参考"][aria-disabled="false"]:not([aria-busy="true"])'), "upload-control", 60000);
    const transfer = new DataTransfer();
    for (const file of request.files) {
      const bytes = Uint8Array.from(atob(file.data), ch => ch.charCodeAt(0));
      transfer.items.add(new File([bytes], file.name, {type: file.mime}));
    }
    for (const type of ["dragenter", "dragover", "drop"]) {
      upload.dispatchEvent(new DragEvent(type, {dataTransfer: transfer, bubbles: true, cancelable: true}));
    }
    await wait(() => {
      const slots = attached();
      if (all(document, '[role=dialog],.lv-modal').some(el => el.innerText.includes("欢迎登录即梦"))) throw new Error("upload-login");
      if (slots.length > request.files.length) throw new Error("ref-count");
      return slots.length === request.files.length && !references()?.querySelector('[aria-busy=true]') &&
        slots.every(slot => { const img = slot.querySelector("img"); return img.complete && img.naturalWidth > 0; });
    }, "upload", 60000).catch(error => {
      if (error.message === "upload" && !attached().length) throw new Error("upload-empty");
      throw error;
    });
  }
  const button = () => all(form, 'button[aria-label="生成"]').filter(el => !el.disabled && !el.classList.contains("lv-btn-disabled")).at(-1);
  const submit = await wait(button, "submit");
  if (!matches(editor)) throw new Error("prompt");
  if (!hasSize()) throw new Error("size");
  if (count()?.innerText.trim() !== "1张") throw new Error("count");
  if (model.innerText.trim() !== request.model) throw new Error("model");
  if (attached().length !== request.files.length) throw new Error("ref-count");
  const previousKeys = new Set([...document.querySelectorAll("[data-generated-record-key]")].map(el => el.dataset.generatedRecordKey));
  state.phase = "submitted";
  submit.click();
  const result = await wait(() => jimengResultDownload(request.prompt, previousKeys), "result", 600000, 1000);
  state.phase = "download";
  // Native host arms the single-file destination before clicking.
  state.download = () => result.click();
}
