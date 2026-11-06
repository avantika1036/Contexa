import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MeetingLifecycleRegistry,
  meetingLifecycleKey,
  lifecycleEventMatchesRestartBlock,
} from '../meeting-lifecycle.mjs';

function observation(overrides = {}) {
  return {
    provider: 'google_meet',
    source: 'browser_window',
    meetingId: 'abc-defg-hij',
    identityKey: 'meet:abc-defg-hij',
    durableIdentity: true,
    processId: 101,
    processName: 'chrome',
    windowId: '5001',
    state: 'candidate',
    confidence: 'high',
    observedAt: 1000,
    displayTitle: 'Meet - abc-defg-hij',
    windowFocus: 'foreground',
    evidence: [],
    pid: 101,
    title: 'Meet - abc-defg-hij',
    foreground: true,
    ...overrides,
  };
}

test('durable meeting lifecycle identity survives process and HWND replacement', () => {
  const first = meetingLifecycleKey(observation());
  const replacement = meetingLifecycleKey(observation({ processId: 202, pid: 202, windowId: '9002' }));
  assert.equal(first, replacement);
});

test('non-durable provider windows are separated by process and HWND', () => {
  const base = observation({
    provider: 'zoom', identityKey: 'zoom:*', durableIdentity: false, meetingId: null,
  });
  const first = meetingLifecycleKey(base);
  const anotherWindow = meetingLifecycleKey({ ...base, windowId: '5002' });
  const anotherProcess = meetingLifecycleKey({ ...base, processId: 202, pid: 202 });
  assert.notEqual(first, anotherWindow);
  assert.notEqual(first, anotherProcess);
});

test('a brief missing observation becomes temporarily missing, not left or ended', () => {
  const registry = new MeetingLifecycleRegistry({ missingGraceMs: 30_000 });
  registry.update([observation({ state: 'active' })], { now: 1_000 });
  const result = registry.update([], { now: 4_000 });
  assert.equal(result.snapshot[0].state, 'temporarily_missing');
  assert.deepEqual(result.events.map((event) => event.type), ['temporarily_missing']);
  assert.notEqual(result.snapshot[0].state, 'left');
  assert.notEqual(result.snapshot[0].state, 'ended');
});

test('a missing observation becomes unknown after the grace period without implying meeting end', () => {
  const registry = new MeetingLifecycleRegistry({ missingGraceMs: 30_000 });
  registry.update([observation({ state: 'active' })], { now: 1_000 });
  registry.update([], { now: 4_000 });
  const result = registry.update([], { now: 35_000 });
  assert.equal(result.snapshot[0].state, 'unknown');
  assert.equal(result.events[0].type, 'missing_expired');
});

test('a temporarily missing meeting returning within the grace period keeps its lifecycle epoch', () => {
  const registry = new MeetingLifecycleRegistry({ missingGraceMs: 30_000 });
  registry.update([observation({ state: 'active' })], { now: 1_000 });
  registry.update([], { now: 4_000 });
  const result = registry.update([observation({ state: 'active', observedAt: 6_000 })], { now: 6_000 });
  assert.equal(result.observations[0].lifecycleEpoch, 1);
  assert.equal(result.observations[0].lifecycleEvent, 'returned');
  assert.equal(result.events[0].type, 'returned');
  assert.equal(result.events[0].fromState, 'temporarily_missing');
});

test('an explicit leave followed by the same call becoming available creates a rejoin epoch', () => {
  const registry = new MeetingLifecycleRegistry();
  registry.update([observation({ state: 'left' })], { now: 1_000 });
  const result = registry.update([observation({ state: 'joining', observedAt: 5_000 })], { now: 5_000 });
  assert.equal(result.observations[0].lifecycleEpoch, 2);
  assert.equal(result.observations[0].lifecycleEvent, 'rejoined');
  assert.equal(result.events[0].type, 'rejoined');
  assert.equal(result.events[0].fromState, 'left');
});

test('explicit end followed by a new candidate is a rejoin, not a temporary return', () => {
  const registry = new MeetingLifecycleRegistry();
  registry.update([observation({ state: 'ended' })], { now: 1_000 });
  const result = registry.update([observation({ state: 'candidate' })], { now: 3_000 });
  assert.equal(result.snapshot[0].epoch, 2);
  assert.equal(result.snapshot[0].state, 'candidate');
  assert.equal(result.events[0].fromState, 'ended');
});

test('background focus changes do not create a new lifecycle epoch', () => {
  const registry = new MeetingLifecycleRegistry();
  registry.update([observation({ state: 'active' })], { now: 1_000 });
  const result = registry.update([observation({ state: 'background', foreground: false, windowFocus: 'background' })], { now: 2_000 });
  assert.equal(result.observations[0].lifecycleEpoch, 1);
  assert.equal(result.observations[0].lifecycleState, 'background');
  assert.equal(result.events[0].type, 'state_changed');
  assert.equal(result.events[0].fromState, 'active');
});

test('two different provider meetings are tracked independently', () => {
  const registry = new MeetingLifecycleRegistry();
  const zoom = observation({ provider: 'zoom', identityKey: 'zoom:id:123456789', meetingId: '123456789' });
  const teams = observation({ provider: 'teams', identityKey: 'teams:id:987654321', meetingId: '987654321' });
  const result = registry.update([zoom, teams], { now: 1_000 });
  assert.equal(result.snapshot.length, 2);
  assert.equal(result.events.length, 2);
  assert.deepEqual(new Set(result.snapshot.map((entry) => entry.provider)), new Set(['zoom', 'teams']));
});

test('multiple windows for the same durable meeting share one lifecycle entry', () => {
  const registry = new MeetingLifecycleRegistry();
  const first = observation({ windowId: '5001' });
  const second = observation({ windowId: '5002', foreground: false, windowFocus: 'background', state: 'background' });
  const result = registry.update([first, second], { now: 1_000 });
  assert.equal(result.snapshot.length, 1);
  assert.equal(result.events.length, 1);
  assert.equal(result.observations.length, 2);
  assert.equal(result.observations[0].lifecycleEpoch, result.observations[1].lifecycleEpoch);
});

test('terminal observations remain terminal when their window disappears', () => {
  const registry = new MeetingLifecycleRegistry();
  registry.update([observation({ state: 'ended' })], { now: 1_000 });
  const result = registry.update([], { now: 40_000 });
  assert.equal(result.snapshot[0].state, 'ended');
  assert.equal(result.events.length, 0);
});

test('only a matching durable terminal-to-present event lifts its restart block', () => {
  const event = {
    type: 'rejoined',
    identityKey: 'meet:abc-defg-hij',
    pid: 202,
  };
  assert.equal(lifecycleEventMatchesRestartBlock(event, { key: 'meet:abc-defg-hij', pid: 101 }), true);
  assert.equal(lifecycleEventMatchesRestartBlock(event, { key: 'meet:other-code', pid: 202 }), false);
  assert.equal(lifecycleEventMatchesRestartBlock({ ...event, type: 'returned' }, { key: event.identityKey, pid: 202 }), false);
});

test('non-durable rejoin only lifts the block for the same process', () => {
  const event = { type: 'rejoined', identityKey: 'zoom:*', pid: 202 };
  assert.equal(lifecycleEventMatchesRestartBlock(event, { key: 'zoom:*', pid: 202 }), true);
  assert.equal(lifecycleEventMatchesRestartBlock(event, { key: 'zoom:*', pid: 101 }), false);
});


test('a background-only observation does not lift a terminal state or create a rejoin epoch', () => {
  const registry = new MeetingLifecycleRegistry();
  registry.update([observation({ state: 'ended' })], { now: 1_000 });
  const background = registry.update([observation({ state: 'background', foreground: false, windowFocus: 'background' })], { now: 2_000 });
  assert.equal(background.snapshot[0].state, 'ended');
  assert.equal(background.snapshot[0].epoch, 1);
  assert.equal(background.events.length, 0);
  const active = registry.update([observation({ state: 'candidate' })], { now: 3_000 });
  assert.equal(active.snapshot[0].state, 'candidate');
  assert.equal(active.snapshot[0].epoch, 2);
  assert.equal(active.events[0].type, 'rejoined');
});

test('an active duplicate window outranks a terminal duplicate for the same durable call identity', () => {
  const registry = new MeetingLifecycleRegistry();
  const endedWindow = observation({ state: 'ended', windowId: '5001' });
  const activeWindow = observation({ state: 'active', windowId: '5002', processId: 202, pid: 202 });
  const result = registry.update([endedWindow, activeWindow], { now: 1_000 });
  assert.equal(result.snapshot.length, 1);
  assert.equal(result.snapshot[0].state, 'active');
  assert.equal(result.events[0].state, 'active');
});


test('Webex desktop lifecycle uses its PID/HWND identity through active, ended, background, and rejoined states', () => {
  const registry = new MeetingLifecycleRegistry();
  const webex = (state, observedAt = 1_000, overrides = {}) => observation({
    provider: 'webex',
    source: 'native_window',
    meetingId: null,
    identityKey: 'webex:window:18760:50122',
    durableIdentity: true,
    processId: 18760,
    pid: 18760,
    processName: 'CiscoCollabHost',
    windowId: '50122',
    state,
    confidence: 'high',
    observedAt,
    title: 'Webex',
    displayTitle: 'Webex',
    ...overrides,
  });

  const started = registry.update([webex('active')], { now: 1_000 });
  assert.equal(started.snapshot[0].epoch, 1);
  assert.equal(started.snapshot[0].state, 'active');

  const ended = registry.update([webex('ended', 2_000)], { now: 2_000 });
  assert.equal(ended.snapshot[0].state, 'ended');
  assert.equal(ended.events[0].type, 'state_changed');

  const staleBackground = registry.update([webex('background', 3_000, { foreground: false })], { now: 3_000 });
  assert.equal(staleBackground.snapshot[0].state, 'ended');
  assert.equal(staleBackground.snapshot[0].epoch, 1);
  assert.equal(staleBackground.events.length, 0);

  const rejoined = registry.update([webex('active', 4_000)], { now: 4_000 });
  assert.equal(rejoined.snapshot[0].state, 'active');
  assert.equal(rejoined.snapshot[0].epoch, 2);
  assert.equal(rejoined.events[0].type, 'rejoined');
  assert.equal(lifecycleEventMatchesRestartBlock(rejoined.events[0], {
    provider: 'webex',
    pid: 18760,
    key: 'webex:window:18760:50122',
    stableIdentity: true,
  }), true);
});

test('repeated provider observations do not create extra lifecycle epochs or discovery events', () => {
  const registry = new MeetingLifecycleRegistry();
  const first = registry.update([observation({ state: 'active' })], { now: 1_000 });
  assert.equal(first.events.filter((event) => event.type === 'discovered').length, 1);
  const second = registry.update([observation({ state: 'active', observedAt: 2_000 })], { now: 2_000 });
  assert.equal(second.snapshot[0].epoch, 1);
  assert.equal(second.events.length, 0);
});


test('a Webex HWND replacement with the same call-level identity stays in one lifecycle entry', () => {
  const registry = new MeetingLifecycleRegistry();
  const base = {
    provider: 'webex',
    source: 'native_window',
    meetingId: null,
    identityKey: 'webex:window:18760:3413572',
    durableIdentity: true,
    processId: 18760,
    pid: 18760,
    processName: 'CiscoCollabHost',
    state: 'active',
    confidence: 'high',
    title: 'Webex',
    displayTitle: 'Webex',
  };
  const first = registry.update([{ ...base, windowId: '3413572' }], { now: 1_000 });
  const recreated = registry.update([{ ...base, windowId: '3348120' }], { now: 4_000 });
  assert.equal(recreated.snapshot.length, 1);
  assert.equal(recreated.snapshot[0].state, 'active');
  assert.equal(recreated.snapshot[0].epoch, 1);
  assert.equal(recreated.events.length, 0);
  assert.equal(first.snapshot[0].lifecycleKey, recreated.snapshot[0].lifecycleKey);
});

test('registry exposes independent window records for one meeting across browser processes', () => {
  const registry = new MeetingLifecycleRegistry();
  const first = observation({
    processId: 101,
    pid: 101,
    processName: 'chrome',
    windowId: '5001',
  });
  const second = observation({
    processId: 202,
    pid: 202,
    processName: 'msedge',
    windowId: '9002',
    foreground: false,
    windowFocus: 'background',
    state: 'background',
  });

  const result = registry.update([first, second], { now: 1_000 });
  assert.equal(result.snapshot.length, 1, 'one durable call should remain one meeting');
  assert.equal(result.snapshot[0].windowCount, 2);
  assert.equal(result.snapshot[0].windows.length, 2);
  assert.deepEqual(
    result.snapshot[0].windows.map((window) => [window.pid, window.processName, window.windowId]),
    [[101, 'chrome', '5001'], [202, 'msedge', '9002']],
  );
  assert.equal(result.snapshot[0].windows.find((window) => window.windowId === '5001').foreground, true);
  assert.equal(result.snapshot[0].windows.find((window) => window.windowId === '9002').state, 'background');
});

test('different durable meetings in the same browser process retain separate window records', () => {
  const registry = new MeetingLifecycleRegistry();
  const first = observation({
    identityKey: 'meet:abc-defg-hij',
    meetingId: 'abc-defg-hij',
    processId: 101,
    pid: 101,
    windowId: '5001',
  });
  const second = observation({
    identityKey: 'meet:xyz-abcd-efg',
    meetingId: 'xyz-abcd-efg',
    processId: 101,
    pid: 101,
    windowId: '5002',
    foreground: false,
    windowFocus: 'background',
    state: 'background',
  });

  const result = registry.update([first, second], { now: 1_000 });
  assert.equal(result.snapshot.length, 2);
  assert.deepEqual(
    result.snapshot.map((entry) => [entry.identityKey, entry.windows.length]),
    [['meet:abc-defg-hij', 1], ['meet:xyz-abcd-efg', 1]],
  );
});

test('a missing window is tracked independently while another representation remains present', () => {
  const registry = new MeetingLifecycleRegistry({ missingGraceMs: 5_000, retentionMs: 20_000 });
  const first = observation({ windowId: '5001' });
  const second = observation({
    processId: 202,
    pid: 202,
    processName: 'msedge',
    windowId: '9002',
    foreground: false,
    windowFocus: 'background',
    state: 'background',
  });

  registry.update([first, second], { now: 1_000 });
  const oneWindowRemains = registry.update([second], { now: 2_000 });
  const entry = oneWindowRemains.snapshot[0];
  assert.equal(entry.state, 'background');
  assert.equal(entry.windowCount, 1);
  assert.equal(entry.windows.length, 2, 'the temporarily missing window should be retained');
  assert.equal(entry.windows.find((window) => window.windowId === '5001').state, 'temporarily_missing');
  assert.equal(entry.windows.find((window) => window.windowId === '9002').state, 'background');

  const expiredWindow = registry.update([second], { now: 7_001 }).snapshot[0];
  assert.equal(expiredWindow.windows.find((window) => window.windowId === '5001').state, 'unknown');
  assert.equal(expiredWindow.windowCount, 1);
});

test('a missing window clears stale foreground state while retaining its missing grace', () => {
  const registry = new MeetingLifecycleRegistry({ missingGraceMs: 5_000, retentionMs: 20_000 });
  registry.update([observation({ state: 'candidate', foreground: true, windowFocus: 'foreground' })], { now: 1_000 });

  const missing = registry.update([], { now: 2_000 }).snapshot[0].windows[0];
  assert.equal(missing.state, 'temporarily_missing');
  assert.equal(missing.foreground, false);
  assert.equal(missing.windowFocus, 'unknown');
  assert.equal(missing.missingSince, 2_000);

  const expired = registry.update([], { now: 7_001 }).snapshot[0].windows[0];
  assert.equal(expired.state, 'unknown');
  assert.equal(expired.foreground, false);
  assert.equal(expired.windowFocus, 'unknown');
});

test('a returning window keeps the meeting epoch and clears its missing state', () => {
  const registry = new MeetingLifecycleRegistry({ missingGraceMs: 5_000, retentionMs: 20_000 });
  const first = observation({ windowId: '5001', state: 'active' });
  const second = observation({ windowId: '5002', state: 'background', foreground: false, windowFocus: 'background' });

  registry.update([first, second], { now: 1_000 });
  registry.update([second], { now: 2_000 });
  const returned = registry.update([first, second], { now: 3_000 });
  assert.equal(returned.snapshot[0].epoch, 1);
  assert.equal(returned.snapshot[0].windows.find((window) => window.windowId === '5001').state, 'active');
  assert.equal(returned.snapshot[0].windows.find((window) => window.windowId === '5001').missingSince, null);
});

test('registry snapshots deep-copy window records', () => {
  const registry = new MeetingLifecycleRegistry();
  registry.update([observation()], { now: 1_000 });
  const snapshot = registry.getSnapshot();
  snapshot[0].windows[0].windowId = 'mutated';
  snapshot[0].windows.length = 0;

  const fresh = registry.getSnapshot();
  assert.equal(fresh[0].windows.length, 1);
  assert.equal(fresh[0].windows[0].windowId, '5001');
});

test('same-call window records preserve distinct active and ended evidence', () => {
  const registry = new MeetingLifecycleRegistry();
  const endedWindow = observation({ windowId: '5001', state: 'ended' });
  const activeWindow = observation({
    processId: 202,
    pid: 202,
    processName: 'msedge',
    windowId: '9002',
    state: 'active',
  });

  const result = registry.update([endedWindow, activeWindow], { now: 1_000 });
  assert.equal(result.snapshot.length, 1);
  assert.equal(result.snapshot[0].state, 'active');
  assert.equal(result.snapshot[0].windows.find((window) => window.windowId === '5001').state, 'ended');
  assert.equal(result.snapshot[0].windows.find((window) => window.windowId === '9002').state, 'active');
});

test('a stale background surface does not revive an individually ended window', () => {
  const registry = new MeetingLifecycleRegistry();
  const endedWindow = observation({ windowId: '5001', state: 'ended' });
  const activeWindow = observation({ windowId: '5002', state: 'active' });

  registry.update([endedWindow, activeWindow], { now: 1_000 });
  const stale = registry.update([
    observation({ windowId: '5001', state: 'background', foreground: false, windowFocus: 'background' }),
    activeWindow,
  ], { now: 2_000 });

  assert.equal(stale.snapshot[0].state, 'active');
  assert.equal(stale.snapshot[0].windows.find((window) => window.windowId === '5001').state, 'ended');
  assert.equal(stale.snapshot[0].windows.find((window) => window.windowId === '5002').state, 'active');
});
