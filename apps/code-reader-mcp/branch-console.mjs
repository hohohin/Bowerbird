import http from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { exportSnapshotWithReport } from './export.mjs';
import { createSnapshotReader } from './snapshot-store.mjs';
import { combinedServiceState, readServiceStatus } from './service-status.mjs';
import { startPrerequisite, startServices } from './service-start.mjs';
import tunnelProfile from './tunnel-profile.json' with { type: 'json' };

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const detached = '(detached HEAD)';
const consoleApp = 'bowerbird-mcp-console';
const assets = new Map([
  ['/', ['console.html', 'text/html']],
  ['/console.js', ['console.js', 'text/javascript']],
]);

async function git(root, ...args) {
  const { stdout } = await run('git', ['--no-optional-locks', '-c', 'core.hooksPath=' + os.devNull,
    '-C', root, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trimEnd();
}

async function branches(root) {
  const format = '%(refname)%00%(objectname)%00%(committerdate:iso-strict)%00%(HEAD)';
  const output = await git(root, 'for-each-ref', '--sort=-committerdate', '--format=' + format, 'refs/heads/');
  const rows = output.split(/\r?\n/).filter(Boolean).map(line => {
    const [ref, revision, committedAt, head] = line.split('\0');
    return { branch: ref.slice('refs/heads/'.length), revision, committedAt, current: head === '*' };
  });
  if (!rows.some(row => row.current) && !(await git(root, 'branch', '--show-current'))) {
    const [revision, committedAt] = (await git(root, 'show', '-s', '--format=%H%x00%cI', 'HEAD')).split('\0');
    rows.unshift({ branch: detached, revision, committedAt, current: true });
  }
  return rows;
}

async function exportSelection(root, output, selected, clean, onProgress) {
  const verify = report => {
    if (report.branch !== selected.branch || report.revision !== selected.revision ||
        (clean && report.isDirty)) throw new Error('所选分支或提交已变化，请刷新分支列表后重试。');
  };
  if (selected.current && !clean) {
    return exportSnapshotWithReport(root, output, { onProgress, beforePublish: verify });
  }
  const parent = await mkdtemp(path.join(os.tmpdir(), 'bb-mcp-worktree-'));
  const checkout = path.join(parent, 'checkout');
  let registered = false;
  let cleaned = false;
  async function cleanup() {
    if (path.dirname(parent) !== os.tmpdir() || !path.basename(parent).startsWith('bb-mcp-worktree-')) {
      throw new Error('临时工作树路径异常。');
    }
    if (registered) {
      await git(root, 'worktree', 'remove', '--force', checkout);
      registered = false;
    }
    await rm(parent, { recursive: true, force: true, maxRetries: 3 });
    cleaned = true;
  }
  try {
    try {
      await git(root, 'worktree', 'add', '--detach', checkout, selected.revision);
      registered = true;
    } catch (error) {
      // Checkout can fail after Git registered this path. Undo only our own entry.
      const list = await git(root, 'worktree', 'list', '--porcelain', '-z');
      registered = list.split('\0').some(field => field.startsWith('worktree ') &&
        path.relative(checkout, field.slice('worktree '.length)) === '');
      throw error;
    }
    return await exportSnapshotWithReport(checkout, output, {
      branch: selected.branch, onProgress,
      beforePublish: async report => { verify(report); await cleanup(); },
    });
  } finally {
    if (!cleaned) await cleanup();
  }
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new Error('请求过长。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readSelection(req) {
  const value = await readJson(req);
  if (value?.current === true && Object.keys(value).length === 1) return value;
  if (!value || typeof value.branch !== 'string' || !value.branch || value.branch.startsWith('-') ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.revision) || typeof value.clean !== 'boolean') {
    throw new Error('无效的分支或提交。');
  }
  return value;
}

export async function startBranchConsole(root, output, port = 48733, {
  probe = readServiceStatus, launchServices = startServices,
} = {}) {
  const readSnapshot = createSnapshotReader(output);
  const instance = createHash('sha256').update(JSON.stringify([path.resolve(root), path.resolve(output)])).digest('hex');
  function published() {
    try {
      const data = readSnapshot();
      return { branch: data.branch ?? null, isDirty: data.isDirty ?? null, createdAt: data.createdAt,
        revision: data.revision, fileCount: data.files.length };
    } catch { return null; }
  }
  let job = { status: 'idle' };
  let pending;
  let serviceProbe;
  let startPending = false;
  let startup = { status: 'idle' };
  function probeServices() {
    serviceProbe ??= probe(path.join(root, 'apps/code-reader-mcp'), tunnelProfile.tunnelId)
      .finally(() => { serviceProbe = undefined; });
    return serviceProbe;
  }
  async function requestStart(req, send) {
    if (startPending) return send(409, { error: '正在启动服务。' });
    let body;
    try { body = await readJson(req); }
    catch { return send(400, { error: '请发送空 JSON 对象。' }); }
    if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length) {
      return send(400, { error: '请发送空 JSON 对象。' });
    }
    if (startPending) return send(409, { error: '正在启动服务。' });
    startPending = true;
    try {
      const status = await probeServices();
      const targets = ['gpt', 'gemini'].filter(name => status[name].state === 'stopped');
      if (!targets.length) return send(200, { status: 'unchanged' });
      const error = await startPrerequisite(root, targets, published());
      if (error) return send(409, { error });
      startup = { status: 'starting' };
      void Promise.resolve().then(() => launchServices(root, targets, probeServices))
        .then(() => { startup = { status: 'done' }; }, () => {
          startup = { status: 'failed', error: '服务启动失败，请检查本机配置。' };
        }).finally(() => { startPending = false; });
      return send(202, startup);
    } catch { return send(503, { error: '无法检测本机服务。' }); }
    finally { if (startup.status !== 'starting') startPending = false; }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      const host = '127.0.0.1:' + server.address().port;
      const origin = 'http://' + host;
      if (req.headers.host !== host || (req.headers.origin !== undefined && req.headers.origin !== origin)) {
        return send(403, { error: '仅允许本机控制台访问。' });
      }
      if (req.method === 'GET' && assets.has(req.url)) {
        const [file, mime] = assets.get(req.url);
        const body = await readFile(path.join(here, file));
        res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
        return res.end(body);
      }
      if (req.method === 'GET' && req.url === '/api/branches') return send(200, await branches(root));
      if (req.method === 'GET' && req.url === '/api/status') return send(200, { app: consoleApp, instance, apiVersion: 2, snapshot: published(), job });
      if (req.method === 'GET' && req.url === '/api/services') {
        try {
          const status = await probeServices();
          return send(200, { ...status, combined: combinedServiceState(status, startup.status === 'starting'), startup });
        }
        catch { return send(503, { error: '运行状态探测失败。' }); }
      }
      if (req.method !== 'POST' || !['/api/export', '/api/services/start'].includes(req.url)) return send(404, { error: '无此操作。' });
      if (req.headers.origin !== origin) return send(403, { error: '缺少同源请求。' });
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return send(415, { error: '需要 JSON 请求。' });
      if (req.url === '/api/services/start') return await requestStart(req, send);
      if (pending) return send(409, { error: '正在导出快照。' });
      let choice;
      try { choice = await readSelection(req); }
      catch { return send(400, { error: '分支请求格式无效。' }); }
      // Git supplies the allowlist and commit IDs. Request data never becomes a revision expression.
      const available = await branches(root);
      const selected = available.find(row => choice.current ? row.current : row.branch === choice.branch && row.revision === choice.revision);
      if (!selected) return send(409, { error: '分支或提交已变化，请刷新列表。' });
      if (!selected.current && !choice.clean) return send(409, { error: '工作区已切换分支，请刷新列表。' });
      if (selected.branch !== detached) await git(root, 'check-ref-format', 'refs/heads/' + selected.branch);
      if (pending) return send(409, { error: '正在导出快照。' });
      const clean = choice.clean === true || !selected.current;
      job = { status: 'running', branch: selected.branch, exportedFiles: 0, redactedLines: 0, coverageStatus: 'checking' };
      pending = exportSelection(root, output, selected, clean, progress => Object.assign(job, progress))
        .then(report => Object.assign(job, { status: 'done', coverageStatus: report.coverage.status,
          exportedFiles: report.exportedFiles, redactedLines: report.redactedLines }))
        .catch(error => {
          const gap = error.report?.coverage.unresolvedCoreDependencies[0];
          const message = gap ? '核心依赖未导出：' + gap.from + ' → ' + gap.target + '（' + gap.reason + '）' : error.message;
          Object.assign(job, { status: 'failed', error: message.slice(0, 1600), coverageStatus: gap ? 'incomplete' : 'failed' });
        })
        .finally(() => { pending = undefined; });
      send(202, job);
    } catch (error) { send(500, { error: error.message.slice(0, 1600) }); }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    const origin = 'http://127.0.0.1:' + port;
    const status = await fetch(origin + '/api/status', { signal: AbortSignal.timeout(2000), redirect: 'error' })
      .then(res => res.ok ? res.json() : null).catch(() => null);
    if (status?.app !== consoleApp || status.instance !== instance) throw error;
    return { origin, reused: true, async close() {} };
  }
  const origin = 'http://127.0.0.1:' + server.address().port;
  return { origin, reused: false, async close() {
    await new Promise(resolve => server.close(resolve));
    await pending;
  } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startBranchConsole(path.resolve(here, '../..'), path.join(here, '.local/snapshot.json'));
  console.log((app.reused ? '复用已运行的控制台 ' : '本机快照控制台 ') + app.origin);
  const command = process.platform === 'win32' ? ['wscript.exe', path.resolve(here, '../../mcp-tool.vbs'), '--open-window'] :
    [process.platform === 'darwin' ? 'open' : 'xdg-open', app.origin];
  if (!process.argv.includes('--serve-only')) {
    execFile(command[0], command.slice(1), { windowsHide: true }, error => {
      if (error) console.error('请在本机浏览器中打开 ' + app.origin);
    });
  }
  if (!app.reused) {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
  }
}
