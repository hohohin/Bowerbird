import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Original synthetic fixture. Peaks are measured from the exact PCM written below.
const output = fileURLToPath(new URL('../public/', import.meta.url));
const sampleRate = 16000;
const duration = 8;
const frameCount = sampleRate * duration;
const buckets = 256;
const framesPerPeak = Math.ceil(frameCount / buckets);
const peaks = Array.from({ length: buckets * 2 }, () => 0);
const buffer = Buffer.alloc(44 + frameCount * 2);
buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVE', 8);
buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32);
buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(frameCount * 2, 40);
const notes = [220, 261.6256, 329.6276, 293.6648];
for (let frame = 0; frame < frameCount; frame++) {
  const time = frame / sampleRate;
  const beat = time % 0.5;
  const attack = Math.min(1, beat / 0.025);
  const envelope = attack * Math.exp(-beat * 8) * Math.min(1, time / 0.04, (duration - time) / 0.1);
  const frequency = notes[Math.floor(time / 2) % notes.length];
  const signal = Math.sin(2 * Math.PI * frequency * time) * 0.14
    + Math.sin(2 * Math.PI * frequency * 2 * time) * 0.035;
  const value = Math.round(signal * envelope * 32767);
  buffer.writeInt16LE(value, 44 + frame * 2);
  const index = Math.floor(frame / framesPerPeak) * 2;
  const normalized = value / 32768;
  peaks[index] = Math.min(peaks[index], normalized);
  peaks[index + 1] = Math.max(peaks[index + 1], normalized);
}
await mkdir(output, { recursive: true });
await writeFile(new URL('../public/pulse.wav', import.meta.url), buffer);
await writeFile(new URL('../public/pulse-peaks.json', import.meta.url), JSON.stringify({
  duration, sampleRate, frameCount, framesPerPeak,
  peaks: peaks.map(value => Math.round(value * 100000) / 100000),
}));
console.log(`Generated ${duration}s synthetic WAV (${buffer.length} bytes), ${buckets} measured peak buckets.`);
