import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStableMeetingWindow } from '../meeting-identity.mjs';

const generic = { pid: 36380, processName: 'chrome', title: 'Meet', foreground: true };
const identified = { pid: 36380, processName: 'chrome', title: 'Meet - fai-wivv-szk', foreground: true };
const keyOf = (windowInfo) => {
  const match = String(windowInfo.title).match(/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  return match ? `meet:${match[1].toLowerCase()}` : 'browser:*';
};

test('waits briefly for Google Meet to expose its durable call code before creating a session', async () => {
  let calls = 0;
  const resolved = await resolveStableMeetingWindow({
    initialWindow: generic,
    keyOf,
    timeoutMs: 250,
    pollMs: 1,
    sleepImpl: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    getWindows: async () => {
      calls += 1;
      return calls < 2 ? [generic] : [identified];
    },
  });
  assert.equal(resolved.title, identified.title);
  assert.ok(calls >= 2);
});

test('does not guess when multiple explicit Meet calls in the same process lack a foreground owner', async () => {
  const other = { pid: 36380, processName: 'chrome', title: 'Meet - emh-saes-zmn', foreground: false };
  const resolved = await resolveStableMeetingWindow({
    initialWindow: generic,
    keyOf,
    timeoutMs: 20,
    pollMs: 1,
    sleepImpl: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    getWindows: async () => [identified, other].map((item) => ({ ...item, foreground: false })),
  });
  assert.equal(resolved, generic);
});

test('uses the only foreground explicit Meet call when multiple calls share a browser process', async () => {
  const other = { pid: 36380, processName: 'chrome', title: 'Meet - emh-saes-zmn', foreground: false };
  const resolved = await resolveStableMeetingWindow({
    initialWindow: generic,
    keyOf,
    timeoutMs: 20,
    pollMs: 1,
    sleepImpl: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    getWindows: async () => [other, identified],
  });
  assert.equal(resolved.title, identified.title);
});
