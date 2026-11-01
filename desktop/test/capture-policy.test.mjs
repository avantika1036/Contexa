import test from 'node:test';
import assert from 'node:assert/strict';
import { captureStopReason, selectStartCandidate, isSupportedMeetingWindow, normalizeDesktopWindows, normalizeMeetingWindows } from '../capture-policy.mjs';
import { hasSameBrowserProcessWindow } from '../meeting-session.mjs';

const base = { startedAt: 0, lastMatchedAt: 0, lastAudibleAt: 0 };

test('a present window with recent speech keeps capturing', () => {
  assert.equal(captureStopReason({ ...base, now: 60_000, lastMatchedAt: 60_000, lastAudibleAt: 58_000 }), null);
});

test('a flapping title does not stop capture while people are still talking', () => {
  // window not matched for 40 s, but audio 2 s ago
  assert.equal(captureStopReason({ ...base, now: 100_000, lastMatchedAt: 60_000, lastAudibleAt: 98_000 }), null);
});

test('a missing window with a silent room stops after the quiet period', () => {
  const stop = captureStopReason({ ...base, now: 100_000, lastMatchedAt: 60_000, lastAudibleAt: 50_000 });
  assert.equal(stop.reason, 'window-missing');
});

test('audio can only protect a missing window for a bounded time (other tabs may be playing sound)', () => {
  const stop = captureStopReason({ ...base, now: 300_000, lastMatchedAt: 100_000, lastAudibleAt: 299_000 });
  assert.equal(stop.reason, 'window-missing');
});

test('a brief title gap shorter than the stop threshold is ignored', () => {
  assert.equal(captureStopReason({ ...base, now: 100_000, lastMatchedAt: 90_000, lastAudibleAt: 20_000 })?.reason, undefined);
});

test('a matching window that has been silent for the idle period means the meeting is over', () => {
  // e.g. the "You left the meeting" page still matches
  const stop = captureStopReason({ ...base, now: 400_000, lastMatchedAt: 400_000, lastAudibleAt: 200_000 });
  assert.equal(stop.reason, 'idle');
});

test('idle ending can be disabled', () => {
  assert.equal(captureStopReason({ ...base, now: 9_000_000, lastMatchedAt: 9_000_000, lastAudibleAt: 0, policy: { idleEndMs: 0 } }), null);
});

test('waiting alone in a meeting is not treated as ended until a much longer silence', () => {
  assert.equal(captureStopReason({ now: 100_000, startedAt: 90_000, lastMatchedAt: 100_000, lastAudibleAt: 0 }), null);
  // 5 minutes of silence since start, nothing ever heard: still waiting
  assert.equal(captureStopReason({ now: 390_000, startedAt: 90_000, lastMatchedAt: 390_000, lastAudibleAt: 0 }), null);
  // 10+ minutes of nothing: give up
  assert.equal(captureStopReason({ now: 800_000, startedAt: 90_000, lastMatchedAt: 800_000, lastAudibleAt: 0 }).reason, 'idle');
});

const keyOf = (m) => m.key;
const meet = { pid: 1, key: 'meet:abc', title: 'Meet' };
const other = { pid: 2, key: 'zoom:*', title: 'Zoom Meeting' };

test('a blocked window is not restarted, but other meetings still are', () => {
  const block = { pid: 1, key: 'meet:abc', until: 1000 };
  assert.equal(selectStartCandidate([meet], block, 500, keyOf).candidate, null);
  assert.equal(selectStartCandidate([meet, other], block, 500, keyOf).candidate, other);
});

test('the block lifts when the window disappears, so a rejoin starts a new session', () => {
  const block = { pid: 1, key: 'meet:abc', until: 1000 };
  assert.equal(selectStartCandidate([], block, 500, keyOf).block, null);
  assert.equal(selectStartCandidate([meet], null, 600, keyOf).candidate, meet);
});

test('the block expires on its own', () => {
  const block = { pid: 1, key: 'meet:abc', until: 1000 };
  const result = selectStartCandidate([meet], block, 1000, keyOf);
  assert.equal(result.block, null);
  assert.equal(result.candidate, meet);
});

import { resolveAutoCapture } from '../capture-policy.mjs';

test('Auto Capture is on by default once consent is recorded', () => {
  assert.equal(resolveAutoCapture({ consentVersion: 1 }), true);
  assert.equal(resolveAutoCapture({ consentVersion: 1, autoCapturePausedByUser: false }), true);
});

test('an explicit pause stays paused across restarts', () => {
  assert.equal(resolveAutoCapture({ consentVersion: 1, autoCapturePausedByUser: true }), false);
});

test('Auto Capture is never on without recorded consent', () => {
  assert.equal(resolveAutoCapture({ consentVersion: 0 }), false);
  assert.equal(resolveAutoCapture({ consentVersion: 0, autoCapturePausedByUser: false }), false);
  assert.equal(resolveAutoCapture({}), false);
});


test('a Google Meet call-code title remains detectable after Electron restarts', () => {
  assert.equal(isSupportedMeetingWindow('chrome', 'Meet - emh-saes-zmn'), true);
  assert.equal(isSupportedMeetingWindow('chrome', 'Meet - fai-wivv-szk - Google Chrome'), true);
  assert.equal(isSupportedMeetingWindow('msedge', 'Meet – emh-saes-zmn – Microsoft Edge'), true);
});

test('Google Meet detection does not accept unrelated browser windows', () => {
  assert.equal(isSupportedMeetingWindow('chrome', 'New Tab - Google Chrome'), false);
  assert.equal(isSupportedMeetingWindow('chrome', 'Google Docs - abc-defg-hij'), false);
  assert.equal(isSupportedMeetingWindow('chrome', 'Meet settings - Google Chrome'), false);
});


test('normalizes all top-level browser windows instead of relying on one process main title', () => {
  const windows = normalizeMeetingWindows([
    { pid: 36380, processName: 'chrome', title: 'New Tab - Google Chrome', foreground: true },
    { pid: 36380, processName: 'chrome', title: 'Meet - fai-wivv-szk - Google Chrome', foreground: false },
    { pid: 36380, processName: 'chrome', title: 'Google Docs', foreground: false },
  ]);

  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0], {
    pid: 36380,
    processName: 'chrome',
    title: 'Meet - fai-wivv-szk',
    foreground: false,
  });
});

test('normalizes a single PowerShell window object as well as an array', () => {
  const window = normalizeMeetingWindows({
    pid: 42, processName: 'chrome', title: 'Meet - emh-saes-zmn', foreground: true,
  });
  assert.equal(window.length, 1);
  assert.equal(window[0].title, 'Meet - emh-saes-zmn');
});


test('desktop window snapshot retains ordinary browser tabs for continuity checks', () => {
  const windows = normalizeDesktopWindows([
    { pid: 36380, processName: 'chrome', title: 'Docs - Google Chrome', foreground: true },
    { pid: 36380, processName: 'chrome', title: 'Meet - fai-wivv-szk - Google Chrome', foreground: false },
    { pid: 99, processName: 'notepad', title: 'Notes', foreground: false },
  ]);
  assert.equal(windows.length, 3);
  assert.equal(windows[0].title, 'Docs');
  assert.equal(normalizeMeetingWindows(windows).length, 1);
});

test('a temporary title change does not count as a missing browser process window', () => {
  const windows = normalizeDesktopWindows([
    { pid: 36380, processName: 'chrome', title: 'Calendar - Google Chrome', foreground: true },
  ]);
  assert.equal(hasSameBrowserProcessWindow(windows, {
    processId: 36380, processName: 'chrome', sessionKey: 'meet:fai-wivv-szk',
  }), true);
});
