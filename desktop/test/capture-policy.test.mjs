import test from 'node:test';
import assert from 'node:assert/strict';
import { captureStopReason, selectStartCandidate, isSupportedMeetingWindow, normalizeDesktopWindows, normalizeMeetingWindows, findAmbiguousMeetingProcessIds } from '../capture-policy.mjs';
import { hasSameBrowserProcessWindow } from '../meeting-session.mjs';
import { MeetingLifecycleRegistry } from '../meeting-lifecycle.mjs';

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


test('microphone-only speech does not keep an ended browser meeting alive', () => {
  const stop = captureStopReason({
    now: 400_000,
    startedAt: 0,
    lastMatchedAt: 400_000,
    lastAudibleAt: 399_000, // microphone remains active after leaving
    lastMeetingAudioAt: 200_000, // no meeting-side audio for 200 seconds
  });
  assert.equal(stop.reason, 'idle');
  assert.equal(stop.activitySource, 'meeting-audio');
});

test('microphone-only startup still gets the longer no-meeting-audio grace', () => {
  const stop = captureStopReason({
    now: 390_000,
    startedAt: 90_000,
    lastMatchedAt: 390_000,
    lastAudibleAt: 389_000,
    lastMeetingAudioAt: 0,
  });
  assert.equal(stop, null);
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
const meet = { pid: 1, provider: 'google_meet', key: 'meet:abc', windowId: 'hwnd-meet', title: 'Meet', foreground: true };
const other = { pid: 2, provider: 'zoom', key: 'zoom:*', windowId: 'hwnd-zoom', title: 'Zoom Meeting', foreground: true };

test('a blocked window is not restarted, but other meetings still are', () => {
  const block = { pid: 1, key: 'meet:abc', until: 1000 };
  assert.equal(selectStartCandidate([meet], block, 500, keyOf).candidate, null);
  assert.equal(selectStartCandidate([meet, other], block, 500, keyOf).candidate, other);
});

test('background observations are never selected as a new capture target', () => {
  const backgroundMeet = { ...meet, foreground: false };
  assert.equal(selectStartCandidate([backgroundMeet], null, 500, keyOf).candidate, null);
});

test('multiple ended meeting blocks are retained when another provider is ended', async () => {
  const { addRestartBlock } = await import('../meeting-control.mjs');
  let blocks = addRestartBlock([], { pid: 1, provider: 'google_meet', key: 'meet:abc', windowId: 'hwnd-meet', until: 5000 });
  blocks = addRestartBlock(blocks, { pid: 2, provider: 'zoom', key: 'zoom:my-call', windowId: 'hwnd-zoom', until: 5000 });
  const teams = { pid: 3, provider: 'teams', key: 'teams:meeting with team', windowId: 'hwnd-teams', title: 'Teams meeting', foreground: true };
  const result = selectStartCandidate([meet, other, teams], blocks, 1000, keyOf);
  assert.equal(result.candidate, teams);
  assert.equal(result.blocks.length, 2);
});

test('an old ended browser meeting is blocked when its title falls back on the same HWND', () => {
  const block = { pid: 1, provider: 'google_meet', key: 'meet:abc', windowId: 'hwnd-meet', until: 1000 };
  const generic = { pid: 1, provider: 'google_meet', key: 'browser:*', windowId: 'hwnd-meet', title: 'Google Meet', foreground: true };
  assert.equal(selectStartCandidate([generic], [block], 500, keyOf).candidate, null);
});

test('a different durable meeting ID in the same browser window is allowed', () => {
  const block = { pid: 1, provider: 'google_meet', key: 'meet:abc-defg-hij', windowId: 'hwnd-meet', until: 1000 };
  const newMeet = { ...meet, key: 'meet:klm-nopq-rst', windowId: 'hwnd-meet' };
  assert.equal(selectStartCandidate([newMeet], [block], 500, keyOf).candidate, newMeet);
});


test('a durable Google Meet suppression still applies after the browser process changes', () => {
  const persistedBlock = {
    pid: 4242,
    provider: 'google_meet',
    key: 'meet:abc-defg-hij',
    windowId: 'hwnd-old',
    until: 10_000,
  };
  const relaunchedBrowserMeeting = {
    pid: 9911,
    provider: 'google_meet',
    key: 'meet:abc-defg-hij',
    windowId: 'hwnd-new',
    foreground: true,
    state: 'candidate',
    confidence: 'high',
  };

  assert.equal(
    selectStartCandidate([relaunchedBrowserMeeting], [persistedBlock], 500, keyOf).candidate,
    null,
  );
});

test('a different durable Google Meet ID in a relaunched browser is not suppressed', () => {
  const persistedBlock = {
    pid: 4242,
    provider: 'google_meet',
    key: 'meet:abc-defg-hij',
    windowId: 'hwnd-old',
    until: 10_000,
  };
  const differentMeeting = {
    pid: 9911,
    provider: 'google_meet',
    key: 'meet:klm-nopq-rst',
    windowId: 'hwnd-new',
    foreground: true,
    state: 'candidate',
    confidence: 'high',
  };

  assert.equal(
    selectStartCandidate([differentMeeting], [persistedBlock], 500, keyOf).candidate,
    differentMeeting,
  );
});


test('a durable meeting suppression remains after the original browser HWND disappears', async () => {
  const { reconcileRestartBlocks } = await import('../meeting-control.mjs');
  const block = {
    pid: 4242,
    provider: 'google_meet',
    key: 'meet:abc-defg-hij',
    windowId: 'hwnd-old',
    until: 10_000,
  };

  const afterBrowserExit = reconcileRestartBlocks([block], [], 500);
  assert.equal(afterBrowserExit.length, 1);

  const afterBrowserRelaunch = reconcileRestartBlocks(
    afterBrowserExit,
    [{ pid: 9911, windowId: 'hwnd-new' }],
    1_000,
  );
  assert.equal(afterBrowserRelaunch.length, 1);
  assert.equal(afterBrowserRelaunch[0].key, 'meet:abc-defg-hij');
});

test('the block expires on its own', () => {
  const block = { pid: 1, key: 'meet:abc', until: 1000 };
  const result = selectStartCandidate([meet], [block], 1000, keyOf);
  assert.equal(result.blocks.length, 0);
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
  assert.equal(isSupportedMeetingWindow('chrome', 'meet.google.com wants to use your microphone'), false);
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
    windowId: null,
    title: 'Meet - fai-wivv-szk',
    foreground: false,
    foregroundProcessId: null,
    foregroundWindowId: null,
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


test('explicitly left or ended provider windows are never selected as new capture targets', () => {
  const leftMeet = { pid: 1, key: 'meet:abc', title: 'Meet', state: 'left' };
  const endedMeet = { pid: 1, key: 'meet:abc', title: 'Meet', state: 'ended' };
  assert.equal(selectStartCandidate([leftMeet], null, 500, keyOf).candidate, null);
  assert.equal(selectStartCandidate([endedMeet, other], null, 500, keyOf).candidate, other);
});


test('normalized desktop snapshots preserve only sanitized Webex UI Automation evidence', () => {
  const rows = normalizeMeetingWindows([{
    pid: 49588,
    processName: 'CiscoCollabHost',
    title: 'Webex',
    foreground: true,
    windowId: 'hwnd-webex',
    webexHostedInstance: true,
    webexExecutablePathVerified: true,
    webexAccessoriesHelper: false,
    webexUiAutomationInspected: true,
    webexMeetingControlsPresent: true,
    commandLine: 'sensitive process command line must not be retained',
  }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].webexHostedInstance, true);
  assert.equal(rows[0].webexExecutablePathVerified, true);
  assert.equal(rows[0].webexUiAutomationInspected, true);
  assert.equal(rows[0].webexMeetingControlsPresent, true);
  assert.equal('commandLine' in rows[0], false);
  assert.equal('executablePath' in rows[0], false);
  assert.equal('webexMeetingProtocol' in rows[0], false);
  assert.equal('webexLaunchFingerprint' in rows[0], false);
});

test('Webex UI Automation failure reason is sanitized and never promoted to meeting evidence', () => {
  const rows = normalizeDesktopWindows([{
    pid: 49588,
    processName: 'CiscoCollabHost',
    title: 'Webex',
    foreground: true,
    windowId: 'hwnd-webex',
    webexHostedInstance: true,
    webexExecutablePathVerified: true,
    webexUiAutomationInspected: false,
    webexUiAutomationError: 'ElementNotAvailableException',
    webexMeetingControlsPresent: true,
  }]);
  assert.equal(rows[0].webexUiAutomationError, 'ElementNotAvailableException');
  assert.equal(rows[0].webexMeetingControlsPresent, undefined);
});

test('a different Webex desktop HWND is not blocked by an ended window-specific block', async () => {
  const { selectStartCandidate } = await import('../capture-policy.mjs');
  const block = { pid: 49588, provider: 'webex', key: 'webex:window:49588:hwnd-old', windowId: 'hwnd-old', until: 5000 };
  const newMeeting = {
    pid: 49588, provider: 'webex', identityKey: 'webex:window:49588:hwnd-new',
    windowId: 'hwnd-new', title: 'Webex', foreground: true,
  };
  assert.equal(selectStartCandidate([newMeeting], [block], 1000, (row) => row.identityKey).candidate, newMeeting);
});


test('Teams browser meeting-join page is a joining observation and foreground PID fallback makes it selectable', async () => {
  const { normalizeMeetingObservations } = await import('../meeting-observation.mjs');
  const rows = normalizeMeetingWindows([{
    pid: 36380,
    processName: 'chrome',
    title: 'Meeting join | Microsoft Teams meeting',
    windowId: '1001',
    foreground: false,
    foregroundProcessId: 36380,
    foregroundWindowId: '9999',
  }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].foreground, true);
  const observations = normalizeMeetingObservations(rows);
  assert.equal(observations[0].state, 'joining');
  assert.equal(selectStartCandidate(observations, null, 500, (row) => row.identityKey).candidate, observations[0]);
});

test('foreground PID fallback never promotes multiple supported meetings in the same browser process', () => {
  const rows = normalizeMeetingWindows([
    { pid: 36380, processName: 'chrome', title: 'Meeting join | Microsoft Teams meeting', windowId: '1001', foreground: false, foregroundProcessId: 36380, foregroundWindowId: '9999' },
    { pid: 36380, processName: 'chrome', title: 'Meeting | Microsoft Teams', windowId: '1002', foreground: false, foregroundProcessId: 36380, foregroundWindowId: '9999' },
    { pid: 36380, processName: 'chrome', title: 'Google Docs', windowId: '1003', foreground: false, foregroundProcessId: 36380, foregroundWindowId: '9999' },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows.some((row) => row.foreground), false);
});

test('exact foreground HWND wins when multiple Chrome meeting windows are present', () => {
  const rows = normalizeMeetingWindows([
    { pid: 36380, processName: 'chrome', title: 'Meeting join | Microsoft Teams meeting', windowId: '1001', foreground: false, foregroundProcessId: 36380, foregroundWindowId: '1002' },
    { pid: 36380, processName: 'chrome', title: 'Meeting | Microsoft Teams', windowId: '1002', foreground: true, foregroundProcessId: 36380, foregroundWindowId: '1002' },
  ]);
  assert.equal(rows.find((row) => row.windowId === '1002').foreground, true);
  assert.equal(rows.find((row) => row.windowId === '1001').foreground, false);
});

test('verified active Webex desktop meeting may start capture even while Contexa owns foreground focus', () => {
  const webex = {
    pid: 18760,
    provider: 'webex',
    source: 'native_window',
    identityKey: 'webex:window:18760:3675996',
    windowId: '3675996',
    state: 'active',
    confidence: 'high',
    foreground: false,
    windowFocus: 'background',
    evidence: [
      { kind: 'process_name', value: 'ciscocollabhost' },
      { kind: 'webex_accessibility', value: 'end-meeting-control-present' },
    ],
  };
  const result = selectStartCandidate([webex], null, 500, (row) => row.identityKey);
  assert.equal(result.candidate, webex);
});

test('idle or unverified background Webex windows remain ineligible for capture', () => {
  const baseWebex = {
    pid: 18760,
    provider: 'webex',
    source: 'native_window',
    identityKey: 'webex:window:18760:3675996',
    windowId: '3675996',
    foreground: false,
    windowFocus: 'background',
  };
  const idle = { ...baseWebex, state: 'background', confidence: 'high', evidence: [] };
  const unverified = {
    ...baseWebex,
    state: 'active',
    confidence: 'high',
    evidence: [{ kind: 'webex_accessibility', value: 'ui-automation-unavailable' }],
  };
  assert.equal(selectStartCandidate([idle], null, 500, (row) => row.identityKey).candidate, null);
  assert.equal(selectStartCandidate([unverified], null, 500, (row) => row.identityKey).candidate, null);
});

test('other provider background meetings remain ineligible even when their state is active', () => {
  const zoom = {
    pid: 3000,
    provider: 'zoom',
    source: 'native_window',
    identityKey: 'zoom:id:123456789',
    state: 'active',
    confidence: 'high',
    foreground: false,
    windowFocus: 'background',
    evidence: [{ kind: 'webex_accessibility', value: 'end-meeting-control-present' }],
  };
  assert.equal(selectStartCandidate([zoom], null, 500, (row) => row.identityKey).candidate, null);
});

test('a new Webex call epoch is not blocked by the previous epoch End Meeting suppression', async () => {
  const { addRestartBlock } = await import('../meeting-control.mjs');
  const { selectStartCandidate } = await import('../capture-policy.mjs');
  const oldKey = 'webex:window:18760:10093378';
  const nextKey = 'webex:window:18760:3348120-call2';
  const blocks = addRestartBlock([], {
    pid: 18760,
    provider: 'webex',
    key: oldKey,
    windowId: '10093378',
    until: 600_000,
  });
  const nextCall = {
    pid: 18760,
    provider: 'webex',
    source: 'native_window',
    identityKey: nextKey,
    windowId: '3348120',
    foreground: false,
    state: 'active',
    confidence: 'high',
    evidence: [{ kind: 'webex_accessibility', value: 'end-meeting-control-present' }],
  };
  assert.equal(selectStartCandidate([nextCall], blocks, 3_000, (row) => row.identityKey).candidate, nextCall);
});

test('start-candidate selection is deterministic when foreground meetings have equal priority', () => {
  const first = { pid: 20, provider: 'google_meet', identityKey: 'meet:abc-defg-hij', windowId: 'hwnd-a', foreground: true, state: 'candidate', confidence: 'high' };
  const second = { pid: 10, provider: 'google_meet', identityKey: 'meet:klm-nopq-rst', windowId: 'hwnd-b', foreground: true, state: 'candidate', confidence: 'high' };
  const select = (rows) => selectStartCandidate(rows, null, 500, (row) => row.identityKey).candidate;

  assert.equal(select([second, first]), first);
  assert.equal(select([first, second]), first);
});

test('active foreground state outranks a newer candidate observation at equal confidence', () => {
  const candidate = { pid: 10, provider: 'zoom', identityKey: 'zoom:id:123456789', foreground: true, state: 'candidate', confidence: 'high', observedAt: 900 };
  const active = { pid: 20, provider: 'teams', identityKey: 'teams:id:123456789', foreground: true, state: 'active', confidence: 'high', observedAt: 800 };
  assert.equal(selectStartCandidate([candidate, active], null, 1000, (row) => row.identityKey).candidate, active);
});


test('auto capture refuses a process that contains multiple independent live meetings', async () => {
  const { findAmbiguousMeetingProcessIds } = await import('../capture-policy.mjs');
  const meetings = [
    { pid: 36380, provider: 'google_meet', identityKey: 'meet:abc-defg-hij', windowId: 'hwnd-a', foreground: true, state: 'candidate', confidence: 'high' },
    { pid: 36380, provider: 'google_meet', identityKey: 'meet:klm-nopq-rst', windowId: 'hwnd-b', foreground: false, state: 'background', confidence: 'high' },
  ];
  assert.deepEqual(findAmbiguousMeetingProcessIds(meetings), [36380]);
  assert.equal(selectStartCandidate(meetings, null, 500, (row) => row.identityKey).candidate, null);
});


test('a same-process meeting becomes selectable after the competing missing window expires', () => {
  const registry = new MeetingLifecycleRegistry({ missingGraceMs: 30_000, retentionMs: 15 * 60_000 });
  const meetingA = {
    pid: 36380, processId: 36380, provider: 'google_meet', source: 'browser_window',
    identityKey: 'meet:abc-defg-hij', durableIdentity: true, windowId: 'hwnd-a',
    state: 'candidate', confidence: 'high', foreground: true, windowFocus: 'foreground',
  };
  const meetingB = {
    pid: 36380, processId: 36380, provider: 'google_meet', source: 'browser_window',
    identityKey: 'meet:klm-nopq-rst', durableIdentity: true, windowId: 'hwnd-b',
    state: 'background', confidence: 'high', foreground: false, windowFocus: 'background',
  };

  registry.update([meetingA, meetingB], { now: 1_000 });
  const duringGrace = registry.update([meetingA], { now: 2_000 }).snapshot;
  assert.deepEqual(findAmbiguousMeetingProcessIds([meetingA, ...duringGrace]), [36380]);
  assert.equal(
    selectStartCandidate([meetingA], null, 2_000, (row) => row.identityKey, duringGrace).candidate,
    null,
  );

  const afterGrace = registry.update([meetingA], { now: 32_001 }).snapshot;
  assert.deepEqual(findAmbiguousMeetingProcessIds([meetingA, ...afterGrace]), []);
  assert.equal(
    selectStartCandidate([meetingA], null, 32_001, (row) => row.identityKey, afterGrace).candidate,
    meetingA,
  );
});

test('a generic background Google Meet surface does not make a known call process ambiguous', async () => {
  const { findAmbiguousMeetingProcessIds } = await import('../capture-policy.mjs');
  const knownCall = {
    pid: 36380, provider: 'google_meet', identityKey: 'meet:abc-defg-hij',
    windowId: 'hwnd-call', foreground: true, state: 'active', confidence: 'high',
  };
  const genericBackground = {
    pid: 36380, provider: 'google_meet', identityKey: 'browser:*',
    windowId: 'hwnd-generic', foreground: false, windowFocus: 'background',
    state: 'background', confidence: 'medium',
  };
  assert.deepEqual(findAmbiguousMeetingProcessIds([knownCall, genericBackground]), []);
  assert.equal(
    selectStartCandidate([knownCall, genericBackground], null, 500, (row) => row.identityKey).candidate,
    knownCall,
  );
});

test('a temporarily missing generic Meet surface does not retain stale foreground ambiguity', async () => {
  const { findAmbiguousMeetingProcessIds } = await import('../capture-policy.mjs');
  const knownCall = {
    pid: 36380, provider: 'google_meet', identityKey: 'meet:abc-defg-hij',
    windowId: 'hwnd-call', foreground: true, state: 'active', confidence: 'high',
  };
  const missingGenericSurface = {
    lifecycleKey: 'google_meet|browser:*',
    provider: 'google_meet',
    identityKey: 'browser:*',
    windows: [{
      pid: 36380,
      windowId: 'hwnd-generic',
      state: 'temporarily_missing',
      foreground: false,
      windowFocus: 'unknown',
    }],
  };
  assert.deepEqual(findAmbiguousMeetingProcessIds([knownCall, missingGenericSurface]), []);
});

test('a foreground generic Google Meet surface alongside another call remains ambiguous', async () => {
  const { findAmbiguousMeetingProcessIds } = await import('../capture-policy.mjs');
  const knownBackgroundCall = {
    pid: 36380, provider: 'google_meet', identityKey: 'meet:abc-defg-hij',
    windowId: 'hwnd-call', foreground: false, state: 'background', confidence: 'high',
  };
  const genericForeground = {
    pid: 36380, provider: 'google_meet', identityKey: 'browser:*',
    windowId: 'hwnd-generic', foreground: true, windowFocus: 'foreground',
    state: 'candidate', confidence: 'medium',
  };
  assert.deepEqual(findAmbiguousMeetingProcessIds([knownBackgroundCall, genericForeground]), [36380]);
});

test('a Google Meet page-title identity is superseded by a call ID on the same PID and HWND', async () => {
  const { findAmbiguousMeetingProcessIds, describeMeetingProcessIdentities } = await import('../capture-policy.mjs');
  const pageTitleFallback = {
    pid: 35724,
    provider: 'google_meet',
    identityKey: 'browser:google meet: online web and video conferencing calls',
    windowId: 'edge-meet-hwnd',
    state: 'temporarily_missing',
    foreground: false,
    windowFocus: 'unknown',
  };
  const identifiedCall = {
    pid: 35724,
    provider: 'google_meet',
    identityKey: 'meet:fai-wivv-szk',
    windowId: 'edge-meet-hwnd',
    state: 'active',
    foreground: true,
    windowFocus: 'foreground',
  };

  assert.deepEqual(findAmbiguousMeetingProcessIds([pageTitleFallback, identifiedCall]), []);
  assert.deepEqual(describeMeetingProcessIdentities([pageTitleFallback, identifiedCall], 35724), [
    'google_meet/meet:fai-wivv-szk:active:foreground:hwnd=edge-meet-hwnd',
  ]);
});

test('a page-title fallback on a different HWND remains ambiguous beside a concrete Google Meet call', async () => {
  const { findAmbiguousMeetingProcessIds } = await import('../capture-policy.mjs');
  const pageTitleFallback = {
    pid: 35724,
    provider: 'google_meet',
    identityKey: 'browser:google meet: online web and video conferencing calls',
    windowId: 'edge-other-hwnd',
    state: 'background',
    foreground: false,
    windowFocus: 'background',
  };
  const identifiedCall = {
    pid: 35724,
    provider: 'google_meet',
    identityKey: 'meet:fai-wivv-szk',
    windowId: 'edge-meet-hwnd',
    state: 'active',
    foreground: true,
    windowFocus: 'foreground',
  };

  assert.deepEqual(findAmbiguousMeetingProcessIds([pageTitleFallback, identifiedCall]), [35724]);
});

test('expired unknown registry entries no longer block an otherwise unambiguous meeting', async () => {
  const { findAmbiguousMeetingProcessIds } = await import('../capture-policy.mjs');
  const current = {
    pid: 36380, provider: 'google_meet', identityKey: 'meet:abc-defg-hij',
    windowId: 'hwnd-a', state: 'active',
  };
  const expired = {
    lifecycleKey: 'google_meet|meet:klm-nopq-rst',
    provider: 'google_meet',
    identityKey: 'meet:klm-nopq-rst',
    windows: [{ pid: 36380, windowId: 'hwnd-b', state: 'unknown' }],
  };
  assert.deepEqual(findAmbiguousMeetingProcessIds([current, expired]), []);
});

test('duplicate windows for one durable meeting do not make process audio ambiguous', async () => {
  const { findAmbiguousMeetingProcessIds } = await import('../capture-policy.mjs');
  const sameMeeting = [
    { pid: 36380, provider: 'google_meet', identityKey: 'meet:abc-defg-hij', windowId: 'hwnd-a', foreground: true, state: 'active', confidence: 'high' },
    { pid: 36380, provider: 'google_meet', identityKey: 'meet:abc-defg-hij', windowId: 'hwnd-b', foreground: false, state: 'background', confidence: 'high' },
  ];
  assert.deepEqual(findAmbiguousMeetingProcessIds(sameMeeting), []);
  assert.equal(selectStartCandidate(sameMeeting, null, 500, (row) => row.identityKey).candidate, sameMeeting[0]);
});

test('ambiguous meeting processes are isolated per PID', async () => {
  const { findAmbiguousMeetingProcessIds } = await import('../capture-policy.mjs');
  const rows = [
    { pid: 1, provider: 'google_meet', identityKey: 'meet:abc-defg-hij', windowId: 'a', foreground: true, state: 'candidate' },
    { pid: 1, provider: 'google_meet', identityKey: 'meet:klm-nopq-rst', windowId: 'b', foreground: false, state: 'background' },
    { pid: 2, provider: 'zoom', identityKey: 'zoom:id:123456789', windowId: 'c', foreground: true, state: 'active' },
  ];
  assert.deepEqual(findAmbiguousMeetingProcessIds(rows), [1]);
  assert.equal(selectStartCandidate(rows, null, 500, (row) => row.identityKey).candidate, rows[2]);
});


test('foreground meeting takes priority over verified-background Webex evidence', () => {
  const webexBackground = {
    pid: 18760,
    provider: 'webex',
    source: 'native_window',
    identityKey: 'webex:window:18760:3675996',
    windowId: '3675996',
    state: 'active',
    confidence: 'high',
    foreground: false,
    windowFocus: 'background',
    evidence: [{ kind: 'webex_accessibility', value: 'end-meeting-control-present' }],
  };
  const foregroundMeet = {
    pid: 36380,
    provider: 'google_meet',
    identityKey: 'meet:abc-defg-hij',
    state: 'candidate',
    confidence: 'medium',
    foreground: true,
  };
  assert.equal(
    selectStartCandidate([webexBackground, foregroundMeet], null, 500, (row) => row.identityKey).candidate,
    foregroundMeet,
  );
});


test('a temporarily missing registry window keeps its process ambiguous until terminal evidence or expiry', async () => {
  const { findAmbiguousMeetingProcessIds } = await import('../capture-policy.mjs');
  const current = {
    pid: 36380, provider: 'google_meet', identityKey: 'meet:abc-defg-hij',
    windowId: 'hwnd-a', state: 'active',
  };
  const retainedRegistryEntry = {
    lifecycleKey: 'google_meet|meet:klm-nopq-rst',
    provider: 'google_meet',
    identityKey: 'meet:klm-nopq-rst',
    windows: [{ pid: 36380, windowId: 'hwnd-b', state: 'temporarily_missing' }],
  };
  assert.deepEqual(findAmbiguousMeetingProcessIds([current, retainedRegistryEntry]), [36380]);

  retainedRegistryEntry.windows[0].state = 'ended';
  assert.deepEqual(findAmbiguousMeetingProcessIds([current, retainedRegistryEntry]), []);
});

test('initial candidate selection ignores retained registry windows after they become unknown', () => {
  const currentObservation = {
    pid: 36380, provider: 'google_meet', identityKey: 'meet:abc-defg-hij',
    windowId: 'hwnd-a', foreground: true, state: 'candidate', confidence: 'high',
  };
  const retainedRegistryEntry = {
    lifecycleKey: 'google_meet|meet:klm-nopq-rst',
    provider: 'google_meet',
    identityKey: 'meet:klm-nopq-rst',
    windows: [{ pid: 36380, windowId: 'hwnd-b', state: 'unknown' }],
  };
  assert.equal(
    selectStartCandidate([currentObservation], null, 500, (row) => row.identityKey, [retainedRegistryEntry]).candidate,
    currentObservation,
  );
});
