import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ASSET_FILES = new Map(Array.from({ length: 8 }, (_, index) => [`p${index + 1}`, `p${index + 1}.jpg`]));
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".webp", "image/webp"],
]);
const PROVIDERS = {
  seedream: { label: "Seedream 5.0 Lite", model: () => process.env.VOLCENGINE_SEEDREAM_MODEL || "" },
  flux: { label: "FLUX.2 Klein 9B", model: () => process.env.BFL_FLUX_ENDPOINT || "flux-2-klein-9b" },
};
const rateBuckets = new Map();

await loadLocalEnv(join(SCRIPT_DIR, ".env.local"));

function parseArgs(argv) {
  const values = {
    root: SCRIPT_DIR,
    host: process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1"),
    port: Number(process.env.PORT || 4173),
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root") values.root = resolve(SCRIPT_DIR, argv[index + 1]);
    if (argv[index] === "--host") values.host = argv[index + 1];
    if (argv[index] === "--port") values.port = Number(argv[index + 1]);
  }
  if (!Number.isInteger(values.port) || values.port < 1 || values.port > 65535) throw new Error("Invalid port");
  return values;
}

async function loadLocalEnv(path) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || line.trimStart().startsWith("#") || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function providerConfigured(provider) {
  if (provider === "seedream") return Boolean(process.env.VOLCENGINE_ARK_API_KEY && process.env.VOLCENGINE_SEEDREAM_MODEL);
  if (provider === "flux") return Boolean(process.env.BFL_API_KEY);
  return false;
}

function resolveProvider() {
  const requested = (process.env.BOWERBIRD_IMAGE_PROVIDER || "auto").toLowerCase();
  if (requested !== "auto" && !PROVIDERS[requested]) throw httpError(500, "BOWERBIRD_IMAGE_PROVIDER 配置无效");
  if (requested !== "auto") return requested;

  const primary = (process.env.BOWERBIRD_IMAGE_REGION || "cn").toLowerCase() === "cn" ? "seedream" : "flux";
  const fallback = primary === "seedream" ? "flux" : "seedream";
  return providerConfigured(primary) || !providerConfigured(fallback) ? primary : fallback;
}

function publicConfig() {
  const provider = resolveProvider();
  const trial = trialSettings();
  return {
    provider,
    label: PROVIDERS[provider].label,
    model: PROVIDERS[provider].model(),
    configured: providerConfigured(provider),
    maxReferences: 8,
    trialLimit: trial.perIpLimit,
    globalDailyLimit: trial.globalDailyLimit,
    trialDay: currentTrialDay(trial.timeZone),
  };
}

function jsonResponse(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function readJsonBody(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw httpError(413, "请求内容过大");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "请求 JSON 无效");
  }
}

function validateGenerationInput(input) {
  const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw httpError(400, "Prompt 不能为空");
  if (prompt.length > 8000) throw httpError(400, "Prompt 不能超过 8000 个字符");
  if (!Array.isArray(input.referenceIds)) throw httpError(400, "referenceIds 必须是数组");
  const referenceIds = [...new Set(input.referenceIds)];
  if (referenceIds.length > 8) throw httpError(400, "最多支持 8 张参考图");
  if (referenceIds.some((id) => typeof id !== "string" || !ASSET_FILES.has(id))) {
    throw httpError(400, "包含未知参考图");
  }
  return { prompt, referenceIds };
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function trialSettings() {
  return {
    perIpLimit: Math.floor(positiveNumber(process.env.BOWERBIRD_GENERATION_LIMIT, 3)),
    globalDailyLimit: Math.floor(positiveNumber(process.env.BOWERBIRD_GLOBAL_DAILY_LIMIT, 100)),
    timeZone: process.env.BOWERBIRD_TRIAL_TIME_ZONE || "Asia/Shanghai",
  };
}

function currentTrialDay(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  }
}

function clientAddress(request) {
  if (process.env.BOWERBIRD_TRUST_PROXY === "1") {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  }
  return request.socket.remoteAddress || "local";
}

function reserveRateSlot(key, limit) {
  const used = Number(rateBuckets.get(key) || 0);
  if (used >= limit) return null;
  rateBuckets.set(key, used + 1);
  return used + 1;
}

function enforceRateLimit(request) {
  const { perIpLimit, globalDailyLimit, timeZone } = trialSettings();
  const day = currentTrialDay(timeZone);
  const ipKey = `ip:${day}:${clientAddress(request)}`;
  const globalKey = `global:${day}`;

  for (const key of rateBuckets.keys()) {
    if (key !== globalKey && !key.startsWith(`ip:${day}:`)) rateBuckets.delete(key);
  }

  const ipUsed = reserveRateSlot(ipKey, perIpLimit);
  if (ipUsed === null) throw httpError(429, `每位访客每日仅可体验 ${perIpLimit} 次`);

  if (reserveRateSlot(globalKey, globalDailyLimit) === null) {
    if (ipUsed === 1) rateBuckets.delete(ipKey);
    else rateBuckets.set(ipKey, ipUsed - 1);
    throw httpError(429, "今日试用名额已用完，请明天再来");
  }
  return { limit: perIpLimit, remaining: perIpLimit - ipUsed, day };
}

async function referenceDataUris(referenceIds) {
  return Promise.all(
    referenceIds.map(async (id) => {
      const bytes = await readFile(join(SCRIPT_DIR, "assets", "presets", ASSET_FILES.get(id)));
      return `data:image/jpeg;base64,${bytes.toString("base64")}`;
    }),
  );
}

async function fetchJson(url, options, timeoutMs = 120000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || `上游服务返回 ${response.status}`;
    throw httpError(response.status >= 500 ? 502 : 400, detail);
  }
  return payload;
}

async function imageUrlToDataUri(url) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw httpError(502, "上游返回的图片地址无效");
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw httpError(502, "无法下载上游生成图片");
  const contentType = response.headers.get("content-type")?.split(";")[0] || "image/png";
  if (!contentType.startsWith("image/")) throw httpError(502, "上游结果不是图片");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 20 * 1024 * 1024) throw httpError(502, "上游生成图片超过 20 MB");
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

async function generateWithSeedream(prompt, references) {
  const payload = await fetchJson("https://ark.cn-beijing.volces.com/api/v3/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.VOLCENGINE_ARK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.VOLCENGINE_SEEDREAM_MODEL,
      prompt,
      ...(references.length ? { image: references } : {}),
      size: process.env.VOLCENGINE_SEEDREAM_SIZE || "2K",
      sequential_image_generation: "disabled",
      response_format: "b64_json",
      watermark: false,
    }),
  });
  const result = payload?.data?.[0];
  if (result?.b64_json) return `data:image/png;base64,${result.b64_json}`;
  if (result?.url) return imageUrlToDataUri(result.url);
  throw httpError(502, "Seedream 未返回图片");
}

async function generateWithFlux(prompt, references) {
  const endpoint = process.env.BFL_FLUX_ENDPOINT || "flux-2-klein-9b";
  if (!/^[a-z0-9-]+$/.test(endpoint)) throw httpError(500, "BFL_FLUX_ENDPOINT 配置无效");
  const inputImages = Object.fromEntries(references.map((image, index) => [`input_image${index ? `_${index + 1}` : ""}`, image]));
  const start = await fetchJson(`https://api.bfl.ai/v1/${endpoint}`, {
    method: "POST",
    headers: { "x-key": process.env.BFL_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, ...inputImages }),
  }, 30000);
  if (!start.polling_url) throw httpError(502, "FLUX 未返回任务查询地址");

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 900));
    const status = await fetchJson(start.polling_url, {
      headers: { "x-key": process.env.BFL_API_KEY },
    }, 15000);
    const state = String(status.status || "").toLowerCase();
    if (state === "ready") {
      const sample = status?.result?.sample;
      if (typeof sample === "string" && sample.startsWith("data:image/")) return sample;
      return imageUrlToDataUri(sample);
    }
    if (["error", "failed", "request moderated"].includes(state)) {
      throw httpError(400, status.error || "FLUX 生成失败");
    }
  }
  throw httpError(504, "FLUX 生成超时");
}

async function handleGenerate(request, response) {
  const config = publicConfig();
  if (!config.configured) {
    const missing = config.provider === "seedream"
      ? "VOLCENGINE_ARK_API_KEY 和 VOLCENGINE_SEEDREAM_MODEL"
      : "BFL_API_KEY";
    throw httpError(503, `请先在 website/.env.local 配置 ${missing}`);
  }
  const { prompt, referenceIds } = validateGenerationInput(await readJsonBody(request));
  const trial = enforceRateLimit(request);
  const references = await referenceDataUris(referenceIds);
  const image = config.provider === "seedream"
    ? await generateWithSeedream(prompt, references)
    : await generateWithFlux(prompt, references);
  jsonResponse(response, 200, {
    image,
    provider: config.provider,
    providerLabel: config.label,
    model: config.model,
    trialLimit: trial.limit,
    trialRemaining: trial.remaining,
    trialDay: trial.day,
  });
}

async function serveStatic(request, response, root) {
  const url = new URL(request.url, "http://localhost");
  const decoded = decodeURIComponent(url.pathname);
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const filePath = resolve(root, relativePath);
  const normalizedRoot = resolve(root).toLowerCase();
  const normalizedFile = filePath.toLowerCase();
  if (normalizedFile !== normalizedRoot && !normalizedFile.startsWith(`${normalizedRoot}${sep}`)) throw httpError(403, "禁止访问");
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) throw httpError(404, "页面不存在");
  const extension = extname(filePath).toLowerCase();
  const shouldRevalidate = [".html", ".js", ".css"].includes(extension);
  if (extension === ".mp4") {
    const rangeMatch = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    let start = 0;
    let end = fileStat.size - 1;
    if (request.headers.range && !rangeMatch) throw httpError(416, "不支持的视频分段范围");
    if (rangeMatch) {
      if (!rangeMatch[1] && rangeMatch[2]) {
        const suffixLength = Number(rangeMatch[2]);
        start = Math.max(fileStat.size - suffixLength, 0);
      } else {
        start = Number(rangeMatch[1]);
        end = rangeMatch[2] ? Number(rangeMatch[2]) : end;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= fileStat.size) {
        response.writeHead(416, { "Content-Range": `bytes */${fileStat.size}` });
        return response.end();
      }
      end = Math.min(end, fileStat.size - 1);
    }
    response.writeHead(rangeMatch ? 206 : 200, {
      "Content-Type": "video/mp4",
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      ...(rangeMatch ? { "Content-Range": `bytes ${start}-${end}/${fileStat.size}` } : {}),
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") return response.end();
    return createReadStream(filePath, { start, end }).pipe(response);
  }
  const body = await readFile(filePath);
  response.writeHead(200, {
    "Content-Type": MIME_TYPES.get(extension) || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": shouldRevalidate ? "no-cache" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD") response.end();
  else response.end(body);
}

export function startServer(options = parseArgs(process.argv.slice(2))) {
  const root = isAbsolute(options.root) ? options.root : resolve(SCRIPT_DIR, options.root);
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      if ((request.method === "GET" || request.method === "HEAD") && pathname === "/healthz") {
        response.writeHead(204, { "Cache-Control": "no-store" });
        return response.end();
      }
      if (request.method === "GET" && pathname === "/api/image-config") return jsonResponse(response, 200, publicConfig());
      if (request.method === "POST" && pathname === "/api/generate") return await handleGenerate(request, response);
      if (request.method !== "GET" && request.method !== "HEAD") throw httpError(405, "不支持的请求方法");
      await serveStatic(request, response, root);
    } catch (error) {
      const status = Number(error.status) || (error.code === "ENOENT" ? 404 : 500);
      const message = status >= 500 && !error.status ? "服务器内部错误" : error.message;
      jsonResponse(response, status, { error: message });
    }
  });
  server.listen(options.port, options.host, () => {
    console.log(`Bowerbird website: http://${options.host}:${options.port}`);
    console.log(`Image provider: ${publicConfig().label} (${publicConfig().configured ? "configured" : "not configured"})`);
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();
