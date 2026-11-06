import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWindowTransition, isDurableMeetingKey, meetingKey, meetingCaptureKey, SessionContinuity, hasSameBrowserProcessWindow, shouldKeepBrowserCaptureDuringTabSwitch } from '../meeting-session.mjs';

test('a Google Meet code gives the same key regardless of tab title noise or browser', () => {
  const a = meetingKey('chrome', '(2) Meet - abc-defg-hij - Google Chrome');
  const b = meetingKey('msedge', 'Meet – ABC-DEFG-HIJ – Microsoft Edge');
  assert.equal(a, 'meet:abc-defg-hij');
  assert.equal(b, a);
});

test('generic native application titles use a wildcard, but meaningful meeting titles stay distinct', () => {
  assert.equal(meetingKey('Zoom', 'Zoom Meeting'), 'zoom:*');
  assert.notEqual(meetingKey('zoom.exe', "Avantika Pandey's Zoom Meeting"), 'zoom:*');
  assert.notEqual(meetingKey('ms-teams', 'Sprint sync | Microsoft Teams'), meetingKey('teams', 'Retro | Microsoft Teams'));
});

test('browser call timers and notification counters do not change the key', () => {
  assert.equal(
    meetingKey('chrome', '(3) Sprint sync 00:12:31 - Google Chrome'),
    meetingKey('chrome', 'Sprint sync 00:45:02 - Google Chrome'),
  );
  assert.notEqual(meetingKey('chrome', 'Standup - Google Chrome'), meetingKey('chrome', 'Retro - Google Chrome'));
});

test('different apps never share a key', () => {
  assert.notEqual(meetingKey('zoom', 'Zoom Meeting'), meetingKey('ms-teams', 'Meeting'));
});

test('returning to the same meeting inside the grace period reuses the session', () => {
  let clock = 0;
  const continuity = new SessionContinuity({ graceMs: 300_000, now: () => clock });
  continuity.defer({ meetingId: 'm1', key: 'meet:abc-defg-hij', title: 'Meet' });
  clock = 120_000;
  const claimed = continuity.claim('meet:abc-defg-hij');
  assert.equal(claimed.meetingId, 'm1');
  assert.equal(continuity.pending, null);
});

test('a different meeting, or a late return, does not reuse the session', () => {
  let clock = 0;
  const continuity = new SessionContinuity({ graceMs: 300_000, now: () => clock });
  continuity.defer({ meetingId: 'm1', key: 'meet:abc-defg-hij', title: 'Meet' });
  assert.equal(continuity.claim('meet:zzz-zzzz-zzz'), null);
  assert.equal(continuity.pending.meetingId, 'm1'); // still waiting to be ended
  clock = 300_001;
  assert.equal(continuity.claim('meet:abc-defg-hij'), null);
  assert.equal(continuity.isExpired(), true);
});

test('deferring a second session reports the superseded one so it can be ended', () => {
  const continuity = new SessionContinuity();
  assert.equal(continuity.defer({ meetingId: 'm1', key: 'a', title: 'A' }), null);
  assert.equal(continuity.defer({ meetingId: 'm2', key: 'b', title: 'B' }).meetingId, 'm1');
  assert.equal(continuity.defer({ meetingId: 'm2', key: 'b', title: 'B' }), null);
  assert.equal(continuity.release().meetingId, 'm2');
  assert.equal(continuity.release(), null);
});

test('a matching process ID cannot reclaim a different meeting identity', () => {
  let clock = 0;
  const continuity = new SessionContinuity({ graceMs: 300_000, sameProcessGraceMs: 120_000, now: () => clock });
  continuity.defer({ meetingId: 'm1', key: 'meet:abc-defg-hij', title: 'Meet A', pid: 4242 });
  clock = 60_000;
  assert.equal(continuity.claim('meet:zzz-zzzz-zzz', { pid: 4242 }), null);
  assert.equal(continuity.pending.meetingId, 'm1');
});

test('the same stable meeting ID can resume after a browser process changes', () => {
  let clock = 0;
  const continuity = new SessionContinuity({ graceMs: 300_000, now: () => clock });
  continuity.defer({ meetingId: 'm1', key: 'meet:abc-defg-hij', title: 'Meet', pid: 4242 });
  clock = 60_000;
  assert.equal(continuity.claim('meet:abc-defg-hij', { pid: 9911 }).meetingId, 'm1');
});

test('durable meeting keys require an explicit call identifier', () => {
  assert.equal(isDurableMeetingKey('meet:abc-defg-hij'), true);
  assert.equal(isDurableMeetingKey('zoom:id:123456789'), true);
  assert.equal(isDurableMeetingKey('zoom:*'), false);
  assert.equal(isDurableMeetingKey('browser:weekly sync'), false);
});

test('a different process, or a late same-process return with a new title, starts a new session', () => {
  let clock = 0;
  const continuity = new SessionContinuity({ graceMs: 300_000, sameProcessGraceMs: 120_000, now: () => clock });
  continuity.defer({ meetingId: 'm1', key: 'meet:abc-defg-hij', title: 'Meet', pid: 4242 });
  assert.equal(continuity.claim('meet:zzz-zzzz-zzz', { pid: 9999 }), null);
  clock = 130_000;
  assert.equal(continuity.claim('meet:zzz-zzzz-zzz', { pid: 4242 }), null);
  assert.equal(continuity.claim('meet:abc-defg-hij', { pid: 4242 }).meetingId, 'm1'); // same key still fine
});

import { graceForKey } from '../meeting-session.mjs';

test('native apps get a shorter grace period than browser meetings', () => {
  const grace = { browserMs: 300_000, nativeMs: 60_000 };
  assert.equal(graceForKey('zoom:*', grace), 60_000);
  assert.equal(graceForKey('teams:sprint sync', grace), 60_000);
  assert.equal(graceForKey('meet:abc-defg-hij', grace), 300_000);
  assert.equal(graceForKey('browser:*', grace), 300_000);
});

test('a session deferred with a short grace cannot be reclaimed after it', () => {
  let clock = 0;
  const continuity = new SessionContinuity({ graceMs: 300_000, now: () => clock });
  continuity.defer({ meetingId: 'm1', key: 'zoom:*', title: 'Zoom', pid: 7, graceMs: 60_000 });
  clock = 61_000;
  assert.equal(continuity.claim('zoom:*', { pid: 7 }), null);
  assert.equal(continuity.isExpired(), true);
});

test('a new Zoom process never reclaims the previous Zoom meeting, even with the same key', () => {
  let clock = 0;
  const continuity = new SessionContinuity({ graceMs: 300_000, now: () => clock });
  continuity.defer({ meetingId: 'm1', key: 'zoom:*', title: 'Zoom Meeting', pid: 31308, graceMs: 60_000 });
  clock = 20_000;
  assert.equal(continuity.claim('zoom:*', { pid: 31980 }), null);
  assert.equal(continuity.claim('zoom:*', { pid: 31308 }).meetingId, 'm1');
});


test('Google Meet upgrades a generic browser identity to its call ID without splitting the session', () => {
  const current = { processId: 4242, processName: 'chrome', sessionKey: meetingKey('chrome', 'Google Meet') };
  assert.equal(current.sessionKey, 'browser:*');

  const matches = [{ pid: 4242, processName: 'chrome', title: 'Meet - fai-wivv-szk - Google Chrome' }];
  const result = classifyWindowTransition(matches, current);

  assert.equal(result.type, 'same-meeting-identity-upgrade');
  assert.equal(result.sessionKey, 'meet:fai-wivv-szk');
  assert.equal(result.window, matches[0]);
});

test('a different browser process cannot promote a provisional Google Meet identity', () => {
  const current = { processId: 4242, processName: 'chrome', sessionKey: 'browser:*' };
  const matches = [{ pid: 9911, processName: 'chrome', title: 'Meet - fai-wivv-szk - Google Chrome' }];
  assert.equal(classifyWindowTransition(matches, current).type, 'missing');
});

test('window transition detects a different explicit meeting in the same browser process', () => {
  const current = { processId: 4242, processName: 'chrome', sessionKey: 'meet:abc-defg-hij' };
  const matches = [{ pid: 4242, processName: 'chrome', title: 'Meet - zzz-zzzz-zzz - Google Chrome' }];
  const result = classifyWindowTransition(matches, current);
  assert.equal(result.type, 'different-meeting');
  assert.equal(meetingKey(result.window.processName, result.window.title), 'meet:zzz-zzzz-zzz');
});

test('window transition resumes the same explicit meeting after a browser process changes', () => {
  const current = { processId: 4242, processName: 'chrome', sessionKey: 'meet:abc-defg-hij' };
  const matches = [{ pid: 9911, processName: 'chrome', title: 'Meet - abc-defg-hij - Google Chrome' }];
  assert.equal(classifyWindowTransition(matches, current).type, 'same-meeting-new-process');
});

test('window transition ignores an unrelated generic browser title as proof of identity', () => {
  const current = { processId: 4242, processName: 'chrome', sessionKey: 'meet:abc-defg-hij' };
  const matches = [{ pid: 4242, processName: 'chrome', title: 'New Tab - Google Chrome' }];
  assert.equal(classifyWindowTransition(matches, current).type, 'missing');
});


test('an explicit meeting ID can resume when the user moves from Chrome to Edge', () => {
  const current = { processId: 4242, processName: 'chrome', sessionKey: 'meet:abc-defg-hij' };
  const matches = [{ pid: 9911, processName: 'msedge', title: 'Meet - abc-defg-hij - Microsoft Edge' }];
  assert.equal(classifyWindowTransition(matches, current).type, 'same-meeting-new-process');
});

test('does not guess which of multiple background Google Meet calls belongs to a provisional window', () => {
  const current = { processId: 4242, processName: 'chrome', sessionKey: 'browser:*' };
  const matches = [
    { pid: 4242, processName: 'chrome', title: 'Meet - fai-wivv-szk', foreground: false },
    { pid: 4242, processName: 'chrome', title: 'Meet - emh-saes-zmn', foreground: false },
  ];
  assert.equal(classifyWindowTransition(matches, current).type, 'missing');
});

test('uses the sole foreground Google Meet call when multiple calls share one browser process', () => {
  const current = { processId: 4242, processName: 'chrome', sessionKey: 'browser:*' };
  const matches = [
    { pid: 4242, processName: 'chrome', title: 'Meet - fai-wivv-szk', foreground: false },
    { pid: 4242, processName: 'chrome', title: 'Meet - emh-saes-zmn', foreground: true },
  ];
  const result = classifyWindowTransition(matches, current);
  assert.equal(result.type, 'same-meeting-identity-upgrade');
  assert.equal(result.sessionKey, 'meet:emh-saes-zmn');
});

test('a descriptive Google Meet page-title fallback upgrades from the same HWND only', () => {
  const current = {
    processId: 35724,
    processName: 'msedge',
    provider: 'google_meet',
    windowId: 'edge-meet-hwnd',
    sessionKey: 'browser:google meet: online web and video conferencing calls',
  };
  const sameWindow = {
    pid: 35724,
    processName: 'msedge',
    provider: 'google_meet',
    windowId: 'edge-meet-hwnd',
    title: 'Meet - fai-wivv-szk - Microsoft Edge',
    foreground: true,
  };

  const result = classifyWindowTransition([sameWindow], current);
  assert.equal(result.type, 'same-meeting-identity-upgrade');
  assert.equal(result.sessionKey, 'meet:fai-wivv-szk');
  assert.equal(result.window, sameWindow);
});

test('a descriptive Google Meet fallback never borrows a call ID from another HWND', () => {
  const current = {
    processId: 35724,
    processName: 'msedge',
    provider: 'google_meet',
    windowId: 'edge-page-hwnd',
    sessionKey: 'browser:google meet: online web and video conferencing calls',
  };
  const anotherWindow = {
    pid: 35724,
    processName: 'msedge',
    provider: 'google_meet',
    windowId: 'edge-call-hwnd',
    title: 'Meet - fai-wivv-szk - Microsoft Edge',
    foreground: true,
  };

  assert.equal(classifyWindowTransition([anotherWindow], current).type, 'missing');
});


test('same Chrome process remains a continuity signal when the selected tab title changes', () => {
  const current = { processId: 36380, processName: 'chrome', sessionKey: 'meet:fai-wivv-szk' };
  assert.equal(hasSameBrowserProcessWindow([
    { pid: 36380, processName: 'chrome', title: 'Google Docs', foreground: true },
  ], current), true);
});

test('a different browser process does not keep the old meeting alive', () => {
  const current = { processId: 36380, processName: 'chrome', sessionKey: 'meet:fai-wivv-szk' };
  assert.equal(hasSameBrowserProcessWindow([
    { pid: 9911, processName: 'chrome', title: 'New Tab', foreground: true },
  ], current), false);
});

test('a native application process is not treated as a browser-tab continuity signal', () => {
  const current = { processId: 36380, processName: 'zoom', sessionKey: 'zoom:*' };
  assert.equal(hasSameBrowserProcessWindow([
    { pid: 36380, processName: 'zoom', title: 'Zoom Workplace', foreground: true },
  ], current), false);
});


test('the browser continuity fallback applies only to an unverified/missing transition', () => {
  const current = { processId: 36380, processName: 'chrome', sessionKey: 'meet:fai-wivv-szk' };
  const sameProcessOtherTab = [
    { pid: 36380, processName: 'chrome', title: 'Calendar', foreground: true },
  ];
  assert.equal(shouldKeepBrowserCaptureDuringTabSwitch('missing', sameProcessOtherTab, current), true);
  assert.equal(shouldKeepBrowserCaptureDuringTabSwitch('different-meeting', sameProcessOtherTab, current), false);
  assert.equal(shouldKeepBrowserCaptureDuringTabSwitch('same-window', sameProcessOtherTab, current), false);
  assert.equal(shouldKeepBrowserCaptureDuringTabSwitch('missing', [], current), false);
});


test('an explicit left/ended observation ends the matching active meeting before same-window continuity', () => {
  const current = {
    processId: 4242, processName: 'chrome', provider: 'google_meet',
    sessionKey: 'meet:abc-defg-hij',
  };
  const ended = {
    pid: 4242, processName: 'chrome', provider: 'google_meet',
    title: 'Meet - abc-defg-hij', state: 'left',
  };
  assert.equal(classifyWindowTransition([ended], current).type, 'meeting-ended');
});

test('a generic terminal surface is accepted only when one same-provider window is unambiguous', () => {
  const current = {
    processId: 4242, processName: 'chrome', provider: 'google_meet',
    sessionKey: 'meet:abc-defg-hij',
  };
  const ended = { pid: 4242, processName: 'chrome', provider: 'google_meet', title: 'Google Meet', state: 'ended' };
  assert.equal(classifyWindowTransition([ended], current).type, 'meeting-ended');
  const secondCall = { ...ended, title: 'Meet - zzz-zzzz-zzz', state: 'candidate' };
  const result = classifyWindowTransition([ended, secondCall], current);
  assert.equal(result.type, 'different-meeting');
  assert.equal(result.window, secondCall);
});

test('an explicit terminal state on the captured HWND wins even when another same-provider call is visible', () => {
  const current = {
    processId: 4242, processName: 'chrome', provider: 'google_meet',
    sessionKey: 'meet:abc-defg-hij', windowId: '1001',
  };
  const ended = {
    pid: 4242, processName: 'chrome', provider: 'google_meet',
    title: 'Google Meet', state: 'left', windowId: '1001',
  };
  const otherCall = {
    pid: 4242, processName: 'chrome', provider: 'google_meet',
    title: 'Meet - zzz-zzzz-zzz', state: 'candidate', windowId: '1002',
  };
  const result = classifyWindowTransition([ended, otherCall], current);
  assert.equal(result.type, 'meeting-ended');
  assert.equal(result.window, ended);
});


test('native Zoom recovery key is stable across descriptive-title to generic-title changes on the same HWND', () => {
  const first = {
    provider: 'zoom', source: 'native_window', pid: 34404, processId: 34404,
    windowId: '50122', processName: 'Zoom', identityKey: "zoom:avantika pandey's zoom meeting",
    title: "Avantika Pandey's Zoom Meeting",
  };
  const afterRestart = {
    provider: 'zoom', source: 'native_window', pid: 34404, processId: 34404,
    windowId: '50122', processName: 'Zoom', identityKey: 'zoom:*', title: 'Zoom Meeting',
  };
  assert.equal(meetingCaptureKey(first), 'zoom:window:34404:50122');
  assert.equal(meetingCaptureKey(afterRestart), meetingCaptureKey(first));
  assert.equal(isDurableMeetingKey(meetingCaptureKey(first)), true);
});

test('native Zoom meeting title fallback on same HWND remains the same in-process window', () => {
  const current = {
    processId: 34404, processName: 'Zoom', provider: 'zoom',
    sessionKey: "zoom:avantika pandey's zoom meeting", windowId: '50122',
  };
  const generic = {
    pid: 34404, processName: 'Zoom', provider: 'zoom', source: 'native_window',
    identityKey: 'zoom:*', title: 'Zoom Meeting', windowId: '50122', foreground: true,
  };
  assert.equal(classifyWindowTransition([generic], current).type, 'same-window');
});


test('Webex replacement HWND with the same canonical call identity continues the current capture', () => {
  const current = {
    processId: 18760,
    processName: 'CiscoCollabHost',
    provider: 'webex',
    sessionKey: 'webex:window:18760:3413572',
    windowId: '3413572',
  };
  const replacement = {
    pid: 18760,
    processName: 'CiscoCollabHost',
    provider: 'webex',
    source: 'native_window',
    identityKey: 'webex:window:18760:3413572',
    windowId: '3348120',
    state: 'active',
    foreground: false,
  };
  const transition = classifyWindowTransition([replacement], current);
  assert.equal(transition.type, 'same-window');
  assert.equal(transition.window.windowId, '3348120');
});

test('a new Webex call epoch after an observed end is classified as a different meeting', () => {
  const current = {
    processId: 18760,
    processName: 'CiscoCollabHost',
    provider: 'webex',
    sessionKey: 'webex:window:18760:3413572',
    windowId: '3413572',
  };
  const nextCall = {
    pid: 18760,
    processName: 'CiscoCollabHost',
    provider: 'webex',
    source: 'native_window',
    identityKey: 'webex:window:18760:3348120-call2',
    windowId: '3348120',
    state: 'active',
    foreground: true,
  };
  const transition = classifyWindowTransition([nextCall], current);
  assert.equal(transition.type, 'different-meeting');
});

test('Webex HWND recreation keeps the same backend recovery capture key', () => {
  const before = {
    provider: 'webex', source: 'native_window', pid: 18760, processId: 18760,
    processName: 'CiscoCollabHost', windowId: '3413572',
    identityKey: 'webex:window:18760:3413572',
  };
  const after = {
    ...before,
    windowId: '3348120',
  };
  assert.equal(meetingCaptureKey(before), 'webex:window:18760:3413572');
  assert.equal(meetingCaptureKey(after), meetingCaptureKey(before));
});


test('Webex call-epoch recovery keys remain durable and distinct after a confirmed end', () => {
  const newCall = {
    provider: 'webex', source: 'native_window', pid: 18760, processId: 18760,
    processName: 'CiscoCollabHost', windowId: '3348120',
    identityKey: 'webex:window:18760:3348120-call2',
  };
  assert.equal(isDurableMeetingKey(newCall.identityKey), true);
  assert.equal(meetingCaptureKey(newCall), 'webex:window:18760:3348120-call2');
});
