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

test('waits for a durable call ID when the initial Google Meet key is a descriptive page-title fallback', async () => {
  const initial = {
    ...generic,
    provider: 'google_meet',
    windowId: 'edge-meet-hwnd',
    title: 'Google Meet: Online web and video conferencing calls | Google Workspace',
    identityKey: 'browser:google meet: online web and video conferencing calls',
  };
  const identifiedSameWindow = {
    ...identified,
    windowId: 'edge-meet-hwnd',
  };

  const resolved = await resolveStableMeetingWindow({
    initialWindow: initial,
    keyOf: (item) => item.identityKey || keyOf(item),
    timeoutMs: 20,
    pollMs: 1,
    sleepImpl: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    getWindows: async () => [identifiedSameWindow],
  });

  assert.equal(resolved, identifiedSameWindow);
});

test('a descriptive Google Meet fallback never adopts a call ID from another HWND in the same process', async () => {
  const initial = {
    ...generic,
    provider: 'google_meet',
    windowId: 'edge-page-hwnd',
    title: 'Google Meet: Online web and video conferencing calls | Google Workspace',
    identityKey: 'browser:google meet: online web and video conferencing calls',
  };
  const identifiedOtherWindow = {
    ...identified,
    windowId: 'edge-call-hwnd',
  };

  const resolved = await resolveStableMeetingWindow({
    initialWindow: initial,
    keyOf: (item) => item.identityKey || keyOf(item),
    timeoutMs: 8,
    pollMs: 1,
    sleepImpl: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    getWindows: async () => [identifiedOtherWindow],
  });

  assert.equal(resolved, initial);
});
