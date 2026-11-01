import test from 'node:test';
import assert from 'node:assert/strict';
import { measurePcm16StereoChannel, isPcmChannelActive } from '../audio-meter.mjs';

function stereoBuffer(left, right) {
  const buffer = Buffer.alloc(left.length * 4);
  for (let i = 0; i < left.length; i += 1) {
    buffer.writeInt16LE(left[i], i * 4);
    buffer.writeInt16LE(right[i], i * 4 + 2);
  }
  return buffer;
}

test('measures microphone (right) and meeting (left) channels independently', () => {
  const buffer = stereoBuffer([0, 100, -100, 0], [0, 1000, -1000, 0]);
  const left = measurePcm16StereoChannel(buffer, 0);
  const right = measurePcm16StereoChannel(buffer, 1);
  assert.equal(left.peak, 100);
  assert.equal(right.peak, 1000);
  assert.ok(right.rms > left.rms);
});

test('empty frames report zero signal without throwing', () => {
  assert.deepEqual(measurePcm16StereoChannel(Buffer.alloc(0), 1), { sampleCount: 0, rms: 0, peak: 0 });
});

test('rejects invalid channel indexes', () => {
  assert.throws(() => measurePcm16StereoChannel(Buffer.alloc(8), 2), RangeError);
});

test('the existing silence gate remains unchanged and measurable', () => {
  assert.equal(isPcmChannelActive({ rms: 20, peak: 100 }), false);
  assert.equal(isPcmChannelActive({ rms: 150, peak: 200 }), true);
  assert.equal(isPcmChannelActive({ rms: 70, peak: 1000 }), true);
});
