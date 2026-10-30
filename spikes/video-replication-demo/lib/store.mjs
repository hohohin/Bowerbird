import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function taskDirectory(dataDir, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('任务编号不正确。');
  return join(dataDir, 'tasks', id);
}
export async function writeTask(dataDir, task) {
  task.updatedAt = new Date().toISOString();
  const dir = taskDirectory(dataDir, task.id); await mkdir(dir, { recursive: true });
  const file = join(dir, 'task.json');
  await writeFile(`${file}.tmp`, JSON.stringify(task, null, 2), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}
export async function readTask(dataDir, id) { return JSON.parse(await readFile(join(taskDirectory(dataDir, id), 'task.json'), 'utf8')); }
export async function listTasks(dataDir) {
  let entries;
  try { entries = await readdir(join(dataDir, 'tasks'), { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const tasks = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
    try { tasks.push(await readTask(dataDir, entry.name)); } catch { /* A damaged task does not hide other saved work. */ }
  }
  return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function createTask(dataDir, input, title = '新的复刻') {
  const task = { id: randomUUID(), title, input, status: 'created', message: '准备获取视频', createdAt: new Date().toISOString(), edits: { fullText: '', direction: '', replacements: {}, shots: {} }, images: [], runs: [] };
  await writeTask(dataDir, task); return task;
}
export function publicTask(task) {
  const media = name => `/media/${task.id}/${name}`;
  return {
    id: task.id, title: task.title, input: task.input, status: task.status, message: task.message,
    error: task.error, updatedAt: task.updatedAt, meta: task.meta, edits: task.edits,
    sourceUrl: task.meta ? media('source.mp4') : null, posterUrl: task.meta ? media('source.jpg') : null,
    transcript: task.transcript ? { ...task.transcript, raw: undefined } : null,
    analysis: task.analysis ? { summary: task.analysis.summary, style: task.analysis.style, shots: task.analysis.shots, provider: task.analysis.provider,
      frames: (task.analysis.frames || []).map(frame => ({ timeMs: frame.timeMs, url: media(`analysis/${frame.file}`) })) } : null,
    transcriptUrl: task.transcript ? media('transcript.json') : null, srtUrl: task.transcript ? media('source.srt') : null,
    images: task.images.map(item => ({ id: item.id, name: item.name, role: item.role, url: media(`assets/${item.file}`) })),
    runs: task.runs.map(run => ({ id: run.id, status: run.status, workflow: run.workflow || 'video-reference-v1', inputVideoCount: run.inputVideoCount,
      stage: run.stage, warning: run.warning, createdAt: run.createdAt, completedAt: run.completedAt,
      chunks: run.chunks.map(chunk => ({ index: chunk.index, shotId: chunk.shotId, startMs: chunk.startMs, endMs: chunk.endMs, duration: chunk.duration,
        visual: chunk.visual, camera: chunk.camera, action: chunk.action, dialogue: chunk.dialogue, imageIds: chunk.imageIds, images: chunk.images, status: chunk.status, submitId: chunk.submitId || null, prompt: chunk.prompt })),
      srtUrl: run.captionsReady ? media(`runs/${run.id}/captions.srt`) : null,
      transcriptUrl: run.transcript ? media(`runs/${run.id}/transcript.json`) : null,
      resultUrl: run.status === 'succeeded' ? media(`runs/${run.id}/result.mp4`) : null, resultMeta: run.resultMeta,
    })),
  };
}
