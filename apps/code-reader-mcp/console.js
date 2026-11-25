const el = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};
const rows = document.querySelector('#branches');
const snapshot = document.querySelector('#snapshot');
const jobLine = document.querySelector('#job');
const reload = document.querySelector('#reload');
const publishCurrent = document.querySelector('#publish-current');
const refreshServices = document.querySelector('#refresh-services');
const time = iso => new Date(iso).toLocaleString('zh-CN', { hour12: false });
async function api(url, options) {
  const response = await fetch('/api/' + url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}
function renderSnapshot(data) {
  snapshot.replaceChildren();
  if (!data) {
    snapshot.append(el('dd', '尚无可读取的快照'));
    return;
  }
  const items = [
    ['分支', data.branch ?? '旧快照未记录'],
    ['提交', data.revision.slice(0, 9)],
    ['工作区', data.isDirty === null ? '旧快照未记录' : data.isDirty ? '有未提交修改' : '干净'],
    ['导出时间', time(data.createdAt)],
    ['文件数', data.fileCount],
  ];
  for (const [label, value] of items) {
    const group = el('div');
    group.append(el('dt', label), el('dd', value));
    snapshot.append(group);
  }
}
function busy(value) {
  for (const control of document.querySelectorAll('#publish-current,#reload,#branches button,#branches input')) control.disabled = value;
}
function serviceSummary(service, processDetails) {
  if (service.process === 'multiple') return ['检测到多个实例'];
  if (service.process === 'unknown') return ['无法读取进程状态'];
  if (service.process === 'stopped') return ['当前未发现服务进程'];
  return processDetails;
}
function gptDetails(service) {
  if (service.reason === 'health_unavailable') return ['本机隧道管理接口暂不可用'];
  const control = service.controlPlane;
  const messages = [];
  if (control) {
    messages.push(control.state === 'polling' ? '控制面轮询中' : control.state === 'backoff' ? '控制面等待重试' : '控制面状态待确认');
    if (control.reason !== 'unknown') messages.push(control.reason);
    if (control.consecutiveFailures !== null) messages.push('连续失败 ' + control.consecutiveFailures + ' 次');
  }
  messages.push(({ healthy: '代理正常', unhealthy: '代理异常', disabled: '代理未启用', direct: '直连' })[service.proxy] ?? '代理状态待确认');
  messages.push(({ discovered: 'MCP 已发现', failed: 'MCP 发现失败' })[service.discovery] ?? 'MCP 尚未观察到发现请求');
  return messages;
}
function geminiDetails(service) {
  const messages = [
    ({ healthy: '本机 HTTP 正常', unhealthy: '本机 HTTP 异常', stopped: 'HTTP 子进程未运行', multiple: '检测到多个 HTTP 子进程' })[service.http],
    ({ connected: 'SSH 连接已建立', connecting: 'SSH 正在连接', stopped: 'SSH 转发未运行', multiple: '检测到多个 SSH 转发' })[service.ssh] ?? 'SSH 状态待确认',
  ];
  if (service.interface) messages.push('网卡 ' + service.interface);
  if (service.interfaceUnavailable) messages.push('绑定网卡不可用');
  if (service.config === 'invalid') messages.push('端口配置无效，探测默认端口');
  if (service.snapshot?.event === 'snapshot-rejected') {
    const reason = ({ size_limit: '超过大小限制', invalid_snapshot: '校验失败', read_error: '读取失败' })[service.snapshot.reason];
    messages.push('最近快照读取被拒绝' + (reason ? '（' + reason + '）' : ''));
  } else if (service.snapshot?.event === 'snapshot-loaded') messages.push('已加载快照');
  return messages.filter(Boolean);
}
function renderService(id, service, details) {
  const card = document.getElementById(id);
  const badge = card.querySelector('.service-state');
  badge.dataset.state = service.state;
  badge.textContent = ({ healthy: '正常', degraded: '连接中或异常', stopped: '未运行' })[service.state];
  card.querySelector('.service-detail').textContent = serviceSummary(service, details(service)).join(' · ');
}
let serviceTimer;
async function loadServices() {
  clearTimeout(serviceTimer);
  refreshServices.disabled = true;
  try {
    const { gpt, gemini } = await api('services');
    renderService('gpt-service', gpt, gptDetails);
    renderService('gemini-service', gemini, geminiDetails);
  } catch {
    for (const id of ['gpt-service', 'gemini-service']) {
      renderService(id, { state: 'degraded' }, () => ['无法读取运行状态，将自动重试']);
    }
  } finally {
    refreshServices.disabled = false;
    serviceTimer = setTimeout(loadServices, 5000);
  }
}
function renderJob(job) {
  busy(job.status === 'running');
  if (job.status === 'idle') { jobLine.textContent = ''; return; }
  const stage = { done: '已发布', failed: '导出失败', running: '正在导出' }[job.status];
  const coverage = { checked: '已通过', checking: '检查中', incomplete: '未通过', failed: '未完成' }[job.coverageStatus];
  jobLine.textContent = stage + ' ' + job.branch + ' · ' + job.exportedFiles + ' 个文件 · 已脱敏 ' +
    job.redactedLines + ' 行 · 覆盖检查' + coverage + (job.error ? '。' + job.error : '');
}
let timer;
async function status() {
  clearTimeout(timer);
  const state = await api('status');
  renderSnapshot(state.snapshot);
  renderJob(state.job);
  if (state.job.status === 'running') timer = setTimeout(() => status().catch(fail), 400);
}
function fail(error) { busy(false); jobLine.textContent = error.message; }
async function exportSnapshot(selection) {
  busy(true);
  jobLine.textContent = '正在准备导出快照…';
  try {
    const job = await api('export', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(selection) });
    renderJob(job);
    await status();
  } catch (error) { fail(error); }
}
async function load() {
  busy(true);
  const branches = await api('branches');
  rows.replaceChildren();
  for (const entry of branches) {
    const row = el('tr');
    const name = el('td', entry.branch);
    if (entry.current) name.append(el('small', '当前工作区'));
    const revision = el('td');
    revision.append(el('code', entry.revision.slice(0, 9)));
    const options = el('td');
    const clean = el('input');
    clean.type = 'checkbox';
    if (entry.current) {
      const label = el('label');
      label.append(clean, ' 仅导出干净 HEAD');
      options.append(el('small', '默认含工作区改动'), label);
    } else options.textContent = '分支提交';
    const action = el('td');
    const button = el('button', '更新快照');
    button.setAttribute('aria-label', '更新快照 ' + entry.branch);
    button.onclick = () => exportSnapshot({ branch: entry.branch, revision: entry.revision, clean: !entry.current || clean.checked });
    action.append(button);
    row.append(name, revision, el('td', time(entry.committedAt)), options, action);
    rows.append(row);
  }
  if (!branches.length) jobLine.textContent = '仓库还没有本地提交。';
  await status();
}
reload.onclick = () => load().catch(fail);
publishCurrent.onclick = () => exportSnapshot({ current: true });
refreshServices.onclick = loadServices;
void loadServices();
load().catch(fail);
