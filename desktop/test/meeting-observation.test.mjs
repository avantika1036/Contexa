import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMeetingObservation,
  normalizeMeetingObservations,
  MEETING_OBSERVATION_PROVIDERS,
  MEETING_OBSERVATION_STATES,
  MEETING_OBSERVATION_CONFIDENCE,
} from '../meeting-observation.mjs';

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
  const ended = createMeetingObservation({
    pid: 36380, processName: 'chrome', title: 'Meet - abc-defg-hij - You left the meeting', foreground: true,
  });

  assert.equal(waiting.state, 'joining');
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
