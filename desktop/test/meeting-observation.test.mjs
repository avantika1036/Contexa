import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMeetingObservation,
  normalizeMeetingObservations,
  markActiveMeetingObservations,
  MEETING_OBSERVATION_PROVIDERS,
  MEETING_OBSERVATION_STATES,
  MEETING_OBSERVATION_CONFIDENCE,
} from '../meeting-observation.mjs';
import { selectStartCandidate } from '../capture-policy.mjs';
import { classifyWindowTransition } from '../meeting-session.mjs';
import { WebexMeetingControlTracker } from '../webex-meeting-controls.mjs';

test('exports the provider-neutral observation contract enums', () => {
  assert.deepEqual(MEETING_OBSERVATION_PROVIDERS, ['google_meet', 'zoom', 'teams', 'webex']);
  assert.ok(MEETING_OBSERVATION_STATES.includes('candidate'));
  assert.ok(MEETING_OBSERVATION_STATES.includes('background'));
  assert.ok(MEETING_OBSERVATION_STATES.includes('ended'));
  assert.deepEqual(MEETING_OBSERVATION_CONFIDENCE, ['high', 'medium', 'low']);
});

test('normalizes Google Meet into a high-confidence browser observation with a durable ID', () => {
  const observation = createMeetingObservation({
    pid: 36380,
    processName: 'chrome',
    title: 'Meet - fai-wivv-szk',
    foreground: true,
    windowId: '000A1234',
  }, { observedAt: 1234 });

  assert.equal(observation.provider, 'google_meet');
  assert.equal(observation.source, 'browser_window');
  assert.equal(observation.meetingId, 'fai-wivv-szk');
  assert.equal(observation.identityKey, 'meet:fai-wivv-szk');
  assert.equal(observation.durableIdentity, true);
  assert.equal(observation.processId, 36380);
  assert.equal(observation.windowId, '000A1234');
  assert.equal(observation.state, 'candidate');
  assert.equal(observation.confidence, 'high');
  assert.equal(observation.observedAt, 1234);
  // Phase 1 compatibility fields remain available to current session code.
  assert.equal(observation.pid, 36380);
  assert.equal(observation.title, 'Meet - fai-wivv-szk');
  assert.equal(observation.foreground, true);
});

test('does not confuse background focus with proof that a meeting ended', () => {
  const observation = createMeetingObservation({
    pid: 36380,
    processName: 'chrome',
    title: 'Meet - fai-wivv-szk',
    foreground: false,
  });

  assert.equal(observation.state, 'background');
  assert.equal(observation.windowFocus, 'background');
  assert.equal(observation.identityKey, 'meet:fai-wivv-szk');
  assert.equal(observation.durableIdentity, true);
});

test('marks explicit waiting and ended title evidence without inferring active from focus', () => {
  const waiting = createMeetingObservation({
    pid: 36380, processName: 'chrome', title: 'Meet - abc-defg-hij - Waiting for host', foreground: true,
  });
  const left = createMeetingObservation({
    pid: 36380, processName: 'chrome', title: 'Meet - abc-defg-hij - You left the meeting', foreground: true,
  });
  const ended = createMeetingObservation({
    pid: 36380, processName: 'chrome', title: 'Meet - abc-defg-hij - Meeting has ended', foreground: true,
  });

  assert.equal(waiting.state, 'joining');
  assert.equal(left.state, 'left');
  assert.equal(ended.state, 'ended');
});

test('maps native Zoom, Teams, and Webex processes to provider observations', () => {
  const cases = [
    ['Zoom', 'Team sync - Zoom Meeting', 'zoom'],
    ['ms-teams', 'Design review - Meeting in progress', 'teams'],
    ['Webex', 'Project sync - Webex Meeting', 'webex'],
  ];
  for (const [processName, title, provider] of cases) {
    const observation = createMeetingObservation({ pid: 42, processName, title, foreground: true });
    assert.equal(observation.provider, provider);
    assert.equal(observation.source, 'native_window');
    assert.equal(observation.confidence, 'medium');
  }
});

test('recognizes browser-hosted Zoom, Teams, and Webex windows', () => {
  const cases = [
    ['chrome', 'Zoom Meeting - zoom.us', 'zoom'],
    ['msedge', 'Meeting | Microsoft Teams', 'teams'],
    ['chrome', 'Webex Meeting', 'webex'],
  ];
  for (const [processName, title, provider] of cases) {
    const observation = createMeetingObservation({ pid: 43, processName, title, foreground: false });
    assert.equal(observation.provider, provider);
    assert.equal(observation.source, 'browser_window');
    assert.equal(observation.state, 'background');
  }
});

test('keeps non-durable native meeting identity separate from process metadata', () => {
  const observation = createMeetingObservation({
    pid: 77,
    processName: 'zoom',
    title: 'Avantika weekly sync - Zoom Meeting',
    foreground: true,
  });
  assert.equal(observation.identityKey, 'zoom:avantika weekly sync - zoom meeting');
  assert.equal(observation.meetingId, null);
  assert.equal(observation.durableIdentity, false);
});

test('only returns supported meeting observations and preserves HWND identity', () => {
  const observations = normalizeMeetingObservations([
    { pid: 10, processName: 'chrome', title: 'New Tab - Google Chrome', foreground: true, windowId: 'A' },
    { pid: 10, processName: 'chrome', title: 'Meet - abc-defg-hij - Google Chrome', foreground: false, windowId: 'B' },
    { pid: 11, processName: 'zoom', title: 'Zoom Settings', foreground: true, windowId: 'C' },
  ], { observedAt: 555 });

  assert.equal(observations.length, 1);
  assert.equal(observations[0].provider, 'google_meet');
  assert.equal(observations[0].windowId, 'B');
  assert.equal(observations[0].observedAt, 555);
});

test('returns null when a window cannot be assigned to a supported provider', () => {
  assert.equal(createMeetingObservation({
    pid: 1, processName: 'notepad', title: 'Weekly notes', foreground: true,
  }), null);
});


test('observations retain the legacy detector shape used by capture policy and continuity', () => {
  const observations = normalizeMeetingObservations([
    { pid: 36380, processName: 'chrome', title: 'Meet - abc-defg-hij', foreground: true, windowId: 'HWND-1' },
  ]);
  const selected = selectStartCandidate(observations, null, Date.now(), (item) => item.identityKey).candidate;
  assert.equal(selected.provider, 'google_meet');
  assert.equal(selected.pid, 36380);
  assert.equal(selected.foreground, true);
  assert.equal(selected.identityKey, 'meet:abc-defg-hij');
  assert.equal(classifyWindowTransition(observations, {
    processId: 36380, processName: 'chrome', sessionKey: 'meet:abc-defg-hij',
  }).type, 'same-window');
});

test('marks only the currently captured observation active and preserves joining or ended evidence', () => {
  const observations = normalizeMeetingObservations([
    { pid: 36380, processName: 'chrome', title: 'Meet - abc-defg-hij', foreground: false },
    { pid: 36380, processName: 'chrome', title: 'Meet - xyz-abcd-efg - Waiting for host', foreground: true },
    { pid: 36380, processName: 'chrome', title: 'Meet - hij-klmn-opq - Meeting has ended', foreground: false },
    { pid: 36380, processName: 'chrome', title: 'Meet - rst-uvwx-yza - You left the meeting', foreground: false },
  ]);
  const marked = markActiveMeetingObservations(observations, {
    processId: 36380, processName: 'chrome', sessionKey: 'meet:abc-defg-hij',
  });
  const statesByIdentity = Object.fromEntries(marked.map((item) => [item.identityKey, item.state]));
  assert.equal(statesByIdentity['meet:abc-defg-hij'], 'active');
  assert.equal(statesByIdentity['meet:xyz-abcd-efg'], 'joining');
  assert.equal(statesByIdentity['meet:hij-klmn-opq'], 'ended');
  assert.equal(statesByIdentity['meet:rst-uvwx-yza'], 'left');
});

test('promotes a Google Meet call code as active when the capture started before the code appeared', () => {
  const observations = normalizeMeetingObservations([
    { pid: 36380, processName: 'chrome', title: 'Meet - abc-defg-hij', foreground: true },
  ]);
  const marked = markActiveMeetingObservations(observations, {
    processId: 36380, processName: 'chrome', sessionKey: 'browser:*',
  });
  assert.equal(marked[0].state, 'active');
});

test('promotes a later Google Meet call code for the same HWND when capture began from a page-title fallback', () => {
  const observations = normalizeMeetingObservations([
    { pid: 35724, processName: 'msedge', title: 'Meet - fai-wivv-szk', foreground: true, windowId: 'edge-meet-hwnd' },
    { pid: 35724, processName: 'msedge', title: 'Meet - emh-saes-zmn', foreground: false, windowId: 'edge-other-hwnd' },
  ]);
  const marked = markActiveMeetingObservations(observations, {
    processId: 35724,
    processName: 'msedge',
    provider: 'google_meet',
    windowId: 'edge-meet-hwnd',
    sessionKey: 'browser:google meet: online web and video conferencing calls',
  });

  const states = Object.fromEntries(marked.map((item) => [item.identityKey, item.state]));
  assert.equal(states['meet:fai-wivv-szk'], 'active');
  assert.equal(states['meet:emh-saes-zmn'], 'background');
});


test('Webex canonical HWND and call epoch survive the second normalization pass', () => {
  const tracker = new WebexMeetingControlTracker();
  const host = (windowId) => ({
    pid: 18760,
    processName: 'CiscoCollabHost',
    title: 'Webex',
    windowId,
    foreground: false,
    webexHostedInstance: true,
    webexExecutablePathVerified: true,
    webexAccessoriesHelper: false,
    webexUiAutomationInspected: true,
    webexMeetingControlsPresent: true,
  });

  const [first] = tracker.update([host('2954308')], { now: 1_000 });
  const firstObservation = normalizeMeetingObservations([first])[0];
  assert.equal(firstObservation.identityKey, 'webex:window:18760:2954308');

  const [replacement] = tracker.update([host('3216452')], { now: 25_000 });
  assert.equal(replacement.webexCanonicalWindowId, '2954308');
  assert.equal(replacement.webexWindowIdentityChanged, true);

  const replacementObservation = normalizeMeetingObservations([replacement])[0];
  assert.equal(replacementObservation.identityKey, 'webex:window:18760:2954308');
  assert.equal(replacementObservation.windowId, '3216452');
  assert.ok(replacementObservation.evidence.some((item) => item.kind === 'webex_window_recreated'));

  const [staleAfterTimeout] = tracker.update([{
    ...host('3348120'),
    webexUiAutomationInspected: false,
    webexMeetingControlsPresent: true,
    webexMeetingControlsStale: true,
  }], { now: 30_000 });
  const staleObservation = normalizeMeetingObservations([staleAfterTimeout])[0];
  assert.equal(staleObservation.identityKey, 'webex:window:18760:2954308');
  assert.equal(staleObservation.state, 'active');
  assert.equal(staleObservation.windowId, '3348120');
});
