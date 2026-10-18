import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeGenerationWithDiagnostics } from '../src/lib/generationDiagnostics.ts';

const request = { jobId: 'job', turnKey: 'turn', media: 'image', referenceImages: ['frame.png', 'product.png'] };

test('receipt is committed before generation; IPC decoding failures remain searchable', async () => {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === 'begin_generation_diagnostic') return 'attempt';
    if (command === 'codex_create_image') throw 'invalid args: videoOptions';
  };
  await assert.rejects(invokeGenerationWithDiagnostics(request, invoke), e => e === 'invalid args: videoOptions');
  assert.deepEqual(calls.map(c => c.command), ['begin_generation_diagnostic', 'codex_create_image', 'finish_generation_diagnostic']);
  assert.deepEqual(calls[0].args.request, request);
  assert.equal(calls[1].args.diagnosticId, 'attempt');
  assert.deepEqual(calls[2].args, { attemptId: 'attempt', jobId: 'job', error: 'invalid args: videoOptions' });
});

test('receipt write failure never submits a potentially paid generation', async () => {
  const calls = [];
  await assert.rejects(invokeGenerationWithDiagnostics(request, async command => {
    calls.push(command); throw new Error('database unavailable');
  }), /database unavailable/);
  assert.deepEqual(calls, ['begin_generation_diagnostic']);
});

test('successful generation returns unchanged and does not resubmit', async () => {
  const calls = [];
  const result = await invokeGenerationWithDiagnostics(request, async command => {
    calls.push(command); return command === 'begin_generation_diagnostic' ? 'attempt' : 'job';
  });
  assert.equal(result, 'job');
  assert.deepEqual(calls, ['begin_generation_diagnostic', 'codex_create_image']);
});

test('failure to finalize a receipt preserves the original generation error', async () => {
  const original = new Error('provider timeout');
  const previous = console.error; console.error = () => {};
  try {
    await assert.rejects(invokeGenerationWithDiagnostics(request, async command => {
      if (command === 'begin_generation_diagnostic') return 'attempt';
      if (command === 'codex_create_image') throw original;
      throw new Error('disk full');
    }), error => error === original);
  } finally { console.error = previous; }
});
