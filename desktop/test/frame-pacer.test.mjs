import test from 'node:test';
import assert from 'node:assert/strict';
import { FramePacer } from '../frame-pacer.mjs';
import { SampleQueue } from '../sample-queue.mjs';

// Windows timers tick every ~15.6 ms, so a "100 ms" interval really fires every ~109 ms.
function simulate({ tickMs, seconds, frameMs = 100 }) {
  let clock = 0;
  const pacer = new FramePacer({ frameMs, now: () => clock });
  pacer.start();
  let emitted = 0;
  for (clock = tickMs; clock <= seconds * 1000; clock += tickMs) emitted += pacer.due();
  return emitted;
}

test('pacing against a clock keeps exactly real-time rate even with coarse timer ticks', () => {
  const emitted = simulate({ tickMs: 109, seconds: 60 });
  assert.ok(Math.abs(emitted - 600) <= 1, `expected ~600 frames in 60 s, got ${emitted}`);
});

test('the old one-frame-per-tick approach falls behind by ~9% (the bug this fixes)', () => {
  const ticks = Math.floor(60_000 / 109);
  assert.ok(ticks < 560, `one frame per 109 ms tick would only consume ${ticks} of 600 frames`);
});

test('fine-grained ticks also stay at real time', () => {
  const emitted = simulate({ tickMs: 20, seconds: 30 });
  assert.ok(Math.abs(emitted - 300) <= 1);
});

test('a long stall produces a bounded burst, not an unbounded one', () => {
  let clock = 0;
  const pacer = new FramePacer({ frameMs: 100, now: () => clock, maxBurstFrames: 30 });
  pacer.start();
  clock = 60_000; // a minute-long freeze
  assert.equal(pacer.due(), 30);
  assert.equal(pacer.due(), 0);
  clock += 100;
  assert.equal(pacer.due(), 1); // back to normal pacing afterwards
});

test('due() before start begins pacing instead of throwing', () => {
  const pacer = new FramePacer({ frameMs: 100, now: () => 5000 });
  assert.equal(pacer.due(), 0);
});

test('SampleQueue counts dropped audio when it overflows its cap', () => {
  const queue = new SampleQueue(1000);
  for (let i = 0; i < 5; i += 1) queue.push(new Int16Array(400));
  // Five 400-sample chunks into a 1000-sample cap: three oldest chunks are dropped, 800 kept.
  assert.equal(queue.totalSamples, 800);
  assert.equal(queue.droppedSamples, 1200);
});

test('SampleQueue pulls in order and pads missing samples with silence', () => {
  const queue = new SampleQueue(10_000);
  queue.push(Int16Array.from([1, 2, 3]));
  queue.push(Int16Array.from([4, 5]));
  assert.deepEqual(Array.from(queue.pull(4)), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(queue.pull(3)), [5, 0, 0]);
  assert.equal(queue.totalSamples, 0);
});
