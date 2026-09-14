const $ = (id) => document.getElementById(id);
const statusLabels = { unused: "可发放", redeemed: "已兑换", disabled: "已停用", expired: "已过期" };
let client, config, session, inventory, busy = false, page = 0, exportRows = [], disableTarget = null;
let pendingIssue = null;
const pendingKey = "bowerbird.admin.pending-issue";
const date = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
  $("notice").hidden = !message;
}
function clearCodes() {
  disableTarget = null;
  exportRows = []; $("codes-output").value = "";
  $("codes-dialog").close(); $("disable-dialog").close();
}
function showLogin(message) {
  clearCodes(); inventory = null; $("code-rows").replaceChildren();
  $("console").hidden = true; $("login-panel").hidden = false;
  $("login-form").hidden = Boolean(session);
  $("login-status").textContent = message;
}
function setPending(value) {
  pendingIssue = value;
  if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value)); else sessionStorage.removeItem(pendingKey);
  for (const id of ["batch-label", "batch-count", "batch-expiry"]) $(id).readOnly = Boolean(value);
  $("issue-pending").hidden = !value;
  $("issue-submit").textContent = value ? "确认上次发码结果" : "＋ 生成兑换码";
}
async function api(action, fields = {}) {
  const identity = session?.user.id;
  const { data } = await client.auth.getSession();
  if (!data.session || data.session.user.id !== identity) throw new Error("登录状态已变化，请重新登录");
  async function send(token) {
    return fetch(`${config.supabaseUrl.replace(/\/+$/, "")}/functions/v1/code-admin?forceFunctionRegion=ap-northeast-1`, {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(45000),
      headers: { "Content-Type": "application/json", apikey: config.supabasePublishableKey || config.supabaseAnonKey, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...fields }),
    });
  }
  let response = await send(data.session.access_token);
  if (response.status === 401) {
    const { data: refreshed } = await client.auth.refreshSession();
    if (refreshed.session?.user.id === identity) response = await send(refreshed.session.access_token);
  }
  if (session?.user.id !== identity) throw new Error("账号已切换，已隐藏本次结果");
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error?.message || (response.status === 401 ? "登录已过期，请重新登录" : "管理服务暂时不可用，请重试");
    if (response.status === 401 || response.status === 403) showLogin(message);
    throw Object.assign(new Error(message), { status: response.status });
  }
  return payload;
}
async function run(work) {
  if (busy) return;
  busy = true; $("console").inert = true; $("console").setAttribute("aria-busy", "true"); $("logout").disabled = true;
  try { await work(); }
  catch (error) { notice(error.name === "TimeoutError" ? "请求超时。发码可用同一请求重试确认，或刷新清单查看结果。" : error.message, true); }
  finally { busy = false; $("console").inert = false; $("console").removeAttribute("aria-busy"); $("logout").disabled = false; }
}
function cell(text, small) {
  const td = document.createElement("td"); td.textContent = text;
  if (small) { const extra = document.createElement("small"); extra.textContent = small; td.append(extra); }
  return td;
}
function render() {
  const { stats, rows, total, batches } = inventory;
  for (const name of ["total", "unused", "redeemed"]) $(`stat-${name}`).textContent = Number(stats[name]).toLocaleString();
  $("stat-closed").textContent = `${stats.disabled} / ${stats.expired}`;
  $("result-count").textContent = `${total} 条记录`;
  const selected = $("batch-filter").value;
  const priorOption = $("batch-filter").selectedOptions[0];
  const options = [new Option("全部批次", ""), ...batches.map((b) => new Option(`${b.label} (${b.code_count})`, b.id))];
  if (selected && !batches.some((b) => b.id === selected)) options.push(new Option(priorOption?.textContent || selected, selected));
  $("batch-filter").replaceChildren(...options); $("batch-filter").value = selected;
  $("export").disabled = !selected;
  $("code-rows").replaceChildren(...rows.map((row) => {
    const tr = document.createElement("tr");
    const code = cell(row.code_suffix ? `•••• •••• · ${row.code_suffix}` : `ID · ${row.id.slice(0, 8)}`, row.batch_label);
    code.firstChild.replaceWith(Object.assign(document.createElement("span"), { className: "code", textContent: code.firstChild.textContent }));
    if (row.batch_id) { code.style.cursor = "pointer"; code.title = "筛选此批次"; }
    const batchButton = document.createElement("button");
    if (row.batch_id) {
      batchButton.className = "text-button"; batchButton.textContent = "查看批次";
      batchButton.addEventListener("click", () => void run(async () => { selectBatch(row.batch_id, row.batch_label); page = 0; await loadList(); }));
      code.append(batchButton);
    }
    const state = cell(""); state.append(Object.assign(document.createElement("span"), { className: `badge ${row.status}`, textContent: statusLabels[row.status] }));
    const recipient = row.redeemed_email || row.redeemed_by || "尚未领取";
    const actions = cell(""); actions.className = "right";
    const group = document.createElement("div"); group.className = "row-actions";
    if (row.status === "unused") {
      if (row.can_reveal) {
        const reveal = document.createElement("button"); reveal.textContent = "查看 / 复制";
        reveal.addEventListener("click", () => void run(async () => { const result = await api("reveal", { code_id: row.id }); showCodes(result.codes, row.batch_label); }));
        group.append(reveal);
      } else group.append(Object.assign(document.createElement("span"), { textContent: "请使用原始码单" }));
      const disable = document.createElement("button"); disable.className = "stop"; disable.textContent = "停用";
      disable.addEventListener("click", () => { disableTarget = row; $("disable-dialog").returnValue = "cancel"; $("disable-description").textContent = `${row.batch_label} · ${row.code_suffix || row.id.slice(0, 8)}`; $("disable-dialog").showModal(); });
      group.append(disable);
    } else group.textContent = "—";
    actions.append(group);
    tr.append(code, state, cell(date(row.expires_at), "北京时间"), cell(recipient, row.redeemed_at ? `兑换于 ${date(row.redeemed_at)}` : ""), actions);
    return tr;
  }));
  $("empty").hidden = rows.length !== 0;
  $("previous").disabled = page === 0;
  $("next").disabled = (page + 1) * 50 >= total;
  $("page-label").textContent = `第 ${page + 1} / ${Math.max(1, Math.ceil(total / 50))} 页 · 每页 50 条`;
}
function selectBatch(id, label) {
  if (![...$("batch-filter").options].some((o) => o.value === id)) $("batch-filter").add(new Option(label, id));
  $("batch-filter").value = id;
}
async function loadList() {
  inventory = await api("list", { status: $("status-filter").value, search: $("search").value.trim(), batch_id: $("batch-filter").value || null, page });
  render(); $("login-panel").hidden = true; $("console").hidden = false;
}
function showCodes(rows, label) {
  if (!rows.length) { notice("没有可导出的兑换码：可能已兑换、停用、过期，或来自旧版离线脚本。"); return; }
  exportRows = rows;
  $("codes-title").textContent = `${label} · ${rows.length} 张可用码`;
  $("codes-output").value = rows.map((r) => r.code).join("\n");
  $("copy-status").textContent = ""; $("codes-dialog").showModal();
}
$("filter-form").addEventListener("submit", (e) => { e.preventDefault(); void run(async () => { page = 0; await loadList(); }); });
for (const id of ["status-filter", "batch-filter"]) $(id).addEventListener("change", () => void run(async () => { page = 0; await loadList(); }));
$("refresh").addEventListener("click", () => void run(async () => { await loadList(); notice("兑换状态已更新。"); }));
$("previous").addEventListener("click", () => void run(async () => { page--; await loadList(); }));
$("next").addEventListener("click", () => void run(async () => { page++; await loadList(); }));
$("issue-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(async () => {
    const params = pendingIssue || { batch_id: crypto.randomUUID(), label: $("batch-label").value.trim(), count: Number($("batch-count").value), expires_at: new Date($("batch-expiry").value).toISOString() };
    setPending(params);
    let result;
    try { result = await api("issue", params); }
    catch (error) {
      // Definite validation/configuration failures did not issue a batch; allow corrections.
      if ([400, 403, 503].includes(error.status)) setPending(null);
      throw error;
    }
    setPending(null);
    selectBatch(result.batch_id, params.label); $("status-filter").value = ""; $("search").value = ""; page = 0;
    notice(`${result.created ? "已生成" : "已确认上次生成的"} ${result.count} 个兑换码，可以查看或导出此批次。`);
    await loadList();
    const exported = await api("export", { batch_id: result.batch_id }); showCodes(exported.codes, params.label);
  });
});
$("export").addEventListener("click", () => void run(async () => {
  const result = await api("export", { batch_id: $("batch-filter").value });
  showCodes(result.codes, $("batch-filter").selectedOptions[0].textContent);
}));
$("disable-dialog").addEventListener("close", () => {
  if ($("disable-dialog").returnValue !== "confirm" || !disableTarget) return;
  const target = disableTarget; disableTarget = null;
  void run(async () => { await api("disable", { code_id: target.id }); await loadList(); notice("兑换码已停用，不再接受兑换。"); });
});
$("close-codes").addEventListener("click", () => $("codes-dialog").close());
$("codes-dialog").addEventListener("close", () => { exportRows = []; $("codes-output").value = ""; });
$("copy-codes").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(exportRows.map((r) => r.code).join("\n")); $("copy-status").textContent = "已复制，可粘贴发给用户。"; }
  catch { $("codes-output").select(); $("copy-status").textContent = "浏览器未允许自动复制，请按 Ctrl/Cmd+C 复制选中内容。"; }
});
$("download-codes").addEventListener("click", () => {
  const csvCell = (value) => { let text = String(value); if (/^\s*[=+@-]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
  const lines = [["兑换码", "批次", "兑换截止时间", "权益"], ...exportRows.map((r) => [r.code, r.batch_label, date(r.expires_at), "1个月Pro + 1100积分"])];
  const url = URL.createObjectURL(new Blob(["\uFEFF", lines.map((r) => r.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = `Bowerbird-Pro-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (!client) return;
  $("login-submit").disabled = true;
  try {
    const { error } = await client.auth.signInWithOtp({ email: $("login-email").value.trim(), options: { shouldCreateUser: false, emailRedirectTo: `${location.origin}/admin/` } });
    if (error) throw error;
    $("login-status").textContent = "登录链接已发送，请在邮箱中打开。";
  } catch (error) { $("login-status").textContent = error.message; }
  finally { $("login-submit").disabled = false; }
});
$("logout").addEventListener("click", async () => {
  clearCodes(); setPending(null);
  // Clear this browser's session without signing the desktop app out.
  await client.auth.signOut({ scope: "local" });
});
async function accountChanged(next) {
  const previous = session?.user.id;
  if (previous && previous !== next?.user.id) setPending(null);
  session = next;
  $("logout").hidden = !session;
  $("account-email").textContent = session?.user.email || "管理员入口";
  if (!session) { setPending(null); showLogin("输入管理员邮箱，接收安全登录链接。"); return; }
  if (previous === session.user.id && inventory) return;
  clearCodes();
  try { await loadList(); }
  catch (error) { showLogin(error.message); }
}
async function init() {
  $("login-submit").disabled = true;
  const expiry = new Date(Date.now() + 90 * 86400000);
  expiry.setMinutes(expiry.getMinutes() - expiry.getTimezoneOffset()); $("batch-expiry").value = expiry.toISOString().slice(0, 16);
  try {
    config = await fetch("/api/image-config", { cache: "no-store" }).then((r) => { if (!r.ok) throw new Error("账号服务配置读取失败"); return r.json(); });
    if (!window.supabase && document.readyState !== "complete") await new Promise((resolve) => window.addEventListener("load", resolve, { once: true }));
    if (!window.supabase || !config.supabaseUrl || !(config.supabasePublishableKey || config.supabaseAnonKey)) throw new Error("管理后台尚未配置账号服务。");
    client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey || config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, flowType: "pkce", storageKey: "bowerbird.admin.auth" },
    });
    const { data } = await client.auth.getSession();
    await accountChanged(data.session);
    client.auth.onAuthStateChange((_event, next) => { setTimeout(() => void accountChanged(next), 0); });
    if (session) {
      try {
        const stored = JSON.parse(sessionStorage.getItem(pendingKey));
        if (stored?.batch_id) {
          $("batch-label").value = stored.label; $("batch-count").value = stored.count;
          const end = new Date(stored.expires_at); end.setMinutes(end.getMinutes() - end.getTimezoneOffset());
          $("batch-expiry").value = end.toISOString().slice(0, 16); setPending(stored);
        }
      } catch { setPending(null); }
    }
    $("login-submit").disabled = false;
  } catch (error) { showLogin(error.message); }
}
void init();
