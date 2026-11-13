"use strict";
const code = document.getElementById("code");
const status = document.getElementById("status");
async function show(rotate) {
  const button = document.getElementById("rotate");
  button.disabled = true;
  try {
    const key = (!rotate && await BowerbirdPairing.load()) || await BowerbirdPairing.generate();
    code.value = chrome.runtime.id + "." + key.publicKey;
    code.select();
    status.textContent = "";
  } catch {
    status.textContent = "配对码生成失败，请更新浏览器后重试。";
  } finally { button.disabled = false; }
}
document.getElementById("rotate").addEventListener("click", () => show(true));
void show(false);
