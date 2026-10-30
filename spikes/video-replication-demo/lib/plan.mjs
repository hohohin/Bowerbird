export const WORKFLOW = 'storyboard-v2';
const speechContent = value => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const hasCompleteWords = utterance => {
  if (!Number.isFinite(utterance.startMs) || !Number.isFinite(utterance.endMs) || utterance.endMs <= utterance.startMs) return false;
  const words = (utterance.words || []).filter(word => Number.isFinite(word.startMs) && Number.isFinite(word.endMs) && word.endMs > word.startMs);
  return words.length > 0 && speechContent(words.map(word => word.text).join('')) === speechContent(utterance.text)
    && words.every((word, index) => word.startMs >= utterance.startMs && word.endMs <= utterance.endMs
      && (!index || word.startMs >= words[index - 1].startMs));
};

// Source timings organize the storyboard; they never claim output alignment.
export function createClipPlan(durationMs, transcript, edits = {}, analysis) {
  if (!Number.isFinite(durationMs) || durationMs < 4000 || durationMs > 120000) throw new Error('复刻源视频需要在 4–120 秒之间。');
  if (!analysis?.shots?.length) throw new Error('请先完成画面拆解，确认分镜后再生成。');
  const shots = analysis.shots;
  if (shots.length > 24 || new Set(shots.map(shot => shot.id)).size !== shots.length) throw new Error('分镜数量或编号不正确，请重新分析。');
  let previousEnd = 0;
  for (const shot of shots) {
    if (typeof shot.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(shot.id) || !Number.isFinite(shot.startMs) || !Number.isFinite(shot.endMs)
      || Math.abs(shot.startMs - previousEnd) > 1 || shot.endMs - shot.startMs < 4000 || shot.endMs - shot.startMs > 15000
      || typeof shot.visual !== 'string' || !shot.visual.trim()) throw new Error('分镜需连续覆盖原片，每段 4–15 秒，并包含画面描述。');
    previousEnd = shot.endMs;
  }
  if (Math.abs(previousEnd - durationMs) > 1) throw new Error('分镜没有完整覆盖原片，请重新分析。');
  if (edits.fullText?.trim() && shots.length !== 1) throw new Error('有多个分镜时，请逐句修改，或在各分镜中填写对应台词。');
  const chunks = shots.map((shot, index) => ({ ...shot, index, shotId: shot.id, style: analysis.style || '', duration: Math.ceil((shot.endMs - shot.startMs) / 1000), lines: [], dialogueIssue: '' }));
  const owner = time => chunks.findIndex(chunk => time >= chunk.startMs && time < chunk.endMs);
  for (const [index, item] of (transcript?.utterances || []).entries()) {
    if (!item.text?.trim()) continue;
    if (!Number.isFinite(item.startMs) || !Number.isFinite(item.endMs) || item.endMs <= item.startMs) {
      chunks.forEach(chunk => { chunk.dialogueIssue = '原台词缺少时间戳，请在每个分镜明确填写台词。'; }); continue;
    }
    const matches = chunks.filter(chunk => item.endMs > chunk.startMs && item.startMs < chunk.endMs);
    const replacement = edits.replacements?.[index]?.trim();
    if (matches.length === 1) {
      const chunk = matches[0];
      chunk.lines.push({ index, startMs: Math.max(0, item.startMs - chunk.startMs), endMs: Math.min(chunk.endMs, item.endMs) - chunk.startMs, original: item.text, text: replacement || item.text });
    } else if (matches.length > 1) {
      if (replacement || !hasCompleteWords(item)) {
        matches.forEach(chunk => { chunk.dialogueIssue = '这句台词跨过多个分镜，请在相关分镜分别填写台词，避免重复或漏词。'; }); continue;
      }
      const pieces = new Map(); let lastOwner = -1;
      for (const [wordIndex, word] of item.words.entries()) {
        let current = Number.isFinite(word.startMs) && Number.isFinite(word.endMs) ? owner((word.startMs + word.endMs) / 2) : lastOwner;
        if (current < 0) { const next = item.words.slice(wordIndex + 1).find(value => Number.isFinite(value.startMs)); if (next) current = owner(next.startMs); }
        if (current >= 0) { const part = pieces.get(current) || []; part.push(word); pieces.set(current, part); lastOwner = current; }
      }
      for (const [partIndex, words] of pieces) {
        const chunk = chunks[partIndex], timed = words.filter(word => Number.isFinite(word.startMs) && Number.isFinite(word.endMs));
        const text = words.map(word => word.text).join('').trim();
        if (text && timed.length) chunk.lines.push({ index, startMs: Math.max(0, timed[0].startMs - chunk.startMs), endMs: Math.min(chunk.endMs, timed.at(-1).endMs) - chunk.startMs, original: text, text });
      }
    }
  }
  if (transcript?.text?.trim() && !transcript.utterances?.length) chunks.forEach(chunk => { chunk.dialogueIssue = '原台词没有句子时间戳，请在分镜中明确填写台词。'; });
  for (const chunk of chunks) {
    const override = edits.shots?.[chunk.shotId] || {};
    chunk.imageIds = override.imageIds || [];
    for (const field of ['visual', 'camera', 'action']) if (override[field]?.trim()) chunk[field] = override[field].trim();
    const explicitDialogue = Object.hasOwn(override, 'dialogue');
    chunk.dialogue = edits.fullText?.trim() || (explicitDialogue ? override.dialogue.trim() : chunk.lines.map(line => line.text).join(''));
    if (explicitDialogue || edits.fullText?.trim()) chunk.dialogueIssue = '';
  }
  return chunks;
}

export function resolveShotImages(chunk, images) {
  const ids = chunk.imageIds || [];
  if (!Array.isArray(ids) || ids.length > 30 || new Set(ids).size !== ids.length) throw new Error(`镜头 ${chunk.index + 1} 最多选择 30 张不同图片。`);
  return ids.map(id => {
    const image = images.find(item => item.id === id);
    if (!image) throw new Error(`镜头 ${chunk.index + 1} 选择的图片已移除，请重新选择。`);
    return image;
  });
}

export function makeGenerationPrompt(chunk, edits, images) {
  const instructions = [
    `生成一个 ${chunk.duration} 秒的独立镜头素材。画面：${chunk.visual}`,
    `摄影与构图：${chunk.camera || '自然稳定构图'}。动作与镜头内变化：${chunk.action || '自然表演'}。`,
  ];
  if (chunk.style) instructions.push(`整体视觉风格：${chunk.style}`);
  images.forEach((image, index) => instructions.push(image.role === 'person'
    ? `图片${index + 1}是替换人物${image.name ? `（${image.name}）` : ''}，人物外观和身份以该图为准。画面描述中的人物特征只作动作与位置参考，不沿用原人物。`
    : `图片${index + 1}是替换产品${image.name ? `（${image.name}）` : ''}，产品形状、包装、颜色和可识别细节以该图为准。画面描述中的原产品名称与外观须替换。`));
  instructions.push(chunk.dialogue
    ? `本镜头口播如下，生成自然声音与对应表演，只说以下台词：\n${chunk.dialogue}`
    : '本镜头没有台词，不生成人声口播。');
  instructions.push('画面不要生成字幕、标题卡、额外标识或片头片尾。字幕由后期独立合成。镜头之间采用直接切换，不生成黑场过渡。');
  if (edits.direction?.trim()) instructions.push(`补充要求：${edits.direction.trim()}`);
  return instructions.join('\n\n');
}

export function transcriptToSrt(transcript) {
  const time = ms => {
    const value = Math.max(0, Math.round(ms));
    return `${String(Math.floor(value / 3600000)).padStart(2, '0')}:${String(Math.floor(value / 60000) % 60).padStart(2, '0')}:${String(Math.floor(value / 1000) % 60).padStart(2, '0')},${String(value % 1000).padStart(3, '0')}`;
  };
  return (transcript?.utterances || []).filter(item => Number.isFinite(item.startMs) && Number.isFinite(item.endMs) && item.endMs > item.startMs)
    .map((item, index) => `${index + 1}\n${time(item.startMs)} --> ${time(item.endMs)}\n${item.text.replace(/[{}<>\\]/g, '').replace(/\r?\n/g, ' ')}\n`).join('\n');
}

// Caption intervals come from the new performance, not reused source timecodes.
export function captionsFromTranscript(transcript) {
  const utterances = [];
  for (const utterance of transcript.utterances || []) {
    const words = utterance.words || [], valid = words.filter(word => word.text?.trim() && Number.isFinite(word.startMs) && Number.isFinite(word.endMs) && word.endMs > word.startMs);
    if (!valid.length || !hasCompleteWords(utterance)) { if (Number.isFinite(utterance.startMs) && Number.isFinite(utterance.endMs)) utterances.push(utterance); continue; }
    let group = [], text = '';
    const flush = () => { if (group.length) utterances.push({ text: text.trim(), startMs: group[0].startMs, endMs: group.at(-1).endMs }); group = []; text = ''; };
    for (const word of words) {
      if (!word.text?.trim()) { if (group.length) text += word.text || ''; continue; }
      if (!Number.isFinite(word.startMs) || !Number.isFinite(word.endMs) || word.endMs <= word.startMs) { text += word.text; continue; }
      const limit = /[\u3400-\u9fff]/.test(text + word.text) ? 20 : 48;
      if (group.length && (text.length + word.text.length > limit || word.endMs - group[0].startMs > 3500)) flush();
      group.push(word); text += word.text;
    }
    flush();
  }
  return { utterances };
}

export function dialogueWarning(expected, actual) {
  const wanted = speechContent(expected), observed = speechContent(actual);
  if (!wanted) return null;
  if (!observed) return '生成视频中没有识别到预期台词，请试听后决定是否重新生成。';
  const previous = new Uint16Array(observed.length + 1);
  for (const character of wanted) {
    let diagonal = 0;
    for (let j = 1; j <= observed.length; j++) { const old = previous[j]; previous[j] = character === observed[j - 1] ? diagonal + 1 : Math.max(previous[j], previous[j - 1]); diagonal = old; }
  }
  return 2 * previous[observed.length] / (wanted.length + observed.length) < 0.8 ? '实际识别台词与计划存在差异。字幕依据实际语音生成，请试听确认；Demo 没有自动重投视频。' : null;
}
