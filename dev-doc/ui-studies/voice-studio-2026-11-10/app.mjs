import { initial, update, activeJob, canPreview, canSave } from './model.mjs';
const $ = selector => document.querySelector(selector);
const key = 'bowerbird-voice-review-v1';
function restore() { try { const saved = JSON.parse(localStorage.getItem(key)); return saved?.environment && saved?.creation ? saved : initial(); } catch { return initial(); } }
let state = restore(), modal = null, collapsed = false, uploadedUrl = null, toastTimer;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${({ sound: '<path d="M4 9v6m4-9v12m4-15v18m4-15v12m4-9v6"/>', play: '<path d="m9 5 11 7-11 7z"/>', plus: '<path d="M12 5v14M5 12h14"/>', file: '<path d="M14 2H5v20h14V7zM14 2v5h5M9 12v5m4-7v7"/>', down: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>', check: '<path d="m5 12 4 4L19 6"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>' })[name]}</svg>`;
const button = (text, action, classes = '', disabled = false, extra = '') => `<button class="${classes}" data-action="${action}" ${disabled ? 'disabled' : ''} ${extra}>${text}</button>`;
function persist() { try { localStorage.setItem(key, JSON.stringify(state)); } catch { toast('浏览器未允许保存；此页关闭后草稿可能丢失'); } }
function send(type, value, redraw = true) { state = update(state, { type, value }); persist(); if (redraw) render(); }
function toast(text) { $('#toast').textContent = text; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3500); }
const envLabels = { missing: '尚未启用', installing: '正在准备', ready: '本机配音已就绪', failed: '下载已中断', paused: '下载已暂停', unsupported: '当前设备暂不支持' };
const phases = { preparing: '正在准备声音引擎…', generating: '正在生成配音…', saving: '正在保存到项目…', done: '已保存到项目素材库', cancelled: '已取消，台词已保留', saveFailed: '音频已生成，尚未保存成功' };
function waveform(seed = 0) { return `<div class="wave" aria-hidden="true">${Array.from({ length: 70 }, (_, i) => `<i style="height:${6 + Math.abs(Math.sin(i * 1.73 + seed) * Math.cos(i * .19)) * 31}px"></i>`).join('')}</div>`; }
function audioLine(kind = 'clone', label = '试听示例') { return `<div class="audio-line">${button(icon('play'), 'play', 'play', false, `aria-label="${label}" data-kind="${kind}"`)}${waveform(kind === 'original' ? 4 : 2)}<small>${kind === 'original' ? '原声' : '试听'}</small></div>`; }
function sidebar() {
  return `<aside class="sidebar"><div class="sidebar-head">我的声音 <span>${String(state.voices.length).padStart(2, '0')}</span></div><div class="voices">${state.voices.map(voice => button(`<span class="voice-avatar">${esc(voice.name.slice(0, 1))}</span><span>${esc(voice.name)}<small>${voice.kind === 'clone' ? '来自参考录音' : '来自文字设计'}</small></span>`, 'select', 'voice', false, `data-id="${voice.id}" aria-pressed="${state.selected === voice.id}"`)).join('')}</div>${!state.voices.length ? '<p class="library-empty">保存喜欢的声音，<br>下次直接用它来配音。</p>' : ''}${button(`${icon('plus')} 创建声音`, 'create', 'new-voice')}<div class="environment">${button(`<i class="dot ${state.environment.phase === 'ready' ? 'ready' : ''}"></i>${envLabels[state.environment.phase]}`, 'setup')}<small>声音在这台电脑上生成</small></div></aside>`;
}
function startState() {
  const ready = state.environment.phase === 'ready';
  return `<div class="start-state"><div class="large-icon">${icon('sound')}</div><h2>${ready ? '为你的角色，找到声音' : '让你的角色开口说话'}</h2><p>${ready ? '从一段录音开始，或用文字描述你想要的声音。选定后，就能用它为角色配音。' : '第一次使用，应用会为你准备好本机配音所需的组件。以后只需要选择声音、输入台词。'}</p>${button(ready ? '创建第一个声音' : state.environment.phase === 'installing' ? '查看准备进度' : '启用本机配音', ready ? 'create' : 'setup', 'primary')}<span class="small muted">${ready ? '声音可在不同项目中复用' : '自动检测设备 · 支持中断后继续'}</span></div>`;
}
function result(job, index) {
  const busy = ['preparing', 'generating', 'saving'].includes(job.phase);
  const done = job.phase === 'done';
  return `<article class="result" aria-label="配音结果 ${index + 1}"><div class="result-meta"><span>${esc(job.voiceName)}</span><span>配音 ${String(state.jobs.length - index).padStart(2, '0')}</span><time>${index ? '较早' : '刚刚'}</time></div><p class="result-text">${esc(job.text)}</p>${done || job.phase === 'saveFailed' ? audioLine() : ''}<div class="${busy ? 'busy-line' : job.phase === 'saveFailed' ? 'error' : 'small muted'}">${busy ? '<i class="spinner"></i>' : ''}${phases[job.phase]}</div><div class="result-actions">${busy ? button('取消生成', 'cancel') : ''}${job.phase === 'saveFailed' ? button('重试保存', 'retrySave', 'primary', false, `data-id="${job.id}"`) : ''}${done ? button(job.onCanvas ? '已添加到画板' : '添加到画板', 'canvas', '', job.onCanvas, `data-id="${job.id}"`) + button('导出音频', 'export', '', false, `data-id="${job.id}"`) + button('再生成一版', 'again', '', !!activeJob(state), `data-id="${job.id}"`) : ''}${job.phase === 'cancelled' ? button('重新生成', 'again', '', !!activeJob(state), `data-id="${job.id}"`) : ''}</div></article>`;
}
function composer() {
  const voice = state.voices.find(voice => voice.id === state.selected);
  return `<div class="source-bar"><div class="row"><span class="voice-avatar">${esc(voice?.name.slice(0, 1))}</span><strong>${esc(voice?.name)}</strong><span class="tag">当前声音</span></div><div>${button('试听', 'play', '', false, 'data-kind="original"')}${button('管理', 'manage', '', false, `aria-label="管理 ${esc(voice?.name)}"`)}</div></div><div class="editor"><label for="script">台词</label><textarea id="script" placeholder="让这个角色，说出你写下的话…">${esc(state.draft)}</textarea><div class="editor-footer"><span>草稿自动保存</span><span id="count">${state.draft.length} 字</span></div></div><div class="actions"><small>生成结果保存到当前项目</small>${button(activeJob(state) ? '正在生成…' : '生成配音', 'generate', 'primary', !state.draft.trim() || !!activeJob(state), 'id="generate"')}</div><section class="results"><div class="results-head"><span>本项目配音</span><span>${state.jobs.length ? `${state.jobs.length} 段` : ''}</span></div>${state.jobs.length ? state.jobs.map(result).join('') : '<div class="results-empty">生成后，在这里试听、比较并添加到画板。</div>'}</section>`;
}
function main() { return `${sidebar()}<main><div class="main-head"><h1>角色声音</h1><small>本机配音</small></div>${state.environment.phase === 'ready' && state.voices.length ? composer() : startState()}</main>`; }
function render() {
  const focused = document.activeElement, id = focused?.id, start = focused?.selectionStart, end = focused?.selectionEnd;
  $('#workspace').innerHTML = collapsed ? `<div class="collapsed"><h2>创作画板</h2><p>${activeJob(state) ? '配音正在后台生成' : state.environment.phase === 'installing' ? '声音组件正在后台准备' : '声音和草稿都已保留'}</p>${button('返回角色声音', 'expand', 'primary')}</div>` : `<div class="layout">${main()}</div>`;
  if (modal) $('#dialog-content').innerHTML = dialogContent();
  if (id && document.getElementById(id)) { const element = document.getElementById(id); element.focus({ preventScroll: true }); if (typeof start === 'number' && element.type !== 'number') element.setSelectionRange?.(start, end); }
}
function show(type) { modal = type; render(); if (!$('#dialog').open) $('#dialog').showModal(); }
function close() { $('#player').pause(); $('#dialog').close(); modal = null; }
function dialogFrame(title, body, footer = '') { return `<div class="dialog-head"><h2 id="dialog-title">${title}</h2>${button(icon('close'), 'close', '', false, 'aria-label="关闭对话框"')}</div><div class="dialog-body">${body}</div>${footer ? `<div class="dialog-foot">${footer}</div>` : ''}`; }
function setupDialog() {
  const env = state.environment;
  const description = { missing: '你的电脑可以尝试本机配音。应用将自动下载并配置所需组件。', installing: '可以关闭此窗口，准备会在后台继续。', ready: '准备完成。创建一个声音，就可以开始配音了。', failed: '网络连接中断，已下载的内容已保留。', paused: '进度已保留，随时可以继续。', unsupported: '当前设备未检测到支持的 NVIDIA 显卡。可以继续查看声音，暂时无法在本机生成。' }[env.phase];
  const labels = { missing: '下载并启用', installing: '暂停下载', ready: '开始创建声音', failed: '继续下载', paused: '继续下载', unsupported: '重新检测' };
  const actions = { missing: 'install', installing: 'pauseInstall', ready: 'createReady', failed: 'install', paused: 'install', unsupported: 'redetect' };
  const phase = env.progress < 40 ? '正在下载配音组件' : env.progress < 80 ? '正在下载声音模型' : '正在校验并检查运行环境';
  const progress = ['installing', 'failed', 'paused'].includes(env.phase) ? `<div><div class="install-detail"><span>${env.phase === 'installing' ? phase : envLabels[env.phase]}</span><span>${env.progress}%</span></div><div class="progress"><div style="width:${env.progress}%"></div></div></div>` : '';
  return dialogFrame('启用本机配音', `<p class="muted">${description}</p>${env.phase !== 'unsupported' ? `<div class="install-list"><div><b>✓</b> NVIDIA 显卡已识别</div><div><b>✓</b> 安装空间充足</div><div><b>✓</b> 独立安装，不影响其他软件</div></div><p class="small muted">设备与空间数据为场景示意，正式版按检测结果展示。</p>` : ''}${progress}<details><summary>安装位置与详情</summary><p>默认：应用数据目录／声音组件</p>${button('更改安装位置', 'location', 'outline', env.phase === 'installing')}<p>下载量、剩余空间与校验结果将在检测后显示。</p></details>`, `<small>${env.phase === 'ready' ? '以后会自动准备，无需重复安装' : '首次准备完成后，可离线配音'}</small>${button(labels[env.phase], actions[env.phase], 'primary')}`);
}
function cloneSource() {
  const c = state.creation;
  if (!c.source) return `<div class="drop" id="drop"><div class="large-icon">${icon('file')}</div><h3>放入一段角色录音</h3><p>拖到这里，或从现有素材中选择</p><div class="drop-actions">${button('选择音频文件', 'upload', 'outline')}${button('从素材库选择', 'library', 'outline')}</div><span class="small muted">清晰的单人录音 · WAV / MP3 / FLAC / M4A / OGG</span></div>`;
  return `<div class="stack"><div class="file-row">${icon('file')}<span>${esc(c.source.name)}</span>${button('更换', 'upload')}</div>${audioLine('original', '试听参考录音')}<div class="clip-selector"><label>起点 <input id="clip-start" type="range" min="0" max="${c.end - 1}" step="0.1" value="${c.start}" aria-label="片段起点"><output>${c.start.toFixed(1)} s</output></label><label>终点 <input id="clip-end" type="range" min="${c.start + 1}" max="${Math.min(c.source.duration, c.start + 30)}" step="0.1" value="${c.end}" aria-label="片段终点"><output>${c.end.toFixed(1)} s</output></label></div><span class="small muted">已选 ${(c.end - c.start).toFixed(1)} 秒 · 拖动选择片段，试听时只播放选中部分</span></div>`;
}
function creationPreview() {
  const c = state.creation;
  if (c.preview === 'loading') return '<div class="busy-line"><i class="spinner"></i>正在准备试听…</div>';
  if (c.preview !== 'ready') return '';
  return `<div class="preview-card"><p>试听后，再决定是否保存这个声音</p>${audioLine('clone', '试听新声音')}<p class="small" style="margin:8px 0 0">此示意播放此前测试样本，不代表本次描述或上传录音的效果。</p></div><label class="field">声音名称<input id="voice-name" placeholder="例如：林岸、旁白" value="${esc(c.name)}" autocomplete="off"></label>`;
}
function createDialog() {
  const c = state.creation;
  const tabs = `<div class="segmented" role="group" aria-label="创建方式">${button('用录音创建', 'modeClone', '', false, `aria-pressed="${c.mode === 'clone'}"`)}${button('用文字创建', 'modeDesign', '', false, `aria-pressed="${c.mode === 'design'}"`)}</div>`;
  const source = c.mode === 'clone' ? cloneSource() : `<label class="field">描述你想要的声音<textarea id="description" placeholder="例如：年轻男性，低沉温暖，语气平静，适合叙事。">${esc(c.description)}</textarea></label><p class="small muted">可以多次试听，找到喜欢的声音再保存。</p>`;
  return dialogFrame('创建声音', `${tabs}${source}<div class="divider stack"><div class="row spread"><span class="small muted">试听台词：欢迎回来，我们可以开始今天的创作了。</span>${button(c.preview === 'loading' ? '准备中…' : c.preview === 'ready' ? '再试一个' : '生成试听', 'preview', 'outline', !canPreview(state) || c.preview === 'loading', 'id="preview"')}</div>${creationPreview()}</div>`, `<small>关闭后保留当前创建草稿</small>${button('保存并使用', 'saveVoice', 'primary', !canSave(state), 'id="save-voice"')}`);
}
function manageDialog() {
  const voice = state.voices.find(voice => voice.id === state.selected);
  if (!voice) return dialogFrame('声音已移除', '<p>请重新选择声音。</p>');
  return dialogFrame('管理声音', `<label class="field">声音名称<input id="rename" value="${esc(voice.name)}"></label>${audioLine('original')}<p class="small muted">声音在不同项目中共用，已生成的配音保留原来的版本。</p>`, `${button('删除声音', 'deleteConfirm', 'danger')}${button('保存名称', 'rename', 'primary')}`);
}
function dialogContent() {
  const templates = { setup: setupDialog, create: createDialog, manage: manageDialog,
    library: () => dialogFrame('选择参考录音', `<p class="small muted">项目素材 · 音频</p>${button(`${icon('file')} 角色参考录音.wav<small>3.9 秒 · 已有试听样本</small>`, 'sample', 'library-choice')}`, button('返回创建', 'backCreate')),
    remove: () => dialogFrame('删除这个声音？', '<p>仅从“我的声音”移除。已经生成的配音和原录音不会删除。</p>', `${button('保留', 'manage')}${button('删除声音', 'deleteVoice', 'danger')}`),
  };
  return templates[modal]();
}
async function play(kind, control) {
  const player = $('#player');
  if (!player.paused && player.control === control) { player.pause(); return; }
  let src = kind === 'original' ? '/audio/reference.wav' : '/audio/clone.wav';
  if (kind === 'original' && modal === 'create' && state.creation.source?.uploaded) {
    if (!uploadedUrl) { toast('刷新后请重新选择本机录音以试听'); return; }
    src = uploadedUrl;
  }
  player.src = src;
  player.control = control;
  player.dataset.kind = kind;
  player.currentTime = kind === 'original' && modal === 'create' ? state.creation.start : 0;
  try { await player.play(); } catch { toast('示例音频暂不可用，请选择本机录音试听'); }
}
function chooseFile() {
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.wav,.mp3,.flac,.m4a,.ogg';
  input.onchange = () => { if (input.files[0]) void loadFile(input.files[0]); }; input.click();
}
async function loadFile(file) {
  if (!/\.(wav|mp3|flac|m4a|ogg)$/i.test(file.name)) { toast('请选择支持的音频文件'); return; }
  const url = URL.createObjectURL(file), audio = new Audio();
  try {
    await new Promise((resolve, reject) => { audio.onloadedmetadata = resolve; audio.onerror = reject; audio.src = url; });
    if (!Number.isFinite(audio.duration) || audio.duration < 1) throw new Error('short');
    if (uploadedUrl) URL.revokeObjectURL(uploadedUrl); uploadedUrl = url;
    send('source', { name: file.name, duration: audio.duration, uploaded: true });
  } catch { URL.revokeObjectURL(url); toast('这段录音无法读取，或不足 1 秒，请换一段录音'); }
}
function enterCreate() { if (state.environment.phase !== 'ready') show('setup'); else show('create'); }
function saveVoice() { if (!canSave(state)) return; send('saveVoice'); close(); render(); toast('声音已保存，已为你选中'); }
function rename() { send('rename', { id: state.selected, name: $('#rename').value }); close(); render(); }
function again(id) { const job = state.jobs.find(job => job.id === id); send('draft', job.text); if (state.voices.length) send('generate'); else toast('请先创建或选择声音'); }
function exportSample() { const link = document.createElement('a'); link.href = '/audio/clone.wav'; link.download = '交互示意-历史试听样本.wav'; link.click(); toast('导出的是历史试听样本，并非本次输入台词'); }
const actions = {
  setup: () => show('setup'), close, create: enterCreate, createReady: () => show('create'),
  install: () => send('install'), pauseInstall: () => send('pauseInstall'), redetect: () => toast('设备不支持场景：请在顶部切换其他场景继续评审'),
  location: () => toast('正式版将在此打开安装文件夹选择器；示意不写入磁盘'),
  select: el => send('select', el.dataset.id), play: el => void play(el.dataset.kind, el),
  modeClone: () => send('mode', 'clone'), modeDesign: () => send('mode', 'design'),
  library: () => show('library'), backCreate: () => show('create'), upload: chooseFile,
  sample: () => { send('source', { name: '角色参考录音.wav', duration: 3.9 }); show('create'); },
  preview: () => send('preview'), saveVoice, manage: () => show('manage'), rename,
  deleteConfirm: () => show('remove'), deleteVoice: () => { send('deleteVoice', state.selected); close(); render(); toast('声音已移除，已有配音仍保留'); },
  generate: () => send('generate'), cancel: () => send('cancel'),
  retrySave: el => { send('retrySave', el.dataset.id); toast('已保存，没有重新生成'); },
  canvas: el => { send('canvas', el.dataset.id); toast('已添加到示意画板'); },
  export: exportSample, again: el => again(el.dataset.id), expand: () => { collapsed = false; render(); },
};
document.addEventListener('click', event => { const el = event.target.closest('[data-action]'); if (el && !el.disabled) actions[el.dataset.action](el); });
document.addEventListener('input', event => {
  const el = event.target;
  if (el.id === 'script') { send('draft', el.value, false); $('#count').textContent = `${el.value.length} 字`; $('#generate').disabled = !el.value.trim() || !!activeJob(state); }
  if (el.id === 'voice-name') { send('name', el.value, false); $('#save-voice').disabled = !canSave(state); }
  if (el.id === 'description') { send('description', el.value, false); $('#preview').disabled = !canPreview(state); $('#save-voice').disabled = true; }
});
document.addEventListener('change', event => {
  if (event.target.id.startsWith('clip-')) {
    const start = Number($('#clip-start').value), end = Number($('#clip-end').value);
    if (start < 0 || end > state.creation.source.duration || end - start < 1 || end - start > 30) { toast('请选择 1–30 秒、且在录音范围内的片段'); render(); return; }
    send('range', { start, end });
  }
});
document.addEventListener('dragover', event => { if (event.target.closest('#drop')) { event.preventDefault(); $('#drop').classList.add('drag'); } });
document.addEventListener('dragleave', event => event.target.closest('#drop')?.classList.remove('drag'));
document.addEventListener('drop', event => { if (event.target.closest('#drop')) { event.preventDefault(); if (event.dataTransfer.files[0]) void loadFile(event.dataTransfer.files[0]); } });
$('#player').addEventListener('timeupdate', () => { if (modal === 'create' && $('#player').dataset.kind === 'original' && $('#player').currentTime >= state.creation.end) $('#player').pause(); });
function playbackState() {
  document.querySelectorAll('.play').forEach(control => {
    const playing = !$('#player').paused && $('#player').control === control;
    control.innerHTML = playing ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" stroke="currentColor" stroke-width="2"/></svg>' : icon('play');
    control.setAttribute('aria-pressed', String(playing));
  });
}
['play', 'pause', 'ended'].forEach(type => $('#player').addEventListener(type, playbackState));
$('#dialog').addEventListener('cancel', () => { modal = null; $('#player').pause(); });
$('#collapse').onclick = () => { collapsed = true; render(); };
$('#theme').onclick = () => { const light = document.documentElement.dataset.theme !== 'light'; document.documentElement.dataset.theme = light ? 'light' : 'dark'; $('#theme').textContent = light ? '深色' : '浅色'; };
function scenario(value) {
  close(); state = initial(); collapsed = false;
  if (value === 'daily' || value === 'save') { state = update(state, { type: 'demo' }); state.draft = '别着急，天亮之前，我们一定能找到回家的路。'; }
  if (value === 'download') { state = update(state, { type: 'install' }); state = update(state, { type: 'tick' }); state = update(state, { type: 'installFailure' }); }
  if (value === 'save') { state = update(state, { type: 'generate' }); state = update(state, { type: 'saveFailure' }); }
  if (value === 'device') state = update(state, { type: 'unsupported' });
  persist(); render(); if (['download', 'device'].includes(value)) show('setup');
}
$('#scenario').onchange = event => scenario(event.target.value);
$('#reset').onclick = () => { if (confirm('清除本网页中的示意声音、配音和草稿？不会影响真实应用。')) { $('#scenario').value = 'first'; scenario('first'); } };
setInterval(() => {
  if (state.environment.phase === 'installing' || state.creation.preview === 'loading' || activeJob(state)) {
    const before = state.environment.phase; send('tick');
    if (before === 'installing' && state.environment.phase === 'ready') toast('本机配音已就绪');
  }
}, 950);
render();
