import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Official API: https://docs.volcengine.com/docs/doubao-voice/large-model-recording-file-lite-recognition-api?lang=en
const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
const RESOURCE_ID = 'volc.bigasr.auc_turbo';
const MAX_AUDIO_BYTES = 100_000_000;

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function milliseconds(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function timedText(value) {
  let startMs = milliseconds(value?.start_time);
  let endMs = milliseconds(value?.end_time);
  if (startMs !== null && endMs !== null && endMs < startMs) {
    startMs = null;
    endMs = null;
  }
  return { text: typeof value?.text === 'string' ? value.text : '', startMs, endMs };
}

function identifier(value, secrets) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(value)) return null;
  return secrets.some((secret) => secret && value.includes(secret)) ? null : value;
}

/** Send a local audio file once; preserve only provider-supplied timing evidence. */
export async function transcribeAudio({ audioPath, config = {}, signal, onProgress, fetchImpl = globalThis.fetch }) {
  const apiKey = String(config.speechApiKey ?? '').trim();
  const appId = String(config.speechAppId ?? '').trim();
  const accessToken = String(config.speechAccessToken ?? '').trim();
  const resourceId = String(config.speechResourceId ?? RESOURCE_ID).trim() || RESOURCE_ID;
  if (!apiKey && !(appId && accessToken)) {
    throw failure('ASR_CONFIG_MISSING', '请先在 Demo 的 .env.local 中填写豆包语音 API Key；旧版控制台需同时填写 App ID 和 Access Token。');
  }
  if (resourceId !== RESOURCE_ID) {
    throw failure('ASR_RESOURCE_INVALID', '请将豆包语音资源 ID 设为 volc.bigasr.auc_turbo，并在控制台开通录音文件极速版。');
  }
  if (signal?.aborted) throw failure('ASR_CANCELLED', '已取消语音转写。');
  const format = extname(String(audioPath ?? '')).slice(1).toLowerCase();
  if (!['wav', 'mp3', 'ogg'].includes(format)) {
    throw failure('ASR_AUDIO_FORMAT', '请先将视频音轨提取为 WAV、MP3 或 OGG 音频再转写。');
  }
  let audio;
  try {
    const info = await stat(audioPath);
    if (!info.isFile() || info.size === 0) throw failure('ASR_AUDIO_EMPTY', '音频文件为空，请重新提取视频音轨。');
    if (info.size > MAX_AUDIO_BYTES) throw failure('ASR_AUDIO_TOO_LARGE', '音频超过豆包极速版的 100 MB 限制，请缩短或压缩音频后再试。');
    audio = await readFile(audioPath, { signal });
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('ASR_')) throw error;
    if (signal?.aborted) throw failure('ASR_CANCELLED', '已取消语音转写。');
    throw failure('ASR_AUDIO_READ', '无法读取待转写音频，请重新获取视频并提取音轨。');
  }

  const requestId = randomUUID();
  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': requestId,
    'X-Api-Sequence': '-1',
    ...(apiKey ? { 'X-Api-Key': apiKey } : { 'X-Api-App-Key': appId, 'X-Api-Access-Key': accessToken }),
  };
  const timeout = AbortSignal.timeout(180_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  let raw;
  let logId = null;
  let statusCode = null;
  onProgress?.('正在上传音频并获取豆包转写文本和时间戳…');
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers,
      redirect: 'error',
      signal: requestSignal,
      body: JSON.stringify({
        user: { uid: 'video-replication-demo' },
        audio: { data: audio.toString('base64'), format },
        request: {
          model_name: 'bigmodel',
          show_utterances: true,
          enable_itn: true,
          enable_punc: true,
          enable_ddc: false,
        },
      }),
    });
    logId = identifier(response.headers.get('x-tt-logid'), [apiKey, appId, accessToken]);
    const providerStatus = response.headers.get('x-api-status-code');
    statusCode = /^\d{8}$/.test(providerStatus ?? '') ? providerStatus : null;
    const details = { requestId, logId, statusCode, httpStatus: response.status };
    if (!response.ok || statusCode !== '20000000') {
      if (response.status === 401 || response.status === 403) {
        throw failure('ASR_AUTH', '豆包语音鉴权或服务权限校验未通过，请检查 API Key 及录音文件极速版的开通状态。', details);
      }
      if (response.status === 429) {
        throw failure('ASR_RATE_LIMIT', '豆包语音当前请求过多，请稍后再试。', details);
      }
      if (statusCode === '20000001' || statusCode === '20000002') {
        throw failure('ASR_RESULT_UNKNOWN', '豆包语音尚未返回完成结果，本次状态未确认；请保留请求编号，避免连续重复提交。', details);
      }
      throw failure('ASR_REJECTED', '豆包语音未返回有效转写结果，请检查服务权限、可用额度和音频格式；可通过请求编号排查。', details);
    }
    try {
      raw = await response.json();
    } catch (error) {
      if (requestSignal.aborted) throw error;
      throw failure('ASR_INVALID_RESPONSE', '豆包语音返回的结果无法读取，请保留请求编号排查，避免连续重复提交。', details);
    }
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('ASR_')) throw error;
    const details = { requestId, logId, statusCode };
    if (signal?.aborted) {
      throw failure('ASR_CANCELLED', '已停止等待语音转写，远端是否完成尚未确认。', details);
    }
    if (timeout.aborted || error?.name === 'TimeoutError') {
      throw failure('ASR_TIMEOUT', '等待豆包语音结果超时，本次状态未确认；请保留请求编号，避免连续重复提交。', details);
    }
    throw failure('ASR_NETWORK', '豆包语音连接中断，本次状态未确认；请检查网络并保留请求编号，避免连续重复提交。', details);
  }

  const result = raw?.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw failure('ASR_INVALID_RESPONSE', '豆包语音返回的结果缺少识别内容，请保留请求编号排查。', { requestId, logId, statusCode });
  }
  const utterances = (Array.isArray(result.utterances) ? result.utterances : []).map((item) => ({
    ...timedText(item),
    words: (Array.isArray(item?.words) ? item.words : []).map(timedText),
  }));
  const words = utterances.flatMap((utterance) => utterance.words);
  const text = typeof result.text === 'string' ? result.text : utterances.map((item) => item.text).join('');
  const hasWordTiming = words.some((word) => word.startMs !== null && word.endMs !== null);
  onProgress?.(hasWordTiming ? '豆包语音转写已完成，已取得词级时间信息。' : '豆包语音转写已完成；本次未返回有效词级时间信息。');
  return {
    text,
    utterances,
    words,
    durationMs: milliseconds(raw.audio_info?.duration) ?? milliseconds(result.additions?.duration),
    requestId,
    logId,
    raw,
  };
}
