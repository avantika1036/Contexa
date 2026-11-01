import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectMicrophoneDevice,
  isRecoverableMicrophoneDeviceError,
  microphoneRetryDelayMs,
} from '../microphone-devices.mjs';

const external = { id: 'realtek-input', name: 'External Microphone (Realtek)', default: true };
const array = { id: 'intel-array', name: 'Microphone Array (Intel)', default: false };
const headset = { id: 'headset-input', name: 'Headset Microphone', default: true };

test('selects the newly assigned Windows default after an earphone is connected', () => {
  assert.equal(selectMicrophoneDevice([array, headset], external.id), headset);
});

test('retains the currently selected device if no default change is reported', () => {
  assert.equal(selectMicrophoneDevice([external, array], external.id), external);
});

test('uses the only available microphone when the host omits its default flag', () => {
  assert.equal(selectMicrophoneDevice([array]), array);
});

test('does not guess between multiple devices when no default is reported', () => {
  assert.equal(selectMicrophoneDevice([
    { ...external, default: false },
    { ...array, default: false },
  ]), null);
});

test('returns null for an empty or malformed device list', () => {
  assert.equal(selectMicrophoneDevice([]), null);
  assert.equal(selectMicrophoneDevice(null), null);
});

test('recognizes Windows input endpoint loss as recoverable', () => {
  assert.equal(isRecoverableMicrophoneDeviceError(Object.assign(new Error('input device stopped'), { code: 'EDEVICELOST' })), true);
  assert.equal(isRecoverableMicrophoneDeviceError(Object.assign(new Error('device not found'), { code: 'ENODEVICE' })), true);
  assert.equal(isRecoverableMicrophoneDeviceError(new Error('Microphone input device unavailable')), true);
});

test('does not classify permission failures as hot-plug events', () => {
  assert.equal(isRecoverableMicrophoneDeviceError(Object.assign(new Error('permission denied'), { code: 'EACCES' })), false);
  assert.equal(isRecoverableMicrophoneDeviceError(new Error('Deepgram authentication failed')), false);
});

test('uses bounded backoff when a replacement microphone is not ready yet', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 100].map(microphoneRetryDelayMs), [500, 1000, 2000, 4000, 5000, 5000, 5000]);
});

import { waitForStableMicrophoneDevice } from '../microphone-devices.mjs';

test('waits for Windows default microphone selection to settle after hot-plug', async () => {
  const snapshots = [
    [external, array],
    [array, headset],
    [array, headset],
  ];
  let index = 0;
  const selected = await waitForStableMicrophoneDevice({
    listDevices: async () => snapshots[Math.min(index++, snapshots.length - 1)],
    preferredDeviceId: external.id,
    attempts: 4,
    requiredConsecutive: 2,
    intervalMs: 0,
    sleepImpl: async () => {},
  });
  assert.equal(selected, headset);
});

test('does not declare a microphone stable from alternating Windows defaults', async () => {
  const snapshots = [
    [external, array],
    [array, headset],
    [external, array],
    [array, headset],
  ];
  let index = 0;
  const selected = await waitForStableMicrophoneDevice({
    listDevices: async () => snapshots[index++],
    preferredDeviceId: external.id,
    attempts: 4,
    requiredConsecutive: 2,
    intervalMs: 0,
    sleepImpl: async () => {},
  });
  assert.equal(selected, null);
});
