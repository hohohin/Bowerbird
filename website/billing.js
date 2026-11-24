const amount = document.querySelector("#custom-yuan");
const output = document.querySelector("#coin-total");
const hint = document.querySelector("#amount-hint");
const maxYuan = 21474836;
const formatter = new Intl.NumberFormat("zh-CN");
const menuButton = document.querySelector("#menu-toggle");
const navigation = document.querySelector("#site-nav");
const presets = [];

function setMenuOpen(open) {
  navigation.classList.toggle("is-open", open);
  menuButton.setAttribute("aria-expanded", String(open));
}

menuButton.addEventListener("click", () => setMenuOpen(menuButton.getAttribute("aria-expanded") !== "true"));
navigation.addEventListener("click", () => setMenuOpen(false));
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && menuButton.getAttribute("aria-expanded") === "true") {
    setMenuOpen(false);
    menuButton.focus();
  }
});
document.documentElement.classList.add("js");

for (const item of document.querySelectorAll(".denominations li")) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pack-option";
  button.setAttribute("aria-label", item.textContent.trim() + "，查看换算");
  button.append(...item.childNodes);
  button.addEventListener("click", () => {
    amount.value = item.dataset.yuan;
    updateEstimate();
  });
  item.append(button);
  presets.push({ button, yuan: Number(item.dataset.yuan) });
}

function updateEstimate() {
  const raw = amount.value.trim();
  const yuan = Number(raw);
  const valid = /^\d+$/.test(raw) && yuan >= 1 && yuan <= maxYuan;
  const invalid = raw !== "" && !valid;
  amount.setAttribute("aria-invalid", String(invalid));
  for (const preset of presets) {
    preset.button.setAttribute("aria-pressed", String(valid && yuan === preset.yuan));
  }
  output.textContent = valid ? formatter.format(yuan * 20) + " Bcoin" : "—";
  hint.classList.toggle("invalid", invalid);
  hint.textContent = invalid
    ? "请输入 1 至 " + formatter.format(maxYuan) + " 的整数金额。"
    : "选择充值包，或输入自定义整数金额。";
}

amount.addEventListener("input", updateEstimate);
updateEstimate();
document.querySelector("#custom-note").hidden = true;
document.querySelector("#calculator").hidden = false;
