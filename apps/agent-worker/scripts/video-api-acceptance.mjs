import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ArkVideoClient } from '../src/cloud-generation/ark-video.ts';
import { arkVideoBody } from '../../cloud/supabase/functions/_shared/video-contract.ts';

const BASE = 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks';
const hash = value => createHash('sha256').update(value).digest('hex');
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,200}$/.test(value) ? value : undefined;
const safeNumber = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const json = value => JSON.stringify(value, null, 2) + '\n';
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function writeDurable(file, value, flag = 'w') {
  const handle = await fs.open(file, flag);
  try { await handle.writeFile(json(value)); await handle.sync(); } finally { await handle.close(); }
}
async function save(file, value) {
  const temp = file + '.next';
  await writeDurable(temp, value);
  await fs.rename(temp, file);
}

/** Offline preparation only. This deliberately uses a new case, not the unknown v1 request. */
export async function prepareCase(directory) {
  await fs.mkdir(directory, { recursive: true });
  const input = {
    schema_version: 1, media: 'video',
    prompt: '固定镜头，一只黄色纸船在浅蓝色静水上缓慢漂动，柔和均匀光线，无文字',
    ratio: '16:9', reference_images: [], reference_videos: [],
    video_options: { model_version: 'seedance2.5', kind: 'text2video', duration: 4, video_resolution: '480p', generate_audio: false },
  };
  const body = arkVideoBody(input);
  const manifest = {
    schema: 1, caseId: randomUUID(), preparedAt: new Date().toISOString(), input,
    requestSha256: hash(JSON.stringify(body)), method: 'POST', endpoint: BASE,
    cost: { cnyPerMillionTokens: 70, illustrativeTokens: 38430, illustrativeCny: 2.6901, finalBasis: 'provider completion_tokens; invoice remains unverified' },
    boundary: 'one POST per case directory; unknown outcome is never resubmitted; no provider idempotency guarantee',
  };
  await fs.writeFile(path.join(directory, 'case.json'), json(manifest), { flag: 'wx' });
  await fs.writeFile(path.join(directory, 'request.json'), json(body), { flag: 'wx' });
  return { caseId: manifest.caseId, requestSha256: manifest.requestSha256, prepared: true, networkRequests: 0 };
}

async function caseManifest(directory) {
  const manifest = await readJson(path.join(directory, 'case.json'));
  if (manifest.schema !== 1 || manifest.endpoint !== BASE || manifest.method !== 'POST'
      || !safeId(manifest.caseId) || manifest.requestSha256 !== hash(JSON.stringify(arkVideoBody(manifest.input)))
      || manifest.cost?.cnyPerMillionTokens !== 70) throw new Error('case_manifest_invalid');
  const preparedBody = await readJson(path.join(directory, 'request.json'));
  if (hash(JSON.stringify(preparedBody)) !== manifest.requestSha256) throw new Error('prepared_request_changed');
  return manifest;
}

/** Logs an allowlist only. Never logs Authorization, request/response bodies, URLs or error messages. */
function diagnosticFetch(directory, fetchImpl) {
  return async (url, init) => {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://ark.cn-beijing.volces.com'
        || !parsed.pathname.startsWith('/api/v3/contents/generations/tasks')
        || !['GET', 'POST'].includes(init.method)) throw new Error('unexpected_endpoint');
    const started = Date.now();
    const event = { at: new Date().toISOString(), method: init.method, operation: parsed.pathname === new URL(BASE).pathname ? (init.method === 'GET' ? 'list' : 'submit') : 'query' };
    const log = value => fs.appendFile(path.join(directory, 'diagnostics.jsonl'), JSON.stringify(value) + '\n');
    await log({ ...event, phase: 'before_request' });
    let response;
    try {
      response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(90_000) });
    } catch (error) {
      await log({ ...event, phase: 'transport_error', elapsedMs: Date.now() - started,
        errorName: safeId(error?.name), causeCode: safeId(error?.cause?.code) });
      throw new Error('transport_error_details_redacted');
    }
    await log({ ...event, phase: 'response_headers', elapsedMs: Date.now() - started,
      status: response.status, requestId: safeId(response.headers?.get('x-request-id') ?? response.headers?.get('x-tt-logid')) });
    return {
      ok: response.ok, status: response.status,
      text: async () => {
        let text;
        try {
          // Native HTTP bodies are bounded during reading, not after an unbounded allocation.
          if (response.body?.getReader) {
            const reader = response.body.getReader(); const chunks = []; let size = 0;
            try {
              while (true) {
                const part = await reader.read(); if (part.done) break;
                size += part.value.length;
                if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('response_size_limit'); }
                chunks.push(Buffer.from(part.value));
              }
            } finally { reader.releaseLock(); }
            text = Buffer.concat(chunks).toString('utf8');
          } else { text = await response.text(); if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('response_size_limit'); }
          let value; try { value = JSON.parse(text); } catch { /* adapter classifies malformed response */ }
          await log({ ...event, phase: 'response_body', elapsedMs: Date.now() - started,
            status: response.status, errorCode: safeId(value?.error?.code), returnedTaskId: safeId(value?.id) });
          return text;
        } catch {
          await log({ ...event, phase: 'body_read_error', elapsedMs: Date.now() - started, status: response.status });
          throw new Error('body_read_error_details_redacted');
        }
      },
    };
  };
}

export async function submitCase(directory, apiKey, fetchImpl = fetch) {
  const manifest = await caseManifest(directory);
  if (!apiKey?.trim()) throw new Error('ARK_API_KEY_missing');
  const file = path.join(directory, 'submission.json');
  const initial = { caseId: manifest.caseId, requestSha256: manifest.requestSha256, postCount: 1, status: 'submitting', startedAt: new Date().toISOString() };
  // Durable no-retry guard is created before the adapter can touch the network.
  await writeDurable(file, initial, 'wx');
  const client = new ArkVideoClient(apiKey, diagnosticFetch(directory, fetchImpl));
  try {
    const taskId = await client.submit(manifest.input);
    const result = { ...initial, status: 'submitted', taskId, submittedAt: new Date().toISOString() };
    await save(file, result);
    return result;
  } catch (error) {
    const result = { ...initial, status: error?.definitive ? 'rejected' : 'outcome_unknown', code: safeId(error?.code) ?? 'local_or_transport_error' };
    await save(file, result);
    return result;
  }
}

export async function queryCase(directory, apiKey, fetchImpl = fetch) {
  const manifest = await caseManifest(directory);
  const submitted = await readJson(path.join(directory, 'submission.json'));
  if (submitted.caseId !== manifest.caseId || submitted.requestSha256 !== manifest.requestSha256 || !safeId(submitted.taskId)) throw new Error('no_confirmed_task_id_do_not_resubmit');
  const client = new ArkVideoClient(apiKey ?? '', diagnosticFetch(directory, fetchImpl));
  const task = await client.query(submitted.taskId);
  const result = { caseId: manifest.caseId, taskId: task.id, status: task.status, model: safeId(task.model),
    checkedAt: new Date().toISOString(), completionTokens: task.completionTokens,
    computedProviderCny: task.completionTokens === undefined ? undefined : task.completionTokens * manifest.cost.cnyPerMillionTokens / 1_000_000,
    invoiceVerified: false, errorCode: task.errorCode, artifactUrlReturned: !!task.videoUrl };
  await save(path.join(directory, 'result.json'), result);
  return result;
}

/** One page of official 7-day task list; no auto-matching or updates to the unknown submission. */
export async function listTaskPage(directory, page, apiKey, fetchImpl = fetch) {
  if (!Number.isInteger(page) || page < 1 || page > 500) throw new Error('page_out_of_range');
  if (!apiKey?.trim()) throw new Error('ARK_API_KEY_missing');
  await fs.mkdir(directory, { recursive: true });
  const url = new URL(BASE); url.searchParams.set('page_num', String(page)); url.searchParams.set('page_size', '20');
  // filter.model is documented as an ep- endpoint ID; do not assume it accepts the model name.
  const response = await diagnosticFetch(directory, fetchImpl)(url.href, { method: 'GET', headers: { authorization: `Bearer ${apiKey}` } });
  const value = JSON.parse(await response.text());
  if (!response.ok || !Array.isArray(value.items)) throw new Error(`list_http_${response.status}`);
  const result = { queriedAt: new Date().toISOString(), page, pageSize: 20, total: safeNumber(value.total), correlation: 'unproven_no_automatic_match',
    items: value.items.map(item => ({ taskId: safeId(item.id), model: safeId(item.model), status: safeId(item.status),
      createdAt: safeNumber(item.created_at), duration: safeNumber(item.duration), resolution: safeId(item.resolution),
      ratio: typeof item.ratio === 'string' && /^(\d+:\d+|adaptive)$/.test(item.ratio) ? item.ratio : undefined,
      completionTokens: safeNumber(item.usage?.completion_tokens) })) };
  await save(path.join(directory, `list-page-${page}.json`), result);
  return result;
}

export async function inspectTask(directory, taskId, apiKey, fetchImpl = fetch) {
  if (!safeId(taskId)) throw new Error('task_id_invalid');
  await fs.mkdir(directory, { recursive: true });
  const task = await new ArkVideoClient(apiKey ?? '', diagnosticFetch(directory, fetchImpl)).query(taskId);
  const result = { taskId: task.id, model: safeId(task.model), status: task.status, completionTokens: task.completionTokens,
    checkedAt: new Date().toISOString(), correlation: 'unproven_requires_independent_provider_evidence', artifactUrlReturned: !!task.videoUrl, errorCode: task.errorCode };
  await save(path.join(directory, `task-${taskId}.json`), result);
  return result;
}

async function main() {
  const [operation, directory, pageOrExecute, execute] = process.argv.slice(2);
  if (!directory) throw new Error('usage: prepare DIR | submit DIR --execute | query DIR --execute | list DIR PAGE --execute | inspect DIR TASK_ID --execute');
  if (operation === 'prepare') return prepareCase(directory);
  if ((operation === 'list' || operation === 'inspect' ? execute : pageOrExecute) !== '--execute') throw new Error('explicit_execute_flag_required');
  // Caller supplies the existing environment. This script never loads or locates credential files.
  if (operation === 'submit') return submitCase(directory, process.env.ARK_API_KEY);
  if (operation === 'query') return queryCase(directory, process.env.ARK_API_KEY);
  if (operation === 'list') return listTaskPage(directory, Number(pageOrExecute), process.env.ARK_API_KEY);
  if (operation === 'inspect') return inspectTask(directory, pageOrExecute, process.env.ARK_API_KEY);
  throw new Error('unknown_operation');
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then(result => console.log(json(result))).catch(error => { console.error(safeId(error?.code) ?? safeId(error?.message) ?? 'operation_failed_details_redacted'); process.exitCode = 1; });
}
