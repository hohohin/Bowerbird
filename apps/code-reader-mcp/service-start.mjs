import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const services = {
  gpt: { required: '.env.tunnel', script: 'update-mcp.ps1' },
  gemini: { required: 'apps/code-reader-mcp/.local/gemini/config.json',
    script: 'apps/code-reader-mcp/ensure-gemini.ps1' },
};

export async function startPrerequisite(root, targets, snapshot) {
  if (!snapshot) return '请先更新快照。';
  for (const service of targets) {
    try { await access(path.join(root, services[service].required)); }
    catch { return service === 'gpt' ? '缺少 GPT 隧道密钥文件。' : '缺少 Gemini 本机配置。'; }
  }
  return null;
}

async function launch(root, name) {
  const command = `
    $ErrorActionPreference = 'Stop'
    $root = (Get-Location).Path
    $script = Join-Path $root $env:BOWERBIRD_WIDGET_LAUNCHER
    $argsForLauncher = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $script + '"'))
    if ($env:BOWERBIRD_WIDGET_TARGET -eq 'gpt') { $argsForLauncher += '-StartTunnelOnly' }
    $log = Join-Path $root ('apps/code-reader-mcp/.local/' + $env:BOWERBIRD_WIDGET_TARGET + '-widget-start-' + $PID)
    Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $argsForLauncher -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput ($log+'.log') -RedirectStandardError ($log+'.err.log')
  `;
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    cwd: root, windowsHide: true, timeout: 8000,
    env: { ...process.env, BOWERBIRD_WIDGET_LAUNCHER: services[name].script, BOWERBIRD_WIDGET_TARGET: name },
  });
}

export async function startServices(root, targets, probe) {
  await Promise.all(targets.map(name => launch(root, name)));
  const deadline = Date.now() + 30000;
  do {
    const status = await probe();
    if (targets.every(name => status[name].process === 'running')) return;
    await delay(650);
  } while (Date.now() < deadline);
  throw new Error('Launcher timeout');
}
