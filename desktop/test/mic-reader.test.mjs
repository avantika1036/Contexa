import test from 'node:test';
import assert from 'node:assert/strict';
import { pumpReader } from '../mic-reader.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Windows timers tick roughly every 15 ms, so these tests wait for a condition rather than a
// fixed amount of time.
async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await wait(5);
  }
}

// Behaves like @audio/mic: each read(cb) call gets exactly ONE chunk, asynchronously.
function singleShotReader({ chunks = Infinity, intervalMs = 2, emptyFirst = 0, errorAfter = null } = {}) {
  const state = { reads: 0, stopped: false, delivered: 0, empty: emptyFirst };
  const reader = (cb) => {
    if (cb === null) { state.stopped = true; return; }
    state.reads += 1;
    setTimeout(() => {
      if (state.stopped) return;
      if (state.empty > 0) { state.empty -= 1; return cb(null, null); }
      if (errorAfter !== null && state.delivered >= errorAfter) {
        return cb(Object.assign(new Error('device lost'), { code: 'EDEVICELOST' }), null);
      }
      if (state.delivered >= chunks) return cb(null, null);
      state.delivered += 1;
      cb(null, Buffer.alloc(960));
    }, intervalMs);
  };
  return { reader, state };
}

test('keeps delivering chunks from a reader that returns one chunk per call', async () => {
  const { reader, state } = singleShotReader();
  const received = [];
  const pump = pumpReader(reader, { onChunk: (c) => received.push(c.length), onError: assert.fail });
  await until(() => received.length >= 10);
  pump.stop();
  assert.ok(received.every((n) => n === 960));
  assert.equal(state.stopped, true);
});

test('registering a callback only once would have produced a single chunk (the original bug)', async () => {
  const { reader } = singleShotReader();
  let count = 0;
  reader((error, chunk) => { if (chunk) count += 1; });
  await until(() => count >= 1);
  await wait(100); // plenty of time for more chunks, if there were going to be any
  assert.equal(count, 1);
});

test('stop() halts delivery and closes the reader', async () => {
  const { reader, state } = singleShotReader();
  let received = 0;
  const pump = pumpReader(reader, { onChunk: () => { received += 1; }, onError: assert.fail });
  await until(() => received >= 3);
  pump.stop();
  const atStop = received;
  await wait(100);
  assert.equal(received, atStop);
  assert.equal(state.stopped, true);
});

test('a reader error is reported once and stops the loop', async () => {
  const { reader } = singleShotReader({ errorAfter: 3 });
  const errors = [];
  let received = 0;
  pumpReader(reader, { onChunk: () => { received += 1; }, onError: (e) => errors.push(e) });
  await until(() => errors.length >= 1);
  await wait(100);
  assert.equal(received, 3);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'EDEVICELOST');
});

test('a few empty reads are tolerated and the stream continues', async () => {
  const { reader } = singleShotReader({ emptyFirst: 3 });
  let received = 0;
  const pump = pumpReader(reader, { onChunk: () => { received += 1; }, onError: assert.fail, retryDelayMs: 1 });
  await until(() => received >= 6);
  pump.stop();
});

test('a long run of empty reads is reported as a stream failure', async () => {
  const { reader } = singleShotReader({ chunks: 0 });
  const errors = [];
  pumpReader(reader, { onChunk: assert.fail, onError: (e) => errors.push(e), retryDelayMs: 1, maxEmptyReads: 5 });
  await until(() => errors.length >= 1);
  await wait(100);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /ended unexpectedly/);
});

test('a synchronous throw from the reader becomes an error callback', () => {
  const errors = [];
  pumpReader(() => { throw new Error('boom'); }, { onChunk: assert.fail, onError: (e) => errors.push(e.message) });
  assert.deepEqual(errors, ['boom']);
});

test('non-Buffer chunks (Uint8Array) are converted to Buffer', () => {
  let first;
  let calls = 0;
  const reader = (cb) => { if (cb && calls++ === 0) cb(null, new Uint8Array([1, 2, 3, 4])); };
  pumpReader(reader, { onChunk: (c) => { first = c; }, onError: assert.fail });
  assert.ok(Buffer.isBuffer(first));
  assert.equal(first.length, 4);
});
