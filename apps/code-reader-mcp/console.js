const el = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};
const rows = document.querySelector('#branches');
const snapshot = document.querySelector('#snapshot');
const jobLine = document.querySelector('#job');
const reload = document.querySelector('#reload');
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
  for (const control of document.querySelectorAll('button,input')) control.disabled = value;
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
    button.onclick = async () => {
      busy(true);
      try {
        const job = await api('export', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch: entry.branch, revision: entry.revision, clean: !entry.current || clean.checked }) });
        renderJob(job);
        await status();
      } catch (error) { fail(error); }
    };
    action.append(button);
    row.append(name, revision, el('td', time(entry.committedAt)), options, action);
    rows.append(row);
  }
  if (!branches.length) jobLine.textContent = '仓库还没有本地提交。';
  await status();
}
reload.onclick = () => load().catch(fail);
load().catch(fail);
