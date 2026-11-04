import test from 'node:test';
import assert from 'node:assert/strict';
import { planAutoCaptureEnd, hashMeetingIdentity, restartBlockMatchesIdentity } from '../meeting-control.mjs';

const capture = {
  meetingId: 'meeting-1', processId: 4242, provider: 'google_meet', windowId: 'hwnd-1', sessionKey: 'meet:abc-defg-hij',
};

test('End Meeting plans to stop only the exact active auto-capture session and blocks immediate restart', () => {
  const plan = planAutoCaptureEnd('meeting-1', capture, 10_000, 600_000);
  assert.equal(plan.ok, true);
  assert.equal(plan.shouldStop, true);
  assert.deepEqual(plan.restartBlock, { pid: 4242, provider: 'google_meet', key: 'meet:abc-defg-hij', windowId: 'hwnd-1', until: 610_000 });
});

test('ending an older history row does not stop a different currently captured meeting', () => {
  const plan = planAutoCaptureEnd('old-meeting', capture, 10_000, 600_000);
  assert.equal(plan.ok, true);
  assert.equal(plan.shouldStop, false);
  assert.equal(plan.reason, 'capture-session-mismatch');
  assert.equal(plan.restartBlock, null);
});

test('End Meeting can still finalize a database session when no desktop stream is active', () => {
  const plan = planAutoCaptureEnd('meeting-1', null, 10_000, 600_000);
  assert.equal(plan.ok, true);
  assert.equal(plan.shouldStop, false);
  assert.equal(plan.restartBlock, null);
});


test('cross-provider handoff waits for two foreground observations and stale meeting-side audio', async () => {
  const { CrossProviderHandoffTracker } = await import('../meeting-control.mjs');
  const tracker = new CrossProviderHandoffTracker({ quietMs: 30_000, confirmations: 2, candidateWindowMs: 15_000 });
  const current = { provider: 'google_meet', processId: 1000, processName: 'chrome', sessionKey: 'meet:abc-defg-hij', detectionState: 'meeting-window-confirmed' };
  const rows = [
    { provider: 'google_meet', pid: 1000, identityKey: 'meet:abc-defg-hij', foreground: false, state: 'active', confidence: 'high' },
    { provider: 'zoom', pid: 2000, identityKey: 'zoom:team sync', foreground: true, state: 'candidate', confidence: 'medium' },
  ];
  assert.equal(tracker.observe(rows, current, { now: 45_000, lastMeetingAudioAt: 10_000, transitionType: 'same-window' }), null);
  const result = tracker.observe(rows, current, { now: 47_500, lastMeetingAudioAt: 10_000, transitionType: 'same-window' });
  assert.equal(result.provider, 'zoom');
  assert.equal(result.pid, 2000);
});

test('cross-provider handoff does not use microphone activity as meeting-side activity', async () => {
  const { CrossProviderHandoffTracker } = await import('../meeting-control.mjs');
  const tracker = new CrossProviderHandoffTracker({ quietMs: 30_000, confirmations: 1 });
  const current = { provider: 'google_meet', processId: 1000, sessionKey: 'meet:abc-defg-hij' };
  const rows = [{ provider: 'zoom', pid: 2000, identityKey: 'zoom:*', foreground: true, state: 'candidate', confidence: 'medium' }];
  assert.equal(tracker.observe(rows, current, { now: 100_000, lastMeetingAudioAt: 90_000, lastMicAudibleAt: 99_000, transitionType: 'missing' }), null);
});

test('cross-provider handoff requires the old meeting to be backgrounded', async () => {
  const { CrossProviderHandoffTracker } = await import('../meeting-control.mjs');
  const tracker = new CrossProviderHandoffTracker({ quietMs: 30_000, confirmations: 1 });
  const current = { provider: 'google_meet', processId: 1000, sessionKey: 'meet:abc-defg-hij' };
  const rows = [
    { provider: 'google_meet', pid: 1000, identityKey: 'meet:abc-defg-hij', foreground: true, state: 'active', confidence: 'high' },
    { provider: 'zoom', pid: 2000, identityKey: 'zoom:*', foreground: true, state: 'candidate', confidence: 'medium' },
  ];
  assert.equal(tracker.observe(rows, current, { now: 100_000, lastMeetingAudioAt: 10_000, transitionType: 'same-window' }), null);
});

test('cross-provider handoff ignores a candidate blocked by a previous End Meeting action', async () => {
  const { CrossProviderHandoffTracker } = await import('../meeting-control.mjs');
  const tracker = new CrossProviderHandoffTracker({ quietMs: 30_000, confirmations: 1 });
  const current = { provider: 'zoom', processId: 2000, sessionKey: 'zoom:*' };
  const rows = [{ provider: 'google_meet', pid: 1000, identityKey: 'meet:abc-defg-hij', foreground: true, state: 'candidate', confidence: 'high' }];
  assert.equal(tracker.observe(rows, current, { now: 100_000, lastMeetingAudioAt: 10_000, transitionType: 'missing', restartBlock: { pid: 1000, key: 'meet:abc-defg-hij', until: 200_000 } }), null);
});

test('cross-provider candidate title changes do not reset confirmation for the same provider process', async () => {
  const { CrossProviderHandoffTracker } = await import('../meeting-control.mjs');
  const tracker = new CrossProviderHandoffTracker({ quietMs: 30_000, confirmations: 2, candidateWindowMs: 15_000 });
  const current = { provider: 'google_meet', processId: 1000, sessionKey: 'meet:abc-defg-hij' };
  const first = [{ provider: 'zoom', pid: 2000, identityKey: 'zoom:avantika pandey meeting', foreground: true, state: 'candidate', confidence: 'medium' }];
  const second = [{ provider: 'zoom', pid: 2000, identityKey: 'zoom:*', foreground: true, state: 'candidate', confidence: 'medium' }];
  assert.equal(tracker.observe(first, current, { now: 45_000, lastMeetingAudioAt: 10_000, transitionType: 'missing' }), null);
  assert.equal(tracker.observe(second, current, { now: 47_500, lastMeetingAudioAt: 10_000, transitionType: 'missing' }).identityKey, 'zoom:*');
});

 test('a missing current Meet window can hand off to a stable foreground native meeting', async () => {
  const { CrossProviderHandoffTracker } = await import('../meeting-control.mjs');
  const tracker = new CrossProviderHandoffTracker({ quietMs: 30_000, confirmations: 2, candidateWindowMs: 15_000 });
  const current = { provider: 'google_meet', processId: 1000, sessionKey: 'meet:abc-defg-hij', detectionState: 'browser-tab-unverified' };
  const rows = [{ provider: 'zoom', pid: 2000, identityKey: 'zoom:*', foreground: true, state: 'candidate', confidence: 'medium' }];
  assert.equal(tracker.observe(rows, current, { now: 50_000, lastMeetingAudioAt: 10_000, transitionType: 'missing' }), null);
  assert.equal(tracker.observe(rows, current, { now: 52_500, lastMeetingAudioAt: 10_000, transitionType: 'missing' }).provider, 'zoom');
});


test('restart blocks accumulate instead of replacing a previously ended provider', async () => {
  const { addRestartBlock } = await import('../meeting-control.mjs');
  const { selectStartCandidate } = await import('../capture-policy.mjs');
  let blocks = addRestartBlock([], { pid: 1, provider: 'google_meet', key: 'meet:old', windowId: 'hwnd-meet', until: 10_000 });
  blocks = addRestartBlock(blocks, { pid: 2, provider: 'zoom', key: 'zoom:old', windowId: 'hwnd-zoom', until: 10_000 });
  assert.equal(blocks.length, 2);
  const keyOf = (row) => row.identityKey;
  const oldMeet = { pid: 1, provider: 'google_meet', identityKey: 'meet:old', windowId: 'hwnd-meet', foreground: false };
  const teams = { pid: 3, provider: 'teams', identityKey: 'teams:new', windowId: 'hwnd-teams', foreground: true, confidence: 'medium' };
  const selected = selectStartCandidate([oldMeet, teams], blocks, 500, keyOf);
  assert.equal(selected.candidate, teams);
  assert.equal(selected.blocks.length, 2);
});

test('a suppression remains while its original HWND exists, then releases after two missing scans', async () => {
  const { reconcileRestartBlocks } = await import('../meeting-control.mjs');
  let blocks = [{ pid: 1, provider: 'google_meet', key: 'meet:old', windowId: 'hwnd-1', until: 10_000 }];
  blocks = reconcileRestartBlocks(blocks, [{ pid: 1, windowId: 'hwnd-1' }], 100);
  assert.equal(blocks.length, 1);
  blocks = reconcileRestartBlocks(blocks, [], 200);
  assert.equal(blocks.length, 1);
  blocks = reconcileRestartBlocks(blocks, [], 300);
  assert.equal(blocks.length, 0);
});

test('a persisted stable meeting suppression applies after the browser process changes', async () => {
  const { selectStartCandidate } = await import('../meeting-control.mjs');
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
    identityKey: 'meet:abc-defg-hij',
    windowId: 'hwnd-new',
    foreground: true,
    state: 'candidate',
    confidence: 'high',
  };

  assert.equal(
    selectStartCandidate([relaunchedBrowserMeeting], [persistedBlock], 500, (row) => row.identityKey).candidate,
    null,
  );
});

test('a durable meeting suppression survives loss of its original HWND until expiry', async () => {
  const { reconcileRestartBlocks } = await import('../meeting-control.mjs');
  let blocks = [{
    pid: 4242,
    provider: 'google_meet',
    key: 'meet:abc-defg-hij',
    windowId: 'hwnd-old',
    until: 10_000,
  }];

  blocks = reconcileRestartBlocks(blocks, [{ pid: 9911, windowId: 'hwnd-new' }], 100);
  blocks = reconcileRestartBlocks(blocks, [{ pid: 9911, windowId: 'hwnd-new' }], 200);
  assert.equal(blocks.length, 1);
  blocks = reconcileRestartBlocks(blocks, [], 10_000);
  assert.equal(blocks.length, 0);
});


test('restart block identity matcher supports raw and privacy-hashed identities', () => {
  const identity = 'meet:abc-defg-hij';
  assert.equal(restartBlockMatchesIdentity({ key: identity }, identity), true);
  assert.equal(restartBlockMatchesIdentity({ identityHash: hashMeetingIdentity(identity) }, identity), true);
  assert.equal(restartBlockMatchesIdentity({ identityHash: hashMeetingIdentity(identity) }, 'meet:other-code'), false);
  assert.equal(restartBlockMatchesIdentity({ key: identity }, ''), false);
});


test('an explicitly ended Webex call stays suppressed after its original HWND is recreated', async () => {
  const { addRestartBlock, reconcileRestartBlocks, selectStartCandidate } = await import('../meeting-control.mjs');
  const key = 'webex:window:18760:10093378';
  const block = {
    pid: 18760,
    provider: 'webex',
    key,
    windowId: '10093378',
    until: 600_000,
  };
  let blocks = addRestartBlock([], block);

  // The original HWND has disappeared; the same call now has a replacement HWND.
  blocks = reconcileRestartBlocks(blocks, [{ pid: 18760, windowId: '33951164' }], 1_000);
  blocks = reconcileRestartBlocks(blocks, [{ pid: 18760, windowId: '33951164' }], 2_000);
  assert.equal(blocks.length, 1);

  const sameCall = {
    pid: 18760,
    provider: 'webex',
    identityKey: key,
    windowId: '33951164',
    foreground: true,
    state: 'active',
    confidence: 'high',
  };
  assert.equal(selectStartCandidate([sameCall], blocks, 3_000, (row) => row.identityKey).candidate, null);
});

test('a new Webex call epoch is not suppressed by the previous call End Meeting block', async () => {
  const { selectStartCandidate } = await import('../meeting-control.mjs');
  const oldCallBlock = {
    pid: 18760,
    provider: 'webex',
    key: 'webex:window:18760:10093378',
    windowId: '10093378',
    until: 600_000,
  };
  const nextCall = {
    pid: 18760,
    provider: 'webex',
    identityKey: 'webex:window:18760:10093378-call2',
    windowId: '33951164',
    foreground: true,
    state: 'active',
    confidence: 'high',
  };
  assert.equal(
    selectStartCandidate([nextCall], [oldCallBlock], 3_000, (row) => row.identityKey).candidate,
    nextCall,
  );
});
