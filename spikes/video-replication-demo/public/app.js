const $ = (id) => document.getElementById(id);
const state = { token: '', config: {}, environment: {}, tasks: [], task: null, step: 1, drafts: new Map(), shotPlans: new Map(), busy: new Set(), transcriptKey: '', analysisKey: '', shotKey: '', assetsKey: '', runKey: '', planKey: '', polling: false };
const statusLabels = { created: '准备获取', downloading: '获取中', ready: '待转写', transcribing: '转写中', transcribed: '待拆解', analyzing: '拆解中', analyzed: '可编辑', generating: '生成中', aligning: '成片转写中', subtitling: '字幕合成中', succeeded: '已完成', failed: '遇到问题', interrupted: '等待恢复' };
const chunkLabels = { pending: '等待生成', created: '等待生成', preparing: '准备分镜', submitting: '正在提交', submitted: '已提交', generating: '生成中', running: '生成中', processing: '生成中', downloading: '保存结果', aligning: '语音对齐', transcribing: '识别成片语音', subtitling: '合成字幕', succeeded: '已完成', failed: '失败', cancelled: '旧方案已停止', interrupted: '等待恢复', unknown: '提交待核对' };
const activeStatuses = new Set(['created', 'downloading', 'transcribing', 'analyzing', 'generating', 'aligning', 'subtitling']);
let toastTimer, pollCount = 0;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function visible(id, show) { $(id).hidden = !show; }
function time(ms, precise = false) {
  if (!Number.isFinite(ms)) return '—';
  const seconds = Math.max(0, ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}${precise ? `.${String(Math.round(ms % 1000)).padStart(3, '0')}` : ''}`;
}
function duration(task = state.task) { return Number(task?.meta?.duration) || 0; }
function locked(task = state.task) { return Boolean(task && activeStatuses.has(task.status)); }
function speechReady() { return Boolean(state.config.speechConfigured || state.config.speechApiKeyConfigured || (state.config.speechAppId && state.config.speechAccessTokenConfigured)); }
function hasTranscript(task = state.task) { return Boolean(task?.transcript); }
function hasAnalysis(task = state.task) { return Boolean(task?.analysis?.shots?.length); }
function legacyRun(run) { return Boolean(run && run.workflow !== 'storyboard-v2'); }
function hasDialogueIssues() {
  const draft = getDraft();
  return Boolean(state.shotPlans.get(state.task?.id)?.some(chunk => chunk.dialogueIssue && !Object.hasOwn(draft?.edits.shots[chunk.shotId] || {}, 'dialogue')));
}
function canOpenStep(step, task = state.task) {
  if (step === 1) return true;
  if (step === 2) return Boolean(task?.sourceUrl);
  if (step === 3) return hasAnalysis(task);
  return hasAnalysis(task) || Boolean(task?.runs?.length);
}
function safeMessage(error) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /[\u3400-\u9fff]/.test(message) && message.length <= 600 ? message : '操作未能完成，请检查本机服务后再试。';
}
function toast(message, isError = false) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').classList.toggle('error', isError); visible('toast', true);
  toastTimer = setTimeout(() => visible('toast', false), isError ? 6500 : 3500);
}
async function api(path, { method = 'GET', body } = {}) {
  let response;
  try { response = await fetch(path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-Demo-Token': state.token } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
  catch { throw new Error('无法连接本机 Demo，请确认服务仍在运行。'); }
  let result;
  try { result = await response.json(); } catch { throw new Error('本机服务返回的内容无法读取，请稍后重试。'); }
  if (!response.ok) throw new Error(safeMessage(result.error || result.message));
  return result;
}
async function action(name, work) {
  if (state.busy.has(name)) return;
  state.busy.add(name); renderControls();
  try { return await work(); } catch (error) { toast(safeMessage(error), true); }
  finally { state.busy.delete(name); renderControls(); }
}
function seek(ms) {
  if (!Number.isFinite(ms) || !$('source-video').getAttribute('src')) return;
  $('source-video').currentTime = ms / 1000;
  $('source-video').play().catch(() => {});
}
function timeButton(ms) {
  const button = node('button', 'time-button', time(ms)); button.type = 'button'; button.disabled = !Number.isFinite(ms);
  button.setAttribute('aria-label', Number.isFinite(ms) ? `播放 ${time(ms)} 的原视频` : '原句没有起始时间');
  button.addEventListener('click', () => seek(ms)); return button;
}
function setVideo(id, url, poster) {
  const video = $(id);
  if (video.getAttribute('src') !== url) {
    video.pause();
    if (url) video.setAttribute('src', url); else video.removeAttribute('src');
    video.load();
  }
  if (poster) video.setAttribute('poster', poster); else video.removeAttribute('poster');
}

function renderHistory() {
  $('task-count').textContent = state.tasks.length;
  const key = JSON.stringify(state.tasks.map((task) => [task.id, task.title, task.status, task.updatedAt])) + (state.task?.id || '');
  if ($('task-list').dataset.key === key) return;
  $('task-list').dataset.key = key; $('task-list').replaceChildren();
  if (!state.tasks.length) { $('task-list').append(node('p', 'muted sidebar-empty', '还没有任务。\n从一个抖音链接开始。')); return; }
  for (const task of state.tasks) {
    const button = node('button', `task-item${state.task?.id === task.id ? ' selected' : ''}`); button.type = 'button';
    if (state.task?.id === task.id) button.setAttribute('aria-current', 'page');
    button.append(node('span', 'task-item-title', task.title || '新的复刻'));
    const meta = node('span', 'task-item-meta');
    meta.append(node('span', `status-dot ${task.status === 'succeeded' ? 'ready' : activeStatuses.has(task.status) ? 'busy' : task.status === 'failed' ? 'error' : ''}`));
    meta.append(node('span', '', statusLabels[task.status] || '等待处理'));
    const date = new Date(task.updatedAt); const stamp = node('time', '', Number.isNaN(date.valueOf()) ? '' : `${date.getMonth() + 1}/${date.getDate()}`); meta.append(stamp); button.append(meta);
    button.addEventListener('click', () => selectTask(task.id)); $('task-list').append(button);
  }
}
function mergeTask(task) {
  const index = state.tasks.findIndex((item) => item.id === task.id);
  if (index === -1) state.tasks.unshift(task); else state.tasks[index] = task;
  if (state.task?.id === task.id) {
    const previous = state.task;
    state.task = task;
    if (!previous.sourceUrl && task.sourceUrl && state.step === 1) setStep(2);
    if (!hasAnalysis(previous) && hasAnalysis(task) && state.step === 2) setStep(3);
    renderTask();
  }
  renderHistory();
}
async function selectTask(id) {
  if (state.task?.id === id) return;
  if (state.task) saveDraft(state.task.id, true).catch(() => {});
  await action('select', async () => {
    const { task } = await api(`/api/tasks/${id}`);
    state.task = task; state.transcriptKey = ''; state.assetsKey = ''; state.runKey = ''; state.planKey = '';
    getDraft(task);
    try { localStorage.setItem('replication-selected-task', id); } catch {}
    state.step = task.runs?.length ? 4 : hasAnalysis(task) ? 3 : task.sourceUrl ? 2 : 1;
    renderTask(true); renderHistory();
    if (hasAnalysis(task)) refreshShotPlan();
  });
}
function setStep(step) {
  const task = state.task;
  if (!canOpenStep(step, task)) return;
  state.step = step;
  for (let value = 1; value <= 4; value++) visible(`step-${value}`, value === step);
  document.querySelectorAll('[data-step]').forEach((button) => {
    const value = Number(button.dataset.step);
    if (value === step) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
    button.disabled = !canOpenStep(value, task);
    button.classList.toggle('complete', value === 1 && Boolean(task?.sourceUrl) || value === 2 && hasAnalysis(task) || value === 3 && Boolean(task?.runs?.length) || value === 4 && task?.status === 'succeeded');
  });
  if (step === 3 && !state.shotPlans.has(task.id)) refreshShotPlan();
}
function renderTask(forceEdits = false) {
  const task = state.task;
  if (forceEdits && task) $('source-input').value = task.input || '';
  const planVariant = `${task?.id || ''}:${JSON.stringify(task?.analysis?.shots || [])}:${task?.runs?.at(-1)?.id || ''}:${task?.runs?.at(-1)?.status || ''}`;
  if ($('plan-content').dataset.variant !== planVariant) {
    $('plan-content').dataset.variant = planVariant; invalidatePlan();
  }
  $('task-title').textContent = task?.title || '新的复刻';
  visible('source-video', Boolean(task?.sourceUrl)); visible('source-empty', !task?.sourceUrl);
  setVideo('source-video', task?.sourceUrl || null, task?.posterUrl);
  $('source-meta').textContent = task?.meta ? `${duration(task).toFixed(1)}s · ${task.meta.width} × ${task.meta.height}` : '等待导入';
  $('source-name').textContent = task?.title || '支持抖音分享链接';
  visible('source-download', Boolean(task?.sourceUrl));
  if (task?.sourceUrl) $('source-download').href = task.sourceUrl;
  visible('continue-transcript', Boolean(task?.sourceUrl));
  visible('retry-acquire', Boolean(task && !task.sourceUrl && ['failed', 'interrupted'].includes(task.status)));
  visible('task-status', Boolean(task));
  if (task) {
    $('task-status-message').textContent = task.message || statusLabels[task.status] || '等待处理';
    $('task-status').classList.toggle('is-error', task.status === 'failed');
    $('task-status-dot').className = `status-dot ${activeStatuses.has(task.status) ? 'busy' : task.status === 'failed' ? 'error' : task.status === 'succeeded' ? 'ready' : ''}`;
  }
  renderTranscript(forceEdits); renderAnalysis(); renderShotEditors(forceEdits); renderAssets(); renderGeneration(); renderControls(); setStep(state.step);
}
function renderControls() {
  const task = state.task, inProgress = locked(task);
  $('import-button').disabled = state.busy.has('import') || Boolean(task && ['created', 'downloading'].includes(task.status));
  $('import-button').textContent = state.busy.has('import') || task?.status === 'downloading' ? '正在获取视频…' : '获取参考视频 ↗';
  $('retry-acquire').disabled = state.busy.has('acquire') || inProgress;
  const noAudio = task?.meta?.hasAudio === false;
  const canTranscribe = Boolean(task?.sourceUrl && (noAudio || speechReady()));
  $('transcribe-button').disabled = !canTranscribe || inProgress || hasTranscript(task) || state.busy.has('transcribe');
  $('transcribe-button').textContent = task?.status === 'transcribing' || state.busy.has('transcribe') ? '正在识别台词…' : hasTranscript(task) ? '转写已完成' : noAudio ? '无语音，继续替换画面' : '开始语音转写';
  visible('speech-settings', !speechReady() && !noAudio);
  let transcriptGate = '';
  if (!task?.sourceUrl) transcriptGate = '请先获取参考视频。';
  else if (noAudio) transcriptGate = '这个视频没有音轨。可以继续替换人物或产品，跳过语音服务调用。';
  else if (!speechReady()) transcriptGate = '请先在服务配置中填写豆包语音 API Key。';
  $('transcript-gate').textContent = transcriptGate; visible('transcript-gate', Boolean(transcriptGate));
  const analyzed = hasAnalysis(task), manyShots = (task?.analysis?.shots?.length || 0) > 1;
  const existingFullText = Boolean(getDraft(task)?.edits.fullText.trim());
  let analysisGate = !hasTranscript(task) ? '请先完成原声转写，再开始视觉拆解。' : !state.environment.codex?.ready ? '请在服务配置中填写本机 Codex CLI，并确认已登录。' : '';
  $('analysis-gate').textContent = analysisGate; visible('analysis-gate', Boolean(analysisGate));
  $('analyze-button').disabled = !hasTranscript(task) || !state.environment.codex?.ready || analyzed || inProgress || state.busy.has('analyze');
  $('analyze-button').textContent = task?.status === 'analyzing' || state.busy.has('analyze') ? '正在抽帧与拆解…' : analyzed ? '视觉拆解已完成' : '开始视觉拆解';
  visible('analysis-settings', hasTranscript(task) && !state.environment.codex?.ready);
  visible('continue-edits', analyzed); $('continue-edits').disabled = !analyzed || inProgress;
  $('edit-fields').disabled = !analyzed || inProgress;
  visible('edit-gate', !analyzed);
  $('full-text').disabled = !analyzed || inProgress || (manyShots && !existingFullText);
  $('full-text-hint').textContent = manyShots ? existingFullText ? '当前是多镜头。请清空旧的整段台词，改用逐句替换或每镜头台词后再生成。' : '当前是多镜头，请使用逐句替换或每镜头台词。' : '单镜头可使用完整台词；每镜头台词也可单独覆盖。';
  $('save-edits').disabled = !analyzed || inProgress || state.busy.has('save');
  $('continue-generation').disabled = !analyzed || inProgress || state.busy.has('save') || (manyShots && existingFullText) || hasDialogueIssues();
  $('upload-button').disabled = !analyzed || inProgress || state.busy.has('upload');
  $('upload-button').textContent = state.busy.has('upload') ? '正在保存图片…' : '＋ 添加图片';
  document.querySelectorAll('.remove-asset').forEach((button) => { button.disabled = inProgress || state.busy.has('asset'); });
  const lastRun = task?.runs?.at(-1);
  let generationGate = '';
  const legacy = legacyRun(lastRun), hasSubmitted = lastRun?.chunks?.some(chunk => chunk.submitId);
  const submissionUnknown = lastRun?.status === 'unknown' || lastRun?.chunks?.some(chunk => chunk.status === 'unknown' || (chunk.status === 'submitting' && !chunk.submitId));
  const legacyCanResume = legacy && !submissionUnknown && !['succeeded', 'failed'].includes(lastRun.status) && (lastRun.status === 'interrupted' || hasSubmitted);
  if (submissionUnknown) generationGate = '上一次提交的结果尚未确认。请先在即梦任务历史中核对，避免重复生成和计费。';
  else if (!analyzed && !legacyCanResume) generationGate = legacy ? '这是旧的视频参考方案，已停止新提交。请返回「转写与拆解」完成视觉分析，再使用新的分镜方案。' : '先完成原声转写与视觉拆解，再编辑分镜。';
  else if (legacy && !legacyCanResume && !['succeeded', 'failed'].includes(lastRun.status)) generationGate = '旧方案不会再提交新片段。已有任务可在即梦历史中核对。';
  else if (manyShots && existingFullText && (!lastRun || ['succeeded', 'failed'].includes(lastRun.status))) generationGate = '多镜头不能使用整段替换台词，请返回编辑并改用逐句或每镜头台词。';
  else if (hasDialogueIssues() && (!lastRun || ['succeeded', 'failed'].includes(lastRun.status))) generationGate = '有台词无法按原始时间分配到镜头，请返回编辑，逐镜头填写或清空对应台词。';
  else if (!state.environment.jimeng?.ready) generationGate = '尚未找到即梦 CLI。请在服务配置中指定本机程序，并确认账号已登录。';
  else if (!state.environment.ffmpeg?.ready || !state.environment.ffprobe?.ready) generationGate = '媒体工具尚未就绪，请在服务配置中补全 FFmpeg 和 FFprobe。';
  else if (!speechReady() && !legacyCanResume) generationGate = '生成后需要豆包语音识别实际口播，请先填写语音 Key。';
  const frozenNotice = legacy ? analyzed && ['succeeded', 'failed'].includes(lastRun.status) ? '历史版本使用旧的视频参考方案。新版本会采用当前分镜文字与替换图片，历史作品继续保留。' : legacyCanResume && !hasSubmitted ? '旧方案已中断，尚无提交编号。点击下方按钮停止未提交部分，再完成视觉拆解并生成新版本。' : '旧的视频参考方案：已有提交编号继续查询，未提交片段将停止；历史成片仍可下载。' : lastRun && !['succeeded', 'failed', 'unknown'].includes(lastRun.status) ? '继续原任务会使用提交时冻结的分镜、台词和图片。当前修改已保留，可在原任务完成后用于新版本。' : '';
  $('generation-gate').textContent = generationGate || frozenNotice; visible('generation-gate', Boolean(generationGate || frozenNotice));
  $('generate-button').disabled = Boolean(generationGate) || inProgress || state.busy.has('generate');
  $('generate-button').textContent = ['generating', 'aligning', 'subtitling'].includes(task?.status) || state.busy.has('generate') ? '正在制作视频…' : legacyCanResume ? hasSubmitted ? '查询已有生成任务 ↗' : '停止旧方案未提交部分' : lastRun?.status === 'succeeded' ? '重新生成一个版本 ↗' : lastRun?.status === 'failed' ? '生成新版本 ↗' : submissionUnknown ? '提交结果待核对' : lastRun ? '继续原生成任务 ↗' : '开始生成视频 ↗';
  $('refresh-plan').disabled = !(analyzed || lastRun) || state.busy.has('plan');
  renderSaveStatus();
}

function draftKey(id) { return `replication-draft:${id}`; }
function getDraft(task = state.task) {
  if (!task) return null;
  if (state.drafts.has(task.id)) return state.drafts.get(task.id);
  let local;
  try { local = JSON.parse(localStorage.getItem(draftKey(task.id))); } catch {}
  const value = local?.edits || task.edits || {};
  const draft = { id: task.id, edits: { fullText: typeof value.fullText === 'string' ? value.fullText : '', direction: typeof value.direction === 'string' ? value.direction : '', replacements: { ...value.replacements }, shots: structuredClone(value.shots || {}) }, version: local ? 1 : 0, savedVersion: 0, saving: null, timer: null, error: '' };
  state.drafts.set(task.id, draft); return draft;
}
function persistDraft(draft) {
  try { localStorage.setItem(draftKey(draft.id), JSON.stringify({ edits: draft.edits })); } catch {}
}
function invalidatePlan() {
  state.planKey = '';
  $('plan-content').textContent = '展开或点击刷新，查看当前制作计划。';
}
function changeEdit(key, value, index) {
  const draft = getDraft(); if (!draft) return;
  if (key === 'replacements') draft.edits.replacements[index] = value; else draft.edits[key] = value;
  draft.version++; draft.error = ''; persistDraft(draft); invalidatePlan(); renderSaveStatus(); renderGenerationSummary();
  clearTimeout(draft.timer); draft.timer = setTimeout(() => saveDraft(draft.id, true).catch(() => {}), 850);
  if (key === 'fullText') renderControls();
}
function changeShot(id, field, value) {
  const draft = getDraft(); if (!draft) return;
  draft.edits.shots[id] ||= {};
  if (field === 'imageIds' || field === 'dialogue' || value.trim()) draft.edits.shots[id][field] = value; else delete draft.edits.shots[id][field];
  if (!Object.keys(draft.edits.shots[id]).length) delete draft.edits.shots[id];
  draft.version++; draft.error = ''; persistDraft(draft); invalidatePlan(); renderSaveStatus(); renderGenerationSummary();
  clearTimeout(draft.timer); draft.timer = setTimeout(() => saveDraft(draft.id, true).catch(() => {}), 850);
  renderShotEditors(); renderControls();
}
async function saveDraft(id, quiet = false) {
  const draft = state.drafts.get(id);
  if (!draft || draft.version === draft.savedVersion) return;
  clearTimeout(draft.timer);
  if (draft.saving) { await draft.saving; if (draft.version !== draft.savedVersion) return saveDraft(id, quiet); return; }
  const version = draft.version; const edits = structuredClone(draft.edits);
  draft.saving = (async () => {
    try {
      await api(`/api/tasks/${id}/edits`, { method: 'POST', body: edits });
      draft.savedVersion = version; draft.error = '';
      if (draft.version === version) { try { localStorage.removeItem(draftKey(id)); } catch {} }
    } catch (error) { draft.error = safeMessage(error); persistDraft(draft); if (!quiet) toast(draft.error, true); throw error; }
  })();
  renderSaveStatus();
  try { await draft.saving; } finally { draft.saving = null; renderSaveStatus(); }
  if (draft.version !== draft.savedVersion) return saveDraft(id, quiet);
  if (state.task?.id === id && hasAnalysis()) refreshShotPlan();
}
function renderSaveStatus() {
  const draft = getDraft();
  $('save-status').textContent = !draft || draft.version === draft.savedVersion ? '已保存' : draft.saving ? '正在保存…' : draft.error ? '待保存 · 草稿已留在本机' : '未保存';
  $('save-status').classList.toggle('unsaved', Boolean(draft && draft.version !== draft.savedVersion));
  $('save-status').title = draft?.error || '';
}
function renderTranscript(force = false) {
  const task = state.task, transcript = task?.transcript;
  visible('transcript-empty', !transcript); visible('transcript-content', Boolean(transcript));
  const utterances = transcript?.utterances || [];
  const key = `${task?.id || ''}:${JSON.stringify(transcript)}`;
  if (!force && key === state.transcriptKey) return;
  state.transcriptKey = key;
  $('transcript-list').replaceChildren(); $('edits-list').replaceChildren();
  $('transcript-count').textContent = transcript ? `${utterances.length} 句` : '';
  const timedWords = (transcript?.words || []).filter((word) => Number.isFinite(word.startMs) && Number.isFinite(word.endMs)).length;
  $('timing-summary').textContent = timedWords ? `${timedWords} 个词语具有时间信息` : transcript ? '未返回有效词级时间；缺失时间保持为空' : '';
  if (transcript) {
    $('transcript-download').href = task.transcriptUrl; $('srt-download').href = task.srtUrl;
    if (!utterances.length) $('transcript-list').append(node('p', 'utterance-text', transcript.text || '本次未识别到语音。'));
  }
  const draft = getDraft(task);
  $('full-text').value = draft?.edits.fullText || ''; $('direction').value = draft?.edits.direction || '';
  if (draft?.edits.fullText) $('full-text-details').open = true;
  utterances.forEach((utterance, index) => {
    const row = node('div', 'utterance'); const main = node('div', 'utterance-main'); main.append(timeButton(utterance.startMs), node('div', 'utterance-text', utterance.text)); row.append(main);
    if (utterance.words?.length) {
      const details = node('details', 'word-details'); details.append(node('summary', '', `查看 ${utterance.words.length} 个词语的时间`)); const words = node('div', 'word-list');
      utterance.words.forEach((word) => {
        const button = node('button', 'word', word.text); button.type = 'button'; button.disabled = !Number.isFinite(word.startMs);
        button.title = `${word.text} · ${time(word.startMs, true)} — ${time(word.endMs, true)}`; button.setAttribute('aria-label', button.title);
        button.addEventListener('click', () => seek(word.startMs)); words.append(button);
      }); details.append(words); row.append(details);
    }
    $('transcript-list').append(row);
    const edit = node('div', 'edit-line'); const header = node('div', 'edit-line-header'); header.append(timeButton(utterance.startMs), node('div', 'original-text', utterance.text)); edit.append(header);
    const input = node('textarea'); input.rows = 2; input.placeholder = '输入这句的新台词'; input.value = draft?.edits.replacements[index] || ''; input.setAttribute('aria-label', `第 ${index + 1} 句替换台词`);
    input.addEventListener('input', () => changeEdit('replacements', input.value, index)); edit.append(input); $('edits-list').append(edit);
  });
  if (transcript && !utterances.length) $('edits-list').append(node('p', 'field-hint', '本次没有分句信息，可在上方按镜头填写台词。'));
  renderSaveStatus();
}
function renderAnalysis() {
  const analysis = state.task?.analysis, shots = analysis?.shots || [];
  const key = `${state.task?.id || ''}:${JSON.stringify(analysis)}`;
  visible('analysis-content', Boolean(shots.length));
  $('analysis-count').textContent = shots.length ? `${shots.length} 个镜头` : '';
  if (state.analysisKey === key) return;
  state.analysisKey = key;
  $('analysis-summary').textContent = analysis?.summary || '';
  $('analysis-style').textContent = analysis?.style ? `视觉风格：${typeof analysis.style === 'string' ? analysis.style : JSON.stringify(analysis.style)}` : '';
  $('analysis-frames').replaceChildren();
  for (const frame of analysis?.frames || []) {
    const button = node('button', 'analysis-frame'); button.type = 'button';
    button.setAttribute('aria-label', `查看 ${time(frame.timeMs)} 的原始画面`);
    const image = node('img'); image.src = frame.url; image.alt = `${time(frame.timeMs)} 原片抽帧`; image.loading = 'lazy';
    button.append(image, node('span', 'mono', time(frame.timeMs)));
    button.addEventListener('click', () => seek(frame.timeMs)); $('analysis-frames').append(button);
  }
}
function shotDefaults(shot) {
  const planned = state.shotPlans.get(state.task?.id)?.find(chunk => chunk.shotId === shot.id);
  return { visual: planned?.visual ?? shot.visual ?? '', camera: planned?.camera ?? shot.camera ?? '', action: planned?.action ?? shot.action ?? '', dialogue: planned?.dialogue ?? '' };
}
function renderShotEditors(force = false) {
  const task = state.task, shots = task?.analysis?.shots || [];
  const images = task?.images || [];
  const key = `${task?.id || ''}:${JSON.stringify(shots)}:${JSON.stringify(images)}`;
  $('shot-edit-count').textContent = shots.length ? `${shots.length} 个镜头` : '';
  if (force || state.shotKey !== key) {
    state.shotKey = key; $('shot-edit-list').replaceChildren();
    for (const [index, shot] of shots.entries()) {
      const card = node('section', 'shot-card');
      const header = node('div', 'shot-heading'); header.append(node('h4', '', `镜头 ${index + 1}`), timeButton(shot.startMs), node('span', 'mono muted', `— ${time(shot.endMs)}`)); card.append(header);
      const assets = node('div', 'shot-assets');
      const summary = node('p', 'field-hint shot-asset-summary'); summary.dataset.shotId = shot.id; summary.setAttribute('role', 'status'); assets.append(summary);
      if (!images.length) assets.append(node('p', 'field-hint', '先在上方上传人物或产品图片，再在此镜头勾选。'));
      for (const [role, title] of [['person', '人物'], ['product', '产品']]) {
        const candidates = images.filter(image => image.role === role);
        if (!candidates.length) continue;
        const group = node('fieldset', 'shot-asset-group'); group.append(node('legend', '', `替换${title}`));
        const choices = node('div', 'shot-asset-choices');
        for (const asset of candidates) {
          const label = node('label', 'shot-asset-choice');
          const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.dataset.shotId = shot.id; checkbox.dataset.imageId = asset.id;
          checkbox.setAttribute('aria-label', `镜头 ${index + 1} 选择${title}：${asset.name}`);
          checkbox.addEventListener('change', () => {
            const selected = getDraft().edits.shots[shot.id]?.imageIds || [];
            changeShot(shot.id, 'imageIds', checkbox.checked ? [...selected, asset.id] : selected.filter(id => id !== asset.id));
          });
          const image = node('img'); image.src = asset.url; image.alt = ''; image.loading = 'lazy';
          const name = node('span', 'shot-asset-name', asset.name); name.title = asset.name;
          const badge = node('span', 'shot-asset-number');
          label.append(checkbox, image, name, badge); choices.append(label);
        }
        group.append(choices); assets.append(group);
      }
      card.append(assets);
      for (const [field, label, rows] of [['visual', '画面与构图', 3], ['camera', '景别与运镜', 2], ['action', '主体动作', 2], ['dialogue', '本镜头台词', 3]]) {
        const inputId = `shot-${index}-${field}`;
        const labelNode = node('label', '', label); labelNode.htmlFor = inputId;
        const input = node('textarea', `shot-input shot-${field}`); input.id = inputId; input.rows = rows; input.dataset.shotId = shot.id; input.dataset.field = field;
        input.placeholder = field === 'dialogue' ? '按原声时间匹配；也可在这里填写此镜头的新台词' : '留空采用视觉拆解结果';
        input.addEventListener('input', () => changeShot(shot.id, field, input.value));
        input.addEventListener('blur', () => renderShotEditors());
        card.append(labelNode, input);
      }
      const issue = node('p', 'notice shot-issue'); issue.dataset.shotId = shot.id; issue.setAttribute('role', 'status'); issue.hidden = true; card.append(issue);
      card.append(node('p', 'field-hint', '如本镜头无需口播，可清空台词并保存。'));
      if (shot.transition) card.append(node('p', 'field-hint', `转场参考：${shot.transition}`));
      $('shot-edit-list').append(card);
    }
  }
  const draft = getDraft(task);
  for (const input of $('shot-edit-list').querySelectorAll('input[type="checkbox"]')) {
    const ids = draft?.edits.shots[input.dataset.shotId]?.imageIds || [];
    const position = ids.indexOf(input.dataset.imageId);
    input.checked = position >= 0; input.disabled = locked(task) || (position < 0 && ids.length >= 30);
    input.parentElement.classList.toggle('selected', input.checked);
    input.parentElement.querySelector('.shot-asset-number').textContent = position >= 0 ? `图片 ${position + 1}` : '';
  }
  for (const summary of $('shot-edit-list').querySelectorAll('.shot-asset-summary')) {
    const count = draft?.edits.shots[summary.dataset.shotId]?.imageIds?.length || 0;
    summary.textContent = count ? `本镜头已选 ${count} 张 · 仅发送选中图片（最多 30 张）` : '本镜头未选图片 · 仅按分镜文字生成';
  }
  for (const input of $('shot-edit-list').querySelectorAll('textarea')) {
    if (input === document.activeElement) continue;
    const shot = shots.find(item => item.id === input.dataset.shotId);
    const override = draft?.edits.shots[shot.id]?.[input.dataset.field];
    input.value = override ?? shotDefaults(shot)[input.dataset.field];
  }
  for (const issue of $('shot-edit-list').querySelectorAll('.shot-issue')) {
    const planned = state.shotPlans.get(task?.id)?.find(chunk => chunk.shotId === issue.dataset.shotId);
    const unresolved = planned?.dialogueIssue && !Object.hasOwn(draft?.edits.shots[issue.dataset.shotId] || {}, 'dialogue');
    issue.hidden = !unresolved; issue.textContent = unresolved ? `${planned.dialogueIssue} 请在此镜头填写台词，或明确清空台词。` : '';
  }
}
async function refreshShotPlan() {
  if (!state.task || !hasAnalysis() || state.busy.has('shot-plan')) return;
  const id = state.task.id, version = getDraft().version;
  state.busy.add('shot-plan'); $('shot-plan-message').textContent = '正在按时间关联镜头台词…';
  try {
    await saveDraft(id, true);
    const result = await api(`/api/tasks/${id}/plan`);
    if (state.task?.id !== id || getDraft().version !== version) return;
    state.shotPlans.set(id, result.chunks || []);
    $('shot-plan-message').textContent = '镜头台词已按原声时间关联；修改逐句台词后会更新。';
    renderShotEditors(); renderControls();
  } catch (error) { if (state.task?.id === id) $('shot-plan-message').textContent = safeMessage(error); }
  finally {
    state.busy.delete('shot-plan');
    const draft = state.drafts.get(id);
    if (state.task?.id === id && draft?.version !== version && draft?.version === draft?.savedVersion) refreshShotPlan();
  }
}
function renderAssets() {
  const images = state.task?.images || [];
  $('image-count').textContent = `${images.length} 张`;
  const key = `${state.task?.id || ''}:${JSON.stringify(images)}`;
  if (key === state.assetsKey) return;
  state.assetsKey = key; $('asset-list').replaceChildren();
  for (const asset of images) {
    const card = node('div', 'asset-card'); const image = node('img'); image.src = asset.url; image.alt = `${asset.role === 'person' ? '替换人物' : '替换产品'}：${asset.name}`; image.loading = 'lazy';
    const remove = node('button', 'remove-asset', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `移除图片 ${asset.name}`);
    remove.addEventListener('click', () => action('asset', async () => {
      const id = state.task.id; await saveDraft(id, true);
      const { task } = await api(`/api/tasks/${id}/assets/${asset.id}`, { method: 'DELETE' });
      const draft = state.drafts.get(id);
      for (const shot of Object.values(draft.edits.shots)) if (shot.imageIds) shot.imageIds = shot.imageIds.filter(imageId => imageId !== asset.id);
      draft.version++; persistDraft(draft); invalidatePlan(); mergeTask(task); await saveDraft(id, true);
    }));
    const meta = node('div', 'asset-meta'); meta.append(node('strong', '', asset.role === 'person' ? '人物参考' : '产品参考'), node('span', '', asset.name)); card.append(image, remove, meta); $('asset-list').append(card);
  }
}
function renderGenerationSummary() {
  const draft = getDraft();
  $('generation-duration').textContent = state.task?.meta ? `${duration().toFixed(1)} 秒` : '—';
  const selected = (state.task?.analysis?.shots || []).flatMap(shot => draft?.edits.shots[shot.id]?.imageIds || []);
  $('generation-images').textContent = `${new Set(selected).size} 张已分配`;
  const changedLines = Object.values(draft?.edits.replacements || {}).filter((value) => value.trim()).length;
  const changedShots = Object.values(draft?.edits.shots || {}).filter(value => value.dialogue?.trim()).length;
  $('generation-edits').textContent = draft?.edits.fullText.trim() ? '整段替换' : changedShots ? `${changedShots} 镜头${changedLines ? ` / ${changedLines} 句` : ''}` : changedLines ? `${changedLines} 句` : '保持原文';
}
function renderGeneration() {
  renderGenerationSummary();
  const runs = state.task?.runs || [], lastRun = runs.at(-1);
  const label = lastRun?.status || 'pending';
  const makingVideo = ['generating', 'aligning', 'subtitling'].includes(state.task?.status);
  $('generation-badge').textContent = label === 'succeeded' ? '生成完成' : makingVideo ? statusLabels[state.task.status] : lastRun ? (statusLabels[state.task?.status] || '等待恢复') : '待生成';
  $('generation-badge').className = `pill ${label === 'succeeded' ? 'success' : makingVideo ? 'busy' : state.task?.status === 'failed' ? 'failed' : ''}`;
  visible('output-processing', Boolean(lastRun && !legacyRun(lastRun)));
  const stage = { shots: '正在生成镜头', assembly: '正在合成镜头', alignment: '正在识别成片语音与对齐时间', captions: '正在本机合成字幕', complete: '成片已完成' }[lastRun?.stage];
  $('output-processing').textContent = label === 'succeeded' ? '成片已生成。下方字幕与时间文件来自生成视频的实际语音。' : makingVideo ? [stage, state.task?.message].filter(Boolean).join(' · ') || '镜头生成后将识别实际语音，并在本机合成字幕。' : '制作顺序：镜头生成 → 成片语音识别 → 本机字幕合成。';
  $('output-warning').textContent = lastRun?.warning ? `成片台词核对：${lastRun.warning}` : '';
  visible('output-warning', Boolean(lastRun?.warning));
  visible('run-progress', Boolean(lastRun));
  const chunks = lastRun?.chunks || [];
  $('run-progress-summary').textContent = `${chunks.filter((chunk) => chunk.status === 'succeeded').length} / ${chunks.length} 镜头完成`;
  const runKey = JSON.stringify(chunks.map((chunk) => [chunk.index, chunk.startMs, chunk.endMs, chunk.status, chunk.submitId])) + (lastRun?.id || '');
  if (runKey !== state.runKey) {
    state.runKey = runKey; $('chunk-list').replaceChildren();
    for (const chunk of chunks) {
      const row = node('li', 'chunk-item');
      row.append(node('span', `status-dot ${chunk.status === 'succeeded' ? 'ready' : ['failed', 'interrupted'].includes(chunk.status) ? 'error' : ['pending', 'created'].includes(chunk.status) ? '' : 'busy'}`), node('span', '', `${legacyRun(lastRun) ? '旧片段' : '镜头'} ${chunk.index + 1}`), node('span', 'chunk-time', `${time(chunk.startMs)} – ${time(chunk.endMs)}`), node('span', 'chunk-state', chunkLabels[chunk.status] || '处理中'));
      $('chunk-list').append(row);
    }
  }
  const successes = runs.filter((run) => run.status === 'succeeded' && run.resultUrl), result = successes.at(-1);
  visible('result-section', Boolean(result));
  setVideo('result-video', result?.resultUrl || null);
  if (result) { $('result-download').href = result.resultUrl; $('result-heading').textContent = result.id === lastRun?.id ? '生成作品' : '上一版作品'; }
  visible('result-timing', Boolean(result?.srtUrl || result?.transcriptUrl));
  visible('result-srt', Boolean(result?.srtUrl)); visible('result-transcript', Boolean(result?.transcriptUrl));
  if (result?.srtUrl) $('result-srt').href = result.srtUrl; else $('result-srt').removeAttribute('href');
  if (result?.transcriptUrl) $('result-transcript').href = result.transcriptUrl; else $('result-transcript').removeAttribute('href');
  const resultsKey = successes.map((run) => run.id).join(':');
  if ($('previous-results').dataset.key !== resultsKey) {
    $('previous-results').dataset.key = resultsKey; $('previous-results').replaceChildren();
    successes.slice(0, -1).forEach((run, index) => { const link = node('a', '', `下载版本 ${index + 1}`); link.href = run.resultUrl; link.download = ''; $('previous-results').append(link); });
  }
}
async function loadPlan() {
  if (!state.task || !(hasAnalysis() || state.task.runs?.length)) return;
  return action('plan', async () => {
    const id = state.task.id;
    await saveDraft(id, true);
    $('plan-content').textContent = '正在整理制作计划…';
    const lastRun = state.task.runs?.at(-1);
    const frozen = lastRun && (!hasAnalysis() || !['succeeded', 'failed'].includes(lastRun.status));
    const chunks = frozen ? lastRun.chunks.map((chunk) => ({ ...chunk, duration: Math.ceil((chunk.endMs - chunk.startMs) / 1000) })) : (await api(`/api/tasks/${id}/plan`)).chunks;
    if (state.task?.id !== id) return;
    $('plan-content').replaceChildren();
    if (frozen) $('plan-content').append(node('p', 'field-hint', legacyRun(lastRun) ? '旧视频参考方案的冻结计划，仅供核对历史，不会按此计划重新提交。' : '以下是原任务提交时保存的制作计划，继续任务使用这些分镜。'));
    else $('plan-content').append(node('p', 'field-hint', '每镜头仅发送下列文字与用户替换图片，原视频输入数量为 0。'));
    for (const chunk of chunks) {
      const block = node('section', 'plan-chunk'); block.append(node('h4', '', `镜头 ${chunk.index + 1} · ${time(chunk.startMs)} – ${time(chunk.endMs)} · 生成 ${chunk.duration} 秒`));
      if (Array.isArray(chunk.imageIds)) block.append(node('p', 'field-hint', chunk.images?.length ? `本镜头图片：${chunk.images.map((image, index) => `图片${index + 1} · ${image.role === 'person' ? '人物' : '产品'} · ${image.name}`).join('；')}` : '本镜头不使用替换图片。'));
      block.append(node('pre', '', chunk.prompt)); $('plan-content').append(block);
    }
    if (!chunks.length) $('plan-content').textContent = '暂时没有可生成的片段。';
    state.planKey = id;
  });
}
async function readImage(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请上传 PNG、JPG 或 WebP 图片。');
  if (file.size > 10 * 1024 * 1024) throw new Error('单张图片不能超过 10 MB，请压缩后重试。');
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败，请重新选择。')); reader.readAsDataURL(file); });
}

function renderConfig() {
  const ready = speechReady();
  $('config-dot').className = `status-dot ${ready ? 'ready' : ''}`; $('config-label').textContent = ready ? '服务已配置' : '配置服务';
  $('speech-key-state').textContent = state.config.speechApiKeyConfigured ? '已配置' : '';
  $('speech-token-state').textContent = state.config.speechAccessTokenConfigured ? '已配置' : '';
  $('environment-status').replaceChildren();
  for (const [key, label] of [['codex', 'Codex'], ['jimeng', '即梦'], ['ffmpeg', 'FFmpeg'], ['ffprobe', 'FFprobe']]) {
    const ready = state.environment[key]?.ready;
    const chip = node('span', `environment-chip ${ready ? 'ready' : 'missing'}`, `${label} · ${ready ? '已检测到' : '未找到'}`);
    $('environment-status').append(chip);
  }
  renderControls();
}
function openSettings() {
  $('settings-form').reset(); visible('settings-error', false); $('settings-save-state').textContent = '';
  $('speech-key').placeholder = state.config.speechApiKeyConfigured ? '已配置，留空保留当前 Key' : '填写豆包语音控制台的 API Key';
  $('speech-access-token').placeholder = state.config.speechAccessTokenConfigured ? '已配置，留空保留当前 Token' : '填写旧版 Access Token';
  for (const [id, key] of [['speech-app-id', 'speechAppId'], ['codex-binary', 'codexBinary'], ['jimeng-binary', 'jimengBinary'], ['ffmpeg-binary', 'ffmpegBinary'], ['ffprobe-binary', 'ffprobeBinary'], ['browser-executable', 'browserExecutable']]) $(id).value = state.config[key] || '';
  renderConfig(); $('settings-dialog').showModal();
}

$('new-task').addEventListener('click', () => {
  if (state.task) saveDraft(state.task.id, true).catch(() => {});
  state.task = null; state.step = 1; state.transcriptKey = ''; state.assetsKey = ''; state.runKey = ''; state.planKey = '';
  try { localStorage.removeItem('replication-selected-task'); } catch {}
  $('source-input').value = ''; renderTask(true); renderHistory(); $('source-input').focus();
});
document.querySelectorAll('[data-step]').forEach((button) => button.addEventListener('click', () => setStep(Number(button.dataset.step))));
$('continue-transcript').addEventListener('click', () => setStep(2));
$('retry-acquire').addEventListener('click', () => action('acquire', async () => { const { task } = await api(`/api/tasks/${state.task.id}/acquire`, { method: 'POST', body: {} }); mergeTask(task); }));
$('continue-edits').addEventListener('click', () => setStep(3));
$('open-settings').addEventListener('click', openSettings); $('speech-settings').addEventListener('click', openSettings); $('analysis-settings').addEventListener('click', openSettings);
$('close-settings').addEventListener('click', () => $('settings-dialog').close());
$('settings-dialog').addEventListener('close', () => { $('speech-key').value = ''; $('speech-access-token').value = ''; });
$('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  action('config', async () => {
    visible('settings-error', false); $('save-settings').disabled = true; $('save-settings').textContent = '正在保存…';
    try {
      const body = Object.fromEntries(new FormData($('settings-form')));
      const result = await api('/api/config', { method: 'POST', body }); state.config = result.config; state.environment = result.environment;
      $('speech-key').value = ''; $('speech-access-token').value = ''; renderConfig(); $('settings-dialog').close(); toast('配置已保存。');
    } catch (error) { $('settings-error').textContent = safeMessage(error); visible('settings-error', true); }
    finally { $('save-settings').disabled = false; $('save-settings').textContent = '保存配置'; }
  });
});
$('import-form').addEventListener('submit', (event) => {
  event.preventDefault(); const input = $('source-input').value.trim(); if (!input) return;
  action('import', async () => {
    const { task } = await api('/api/tasks', { method: 'POST', body: { input } });
    state.task = task; state.step = 1; state.transcriptKey = ''; state.assetsKey = ''; state.runKey = ''; state.planKey = '';
    getDraft(task); try { localStorage.setItem('replication-selected-task', task.id); } catch {}
    mergeTask(task); renderTask(true);
  });
});
$('transcribe-button').addEventListener('click', () => action('transcribe', async () => {
  if (!state.task) return; const { task } = await api(`/api/tasks/${state.task.id}/transcribe`, { method: 'POST', body: {} }); mergeTask(task);
}));
$('analyze-button').addEventListener('click', () => action('analyze', async () => {
  if (!state.task || !hasTranscript()) return;
  const { task } = await api(`/api/tasks/${state.task.id}/analyze`, { method: 'POST', body: {} }); mergeTask(task);
}));
$('full-text').addEventListener('input', () => changeEdit('fullText', $('full-text').value));
$('direction').addEventListener('input', () => changeEdit('direction', $('direction').value));
$('save-edits').addEventListener('click', () => action('save', async () => { await saveDraft(state.task.id, true); toast('修改已保存。'); }));
$('continue-generation').addEventListener('click', () => action('save', async () => { await saveDraft(state.task.id, true); setStep(4); }));
$('upload-button').addEventListener('click', () => $('asset-input').click());
$('asset-input').addEventListener('change', () => action('upload', async () => {
  const files = [...$('asset-input').files]; $('asset-input').value = ''; if (!files.length || !state.task) return;
  const id = state.task.id, role = $('asset-role').value;
  for (const file of files) {
    const dataUrl = await readImage(file); const { task } = await api(`/api/tasks/${id}/assets`, { method: 'POST', body: { name: file.name, role, dataUrl } }); mergeTask(task);
  }
  invalidatePlan(); toast('图片已保存，请在各镜头中勾选要使用的人物或产品。');
}));
$('plan-details').addEventListener('toggle', () => { if ($('plan-details').open && state.planKey !== state.task?.id) loadPlan(); });
$('refresh-plan').addEventListener('click', loadPlan);
$('generate-button').addEventListener('click', () => action('generate', async () => {
  if (!state.task) return;
  const id = state.task.id; await saveDraft(id, true);
  const newRun = ['succeeded', 'failed'].includes(state.task.runs?.at(-1)?.status);
  const { task } = await api(`/api/tasks/${id}/generate`, { method: 'POST', body: { newRun } }); mergeTask(task); setStep(4);
}));
window.addEventListener('beforeunload', () => { for (const draft of state.drafts.values()) if (draft.version !== draft.savedVersion) persistDraft(draft); });

async function poll() {
  if (state.polling || !state.token || document.hidden) return;
  state.polling = true;
  try {
    if (state.task) { const id = state.task.id; const { task } = await api(`/api/tasks/${id}`); mergeTask(task); }
    if (++pollCount % 5 === 0) { const { tasks } = await api('/api/tasks'); state.tasks = tasks; renderHistory(); }
    visible('connection-message', false);
  } catch { $('connection-message').textContent = '与本机服务的连接暂时中断，正在重新连接。当前草稿仍保留在页面中。'; visible('connection-message', true); }
  finally { state.polling = false; }
}
async function start() {
  renderTask();
  try {
    const result = await api('/api/bootstrap'); state.token = result.token; state.config = result.config; state.environment = result.environment; state.tasks = result.tasks || [];
    renderConfig(); renderHistory();
    let selected; try { selected = localStorage.getItem('replication-selected-task'); } catch {}
    if (selected && state.tasks.some((task) => task.id === selected)) await selectTask(selected);
  } catch (error) { $('connection-message').textContent = safeMessage(error); visible('connection-message', true); $('task-list').replaceChildren(node('p', 'muted sidebar-empty', '暂时无法读取任务。')); }
  setInterval(poll, 2000);
}
start();
