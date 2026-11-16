/** Find one new output card for this exact prompt. Jimeng mounts the download
 * action when the pointer enters the output image. Header images are references. */
function jimengResultDownload(prompt, previousKeys) {
  const normalize = text => text.replace(/\s+/g, " ").trim();
  const records = [...document.querySelectorAll("[data-generated-record-key]")].filter(record => {
    if (previousKeys.has(record.dataset.generatedRecordKey)) return false;
    const text = record.querySelector('[class*="prompt-value-container"]');
    return text && normalize(text.textContent) === normalize(prompt);
  });
  if (records.length !== 1) return null;
  const record = records[0];
  const images = record.querySelectorAll('img[data-apm-action="ai-generated-image-record-card"]');
  if (images.length !== 1 || !images[0].complete || !images[0].naturalWidth) return null;
  const card = images[0].closest('[role="button"]');
  if (!card) return null;
  const buttons = record.querySelectorAll('[aria-label="下载"]:not([aria-disabled="true"]):not([aria-busy="true"])');
  if (buttons.length === 1) return buttons[0];
  if (!buttons.length) {
    for (const type of ["pointerover", "mouseover", "mouseenter", "mousemove"]) {
      card.dispatchEvent(new MouseEvent(type, {bubbles:true, view:window}));
    }
  }
  return null;
}
