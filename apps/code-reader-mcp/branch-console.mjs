import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { exportSnapshotWithReport } from './export.mjs';
import { createSnapshotReader } from './snapshot-store.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const detached = '(detached HEAD)';
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

async function readSelection(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new Error('请求过长。');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value.branch !== 'string' || !value.branch || value.branch.startsWith('-') ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.revision) || typeof value.clean !== 'boolean') {
    throw new Error('无效的分支或提交。');
  }
  return value;
}

export async function startBranchConsole(root, output, port = 48733) {
  const readSnapshot = createSnapshotReader(output);
  function published() {
    try {
      const data = readSnapshot();
      return { branch: data.branch ?? null, isDirty: data.isDirty ?? null, createdAt: data.createdAt,
        revision: data.revision, fileCount: data.files.length };
    } catch { return null; }
  }
  let job = { status: 'idle' };
  let pending;
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
      if (req.method === 'GET' && req.url === '/api/status') return send(200, { snapshot: published(), job });
      if (req.method !== 'POST' || req.url !== '/api/export') return send(404, { error: '无此操作。' });
      if (req.headers.origin !== origin) return send(403, { error: '缺少同源请求。' });
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return send(415, { error: '需要 JSON 请求。' });
      if (pending) return send(409, { error: '正在导出快照。' });
      let choice;
      try { choice = await readSelection(req); }
      catch { return send(400, { error: '分支请求格式无效。' }); }
      // Git supplies the allowlist and commit IDs. Request data never becomes a revision expression.
      const selected = (await branches(root)).find(row => row.branch === choice.branch && row.revision === choice.revision);
      if (!selected) return send(409, { error: '分支或提交已变化，请刷新列表。' });
      if (!selected.current && !choice.clean) return send(409, { error: '工作区已切换分支，请刷新列表。' });
      if (selected.branch !== detached) await git(root, 'check-ref-format', 'refs/heads/' + selected.branch);
      if (pending) return send(409, { error: '正在导出快照。' });
      const clean = choice.clean || !selected.current;
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
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  return { origin, async close() {
    await new Promise(resolve => server.close(resolve));
    await pending;
  } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startBranchConsole(path.resolve(here, '../..'), path.join(here, '.local/snapshot.json'));
  console.log('本机快照控制台 ' + app.origin + ' （Ctrl+C 关闭）');
  const command = process.platform === 'win32' ? ['rundll32.exe', 'url.dll,FileProtocolHandler'] :
    process.platform === 'darwin' ? ['open'] : ['xdg-open'];
  execFile(command[0], [...command.slice(1), app.origin], { windowsHide: true }, error => {
    if (error) console.error('请在本机浏览器中打开上面的地址。');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
}
