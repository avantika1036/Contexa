import test from 'node:test';
import assert from 'node:assert/strict';
import { WebexMeetingControlTracker } from '../webex-meeting-controls.mjs';

const hostWindow = (overrides = {}) => ({
  pid: 18760,
  processName: 'CiscoCollabHost',
  title: 'Webex',
  windowId: '50122',
  foreground: true,
  webexHostedInstance: true,
  webexExecutablePathVerified: true,
  webexAccessoriesHelper: false,
  webexUiAutomationInspected: true,
  webexMeetingControlsPresent: true,
  ...overrides,
});

test('idle Webex host is not promoted to a meeting before controls have ever appeared', () => {
  const tracker = new WebexMeetingControlTracker();
  const [row] = tracker.update([hostWindow({ webexMeetingControlsPresent: false })], { now: 1000 });
  assert.equal(row.webexMeetingControlsPresent, false);
  assert.equal(row.webexMeetingEnded, false);
});

test('one missing UI Automation scan is debounced; the second produces ended evidence', () => {
  const tracker = new WebexMeetingControlTracker({ missedPollsToEnd: 2 });
  const [active] = tracker.update([hostWindow()], { now: 1000 });
  assert.equal(active.webexMeetingControlsPresent, true);
  assert.equal(active.webexMeetingEnded, false);

  const [transientMiss] = tracker.update([hostWindow({ webexMeetingControlsPresent: false })], { now: 3500 });
  assert.equal(transientMiss.webexMeetingControlsPresent, true);
  assert.equal(transientMiss.webexMeetingEnded, false);

  const [ended] = tracker.update([hostWindow({ webexMeetingControlsPresent: false })], { now: 6000 });
  assert.equal(ended.webexMeetingControlsPresent, false);
  assert.equal(ended.webexMeetingEnded, true);
});

test('UI Automation inspection failure does not count as evidence that the call ended', () => {
  const tracker = new WebexMeetingControlTracker({ missedPollsToEnd: 2 });
  tracker.update([hostWindow()], { now: 1000 });

  const [unknown] = tracker.update([hostWindow({ webexUiAutomationInspected: false, webexMeetingControlsPresent: false })], { now: 3500 });
  assert.equal(unknown.webexMeetingControlsPresent, true);
  assert.equal(unknown.webexMeetingEnded, false);

  const [oneMiss] = tracker.update([hostWindow({ webexMeetingControlsPresent: false })], { now: 6000 });
  assert.equal(oneMiss.webexMeetingControlsPresent, true);
  assert.equal(oneMiss.webexMeetingEnded, false);

  const [ended] = tracker.update([hostWindow({ webexMeetingControlsPresent: false })], { now: 8500 });
  assert.equal(ended.webexMeetingEnded, true);
});

test('the same Webex host HWND can rejoin and restore active meeting evidence', () => {
  const tracker = new WebexMeetingControlTracker({ missedPollsToEnd: 2 });
  tracker.update([hostWindow()], { now: 1000 });
  tracker.update([hostWindow({ webexMeetingControlsPresent: false })], { now: 3500 });
  tracker.update([hostWindow({ webexMeetingControlsPresent: false })], { now: 6000 });

  const [rejoined] = tracker.update([hostWindow()], { now: 8500 });
  assert.equal(rejoined.webexMeetingControlsPresent, true);
  assert.equal(rejoined.webexMeetingEnded, false);
});

test('Webex helper and unverified executable rows are ignored by the tracker', () => {
  const tracker = new WebexMeetingControlTracker();
  const [helper, unverified] = tracker.update([
    hostWindow({ webexAccessoriesHelper: true }),
    hostWindow({ webexExecutablePathVerified: false }),
  ], { now: 1000 });
  assert.equal(helper.webexMeetingEnded, undefined);
  assert.equal(unverified.webexMeetingEnded, undefined);
});


test('a recreated Webex HWND during the same verified active call retains the original call identity anchor', () => {
  const tracker = new WebexMeetingControlTracker({ missedPollsToEnd: 2, windowReplacementGraceMs: 60_000 });
  const [first] = tracker.update([hostWindow({ windowId: '3413572' })], { now: 1_000 });
  assert.equal(first.webexCanonicalWindowId, '3413572');
  assert.equal(first.webexCallEpoch, 1);

  // The native Webex window can temporarily disappear from EnumWindows while the
  // CiscoCollabHost process and actual meeting continue running.
  assert.deepEqual(tracker.update([], { now: 2_000 }), []);

  const [recreated] = tracker.update([hostWindow({ windowId: '3348120' })], { now: 4_000 });
  assert.equal(recreated.webexMeetingControlsPresent, true);
  assert.equal(recreated.webexMeetingEnded, false);
  assert.equal(recreated.webexCanonicalWindowId, '3413572');
  assert.equal(recreated.webexCallEpoch, 1);
  assert.equal(recreated.webexWindowIdentityChanged, true);
});

test('a new Webex call after two successful end-control misses receives a new call epoch', () => {
  const tracker = new WebexMeetingControlTracker({ missedPollsToEnd: 2 });
  const [first] = tracker.update([hostWindow({ windowId: '3413572' })], { now: 1_000 });
  assert.equal(first.webexCanonicalWindowId, '3413572');

  const [firstMiss] = tracker.update([
    hostWindow({ windowId: '3348120', webexMeetingControlsPresent: false }),
  ], { now: 3_500 });
  assert.equal(firstMiss.webexMeetingEnded, false);
  assert.equal(firstMiss.webexCanonicalWindowId, '3413572');

  const [ended] = tracker.update([
    hostWindow({ windowId: '3348120', webexMeetingControlsPresent: false }),
  ], { now: 6_000 });
  assert.equal(ended.webexMeetingEnded, true);
  assert.equal(ended.webexCallEpoch, 1);

  const [newCall] = tracker.update([hostWindow({ windowId: '3348120' })], { now: 8_500 });
  assert.equal(newCall.webexMeetingControlsPresent, true);
  assert.equal(newCall.webexMeetingEnded, false);
  assert.equal(newCall.webexCanonicalWindowId, '3348120');
  assert.equal(newCall.webexCallEpoch, 2);
});

test('Webex process replacement does not merge call identities across different PIDs', () => {
  const tracker = new WebexMeetingControlTracker();
  const [first] = tracker.update([hostWindow({ windowId: '3413572', pid: 18760 })], { now: 1_000 });
  const [second] = tracker.update([hostWindow({ windowId: '3413572', pid: 28760 })], { now: 2_000 });
  assert.equal(first.webexCanonicalWindowId, '3413572');
  assert.equal(second.webexCanonicalWindowId, '3413572');
  assert.equal(first.pid, 18760);
  assert.equal(second.pid, 28760);
});

test('a short complete top-level-window gap preserves the active Webex call identity', () => {
  const tracker = new WebexMeetingControlTracker({ windowAbsenceGraceMs: 20_000 });
  const [first] = tracker.update([hostWindow({ windowId: '3413572' })], { now: 1_000 });
  assert.equal(first.webexCallEpoch, 1);

  tracker.update([], { now: 2_000 });
  tracker.update([], { now: 10_000 });
  const [laterObservation] = tracker.update([hostWindow({ windowId: '3348120' })], { now: 15_000 });
  assert.equal(laterObservation.webexCallEpoch, 1);
  assert.equal(laterObservation.webexCanonicalWindowId, '3413572');
  assert.equal(laterObservation.webexWindowIdentityChanged, true);
});

test('a sustained top-level-window absence ends the Webex call and advances the next call epoch', () => {
  const tracker = new WebexMeetingControlTracker({ missedPollsToEnd: 2, windowAbsenceGraceMs: 20_000 });
  tracker.update([hostWindow({ windowId: '3413572' })], { now: 1_000 });

  tracker.update([], { now: 2_000 });
  tracker.update([], { now: 10_000 });
  tracker.update([], { now: 22_000 });
  const [ended] = tracker.consumeEvents();
  assert.equal(ended.type, 'call-ended-window-absent');
  assert.equal(ended.pid, 18760);
  assert.equal(ended.canonicalWindowId, '3413572');
  assert.equal(ended.callEpoch, 1);
  assert.ok(ended.missingForMs >= 20_000);

  const [nextCall] = tracker.update([hostWindow({ windowId: '3348120' })], { now: 25_000 });
  assert.equal(nextCall.webexMeetingControlsPresent, true);
  assert.equal(nextCall.webexCallEpoch, 2);
  assert.equal(nextCall.webexCanonicalWindowId, '3348120');
  assert.equal(nextCall.webexWindowIdentityChanged, undefined);
});

test('a returning Webex host window before the absence grace cancels the pending end', () => {
  const tracker = new WebexMeetingControlTracker({ windowAbsenceGraceMs: 20_000 });
  tracker.update([hostWindow({ windowId: '3413572' })], { now: 1_000 });
  tracker.update([], { now: 2_000 });
  tracker.update([], { now: 10_000 });
  const [returned] = tracker.update([hostWindow({ windowId: '3348120' })], { now: 18_000 });
  assert.equal(returned.webexCallEpoch, 1);
  assert.equal(tracker.consumeEvents().length, 0);
});

 test('a stale positive UIA result preserves the current call identity without counting as a fresh scan', () => {
  const tracker = new WebexMeetingControlTracker();
  tracker.update([hostWindow({ windowId: '3413572' })], { now: 1_000 });

  const [stale] = tracker.update([hostWindow({
    windowId: '3348120',
    webexUiAutomationInspected: false,
    webexMeetingControlsPresent: true,
    webexMeetingControlsStale: true,
  })], { now: 40_000 });
  assert.equal(stale.webexMeetingControlsPresent, true);
  assert.equal(stale.webexMeetingControlsStale, true);
  assert.equal(stale.webexCanonicalWindowId, '3413572');
  assert.equal(stale.webexCallEpoch, 1);
});

test('a UI Automation failure on a replacement HWND preserves the active call identity', () => {
  const tracker = new WebexMeetingControlTracker();
  tracker.update([hostWindow({ windowId: '3413572' })], { now: 1_000 });

  const [replacement] = tracker.update([hostWindow({
    windowId: '3348120',
    webexUiAutomationInspected: false,
    webexMeetingControlsPresent: false,
  })], { now: 3_000 });
  assert.equal(replacement.webexMeetingControlsPresent, true);
  assert.equal(replacement.webexMeetingEnded, false);
  assert.equal(replacement.webexCanonicalWindowId, '3413572');
  assert.equal(replacement.webexCallEpoch, 1);
});
