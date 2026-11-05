// The desktop validates and executes this local tool; the agent keeps its sandbox.
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
const id = randomUUID();
const request = join(config.root, 'video-tool-requests', `${id}.json`);
await writeFile(`${request}.tmp`, JSON.stringify({ args: process.argv.slice(2) }), { flag: 'wx' });
await rename(`${request}.tmp`, request);
const deadline = Date.now() + 660000;
while (true) {
  let result;
  try { result = JSON.parse(await readFile(join(config.root, 'video-tool-results', `${id}.json`), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (result) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) console.error(result.error);
    process.exitCode = result.error ? 1 : result.code;
    break;
  }
  try {
    const stopped = JSON.parse(await readFile(join(config.root, 'video-tool-stopped.json'), 'utf8'));
    throw new Error(stopped.error || '视频工具已停止，请检查原任务');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (Date.now() > deadline) throw new Error('视频工具等待超时；请检查原任务，不要重复投递');
  await new Promise(resolve => setTimeout(resolve, 250));
}
