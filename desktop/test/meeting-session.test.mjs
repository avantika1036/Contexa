import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWindowTransition, isDurableMeetingKey, meetingKey, SessionContinuity } from '../meeting-session.mjs';

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
