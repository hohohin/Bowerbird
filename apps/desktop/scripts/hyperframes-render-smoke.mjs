// Synthetic offline renderer verification. No model calls or user media.
import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const cli = process.env.BOWERBIRD_HYPERFRAMES_CLI;
const ffmpeg = process.env.BOWERBIRD_FFMPEG_BINARY;
const ffprobe = process.env.BOWERBIRD_FFPROBE_BINARY;
assert(cli && ffmpeg && ffprobe, 'Set explicit isolated CLI, FFmpeg and FFprobe paths');
const base = resolve('.tmp/video-skill-render');
const root = resolve(base, 'request');
const project = resolve(base, 'project');
await mkdir(resolve(project, 'assets'), { recursive: true });
await mkdir(resolve(project, 'compositions'), { recursive: true });
await mkdir(root, { recursive: true });
await copyFile(resolve(dirname(cli), '../dist/vendor/npm/gsap@3.15.0/dist/gsap.min.js'), resolve(project, 'assets/gsap.js'));
await writeFile(resolve(project, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:640px;height:360px;overflow:hidden;background:#121720}#root{position:relative;width:640px;height:360px}
</style><script src="assets/gsap.js"></script></head><body><div id="root" data-composition-id="main" data-start="0" data-duration="2" data-width="640" data-height="360"><div id="scene" data-composition-id="scene" data-composition-src="compositions/scene.html" data-start="0" data-duration="2" data-track-index="1" data-width="640" data-height="360"></div></div><script>window.__timelines={main:gsap.timeline({paused:true})};</script></body></html>`);
await writeFile(resolve(project, 'compositions/scene.html'), `<template><style>#scene-root{position:absolute;inset:0}#tile{width:100px;height:100px;background:#4868ff;position:absolute;top:130px;left:40px}</style><div id="scene-root" data-composition-id="scene" data-width="640" data-height="360"><div id="tile" class="clip" data-start="0" data-duration="2" data-track-index="1"></div></div><script>window.__timelines.scene=gsap.timeline({paused:true}).fromTo('#tile',{x:0,rotation:0},{x:460,rotation:180,duration:2,ease:'none'});</script></template>`);
function run(binary, args) {
  const result = spawnSync(binary, args, { cwd: project, encoding: 'utf8', timeout: 240000, windowsHide: true,
    env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', HYPERFRAMES_FFMPEG_PATH: ffmpeg,
      HYPERFRAMES_FFPROBE_PATH: ffprobe, HYPERFRAMES_CACHE_DIR: resolve(root, 'cache') } });
  assert.equal(result.status, 0, `${args[0]} failed: ${result.error || result.stderr}\n${result.stdout}`);
  return result.stdout;
}
const output = resolve(root, 'result.mp4');
await writeFile(resolve(root, 'check.json'), run(process.execPath, [cli, 'check', '--json']));
await writeFile(resolve(root, 'render.log'), run(process.execPath, [cli, 'render', '--output', output, '--fps', '15', '--quality', 'draft', '--workers', '1']));
const probe = JSON.parse(run(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', output]));
assert.equal(probe.streams[0].width, 640); assert.equal(probe.streams[0].height, 360);
assert(Math.abs(Number(probe.format.duration) - 2) < 0.2);
run(ffmpeg, ['-v', 'error', '-i', output, '-f', 'null', '-']);
const frames = run(ffmpeg, ['-v', 'error', '-i', output, '-f', 'framemd5', '-']).split('\n').filter(line => line && !line.startsWith('#'));
assert(new Set(frames.map(line => line.split(',').at(-1).trim())).size > 20, 'render contains moving frames');
console.log(JSON.stringify({ output, width: 640, height: 360, duration: probe.format.duration, distinctFrames: new Set(frames).size }));
