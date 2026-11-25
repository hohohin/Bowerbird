"use strict";
const code = document.getElementById("code");
const status = document.getElementById("status");
const button = document.getElementById("rotate");

async function show(rotate) {
  button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: rotate ? "pairing_code_rotate" : "pairing_code_get" });
    if (!result?.ok || !result.code) throw new Error("Pairing code unavailable");
    if (code.value !== result.code) {
      code.value = result.code;
      code.select();
    }
    status.textContent = rotate ? "已生成新配对码，请在桌面端重新配对。" : "";
  } catch {
    code.value = "";
    status.textContent = "暂时无法读取配对码，请稍后重试。";
  } finally { button.disabled = false; }
}
button.addEventListener("click", event => {
  if (!event.isTrusted || !window.confirm("生成新配对码后，需要在 Bowerbird 桌面端重新配对。是否继续？")) return;
  void show(true);
});
window.addEventListener("focus", () => { if (!button.disabled) void show(false); });
void show(false);
