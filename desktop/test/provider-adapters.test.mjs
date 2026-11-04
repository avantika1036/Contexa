import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProviderWindow } from '../providers/index.mjs';
import { createMeetingObservation } from '../meeting-observation.mjs';

const positiveFixtures = [
  // Google Meet: call code and provider page-title variants.
  { provider: 'google_meet', process: 'chrome', title: 'Meet - abc-defg-hij', source: 'browser_window', confidence: 'high' },
  { provider: 'google_meet', process: 'msedge', title: 'Google Meet - Weekly sync', source: 'browser_window', confidence: 'medium' },
  { provider: 'google_meet', process: 'firefox', title: 'meet.google.com', source: 'browser_window', confidence: 'medium' },
  { provider: 'google_meet', process: 'brave', title: 'Meet - xyz-abcd-efg', source: 'browser_window', confidence: 'high' },

  // Zoom: native client and browser meeting surfaces.
  { provider: 'zoom', process: 'Zoom', title: 'Team sync - Zoom Meeting', source: 'native_window', confidence: 'medium' },
  { provider: 'zoom', process: 'Zoom Workplace', title: 'Zoom Meeting - zoom.us', source: 'native_window', confidence: 'medium' },
  { provider: 'zoom', process: 'chrome', title: 'Zoom Meeting - zoom.us', source: 'browser_window', confidence: 'medium' },
  { provider: 'zoom', process: 'Zoom', title: 'Zoom Meeting - Meeting ID: 123456789', source: 'native_window', confidence: 'high' },
  { provider: 'zoom', process: 'msedge', title: 'Webinar - Zoom', source: 'browser_window', confidence: 'medium' },

  // Teams: current ms-teams.exe, the meeting module host, classic Teams, and browser.
  { provider: 'teams', process: 'ms-teams.exe', title: 'Design review - Meeting in progress', source: 'native_window', confidence: 'medium' },
  { provider: 'teams', process: 'ms-teams', title: 'Meeting with Avantika Pandey | Microsoft Teams', source: 'native_window', confidence: 'medium' },
  { provider: 'teams', process: 'Teams', title: 'Call with product team', source: 'native_window', confidence: 'medium' },
  { provider: 'teams', process: 'ms-teams_modulehost.exe', title: 'Call in progress', source: 'native_window', confidence: 'medium' },
  { provider: 'teams', process: 'msedge', title: 'Meeting | Microsoft Teams', source: 'browser_window', confidence: 'medium' },
  { provider: 'teams', process: 'chrome', title: 'teams.microsoft.com - Huddle', source: 'browser_window', confidence: 'medium' },

  // Webex: documented host/join executables and browser meeting surfaces.
  { provider: 'webex', process: 'Webex', title: 'Project sync - Webex Meeting', source: 'native_window', confidence: 'medium' },
  { provider: 'webex', process: 'Webex', title: 'Webex Calling - Call in progress', source: 'native_window', confidence: 'medium' },
  { provider: 'webex', process: 'CiscoCollabHost.exe', title: 'Customer call - Webex', source: 'native_window', confidence: 'medium' },
  { provider: 'webex', process: 'webexhost.exe', title: 'Customer meeting', source: 'native_window', confidence: 'medium' },
  { provider: 'webex', process: 'CiscoWebExStart.exe', title: 'Connecting to meeting', source: 'native_window', confidence: 'medium' },
  { provider: 'webex', process: 'chrome', title: 'Webex Meeting - Cisco Webex', source: 'browser_window', confidence: 'medium' },
  { provider: 'webex', process: 'msedge', title: 'Join meeting - Webex', source: 'browser_window', confidence: 'medium' },
];

test('provider adapters recognize supported browser and native meeting-window fixtures', () => {
  for (const fixture of positiveFixtures) {
    const process = fixture.process;
    const title = fixture.title;
    const match = detectProviderWindow(process, title);
    assert.ok(match, `${process}: ${title} should be recognized`);
    assert.equal(match.provider, fixture.provider, `${process}: ${title}`);
    assert.equal(match.source, fixture.source, `${process}: ${title}`);
    assert.equal(match.confidence, fixture.confidence, `${process}: ${title}`);
    assert.ok(Array.isArray(match.evidence) && match.evidence.length >= 2);
  }
});

const negativeFixtures = [
  ['chrome', 'New Tab - Google Chrome'],
  ['chrome', 'Google Docs - Weekly planning'],
  ['chrome', 'Meet settings - Google Chrome'],
  ['chrome', 'meet.google.com wants to use your microphone'],
  ['Zoom', 'Zoom Workplace'],
  ['Zoom', 'Zoom Home'],
  ['Zoom', 'Zoom Settings'],
  ['Zoom', 'Zoom Chat'],
  ['Zoom', 'Zoom Calendar'],
  ['Teams', 'Chat list'],
  ['Teams', 'Activity'],
  ['Teams', 'Settings'],
  ['ms-teams.exe', 'Calendar | Microsoft Teams'],
  ['ms-teams.exe', 'Meeting with'],
  ['ms-teams.exe', 'Customer meeting'],
  ['ms-teams.exe', 'Schedule a meeting - Microsoft Teams'],
  ['msteams_modulehost.exe', 'File upload complete'],
  ['msedge', 'teams.microsoft.com'],
  ['msedge', 'Chat | Microsoft Teams'],
  ['Webex', 'Webex Home'],
  ['Webex', 'Webex Calendar'],
  ['Webex', 'Webex Settings'],
  ['CiscoCollabHost.exe', 'Customer meeting'],
  ['CiscoCollabHost.exe', 'Chat - Webex'],
  ['webexhost.exe', 'Webex home'],
  ['chrome', 'Cisco Webex'],
  ['chrome', 'Webex calendar'],
  ['notepad', 'Project sync - Webex Meeting'],
];

test('provider adapters reject ordinary browser/app windows and non-meeting surfaces', () => {
  for (const [processName, title] of negativeFixtures) {
    assert.equal(detectProviderWindow(processName, title), null, `${processName}: ${title} should be rejected`);
  }
});

test('numeric IDs are not inferred from arbitrary title numbers', () => {
  const unlabelled = detectProviderWindow('Zoom', 'Zoom Meeting - 123456789');
  const labelled = detectProviderWindow('Zoom', 'Zoom Meeting - Meeting ID: 123456789');
  assert.ok(unlabelled);
  assert.equal(unlabelled.meetingId, undefined);
  assert.equal(labelled.meetingId, '123456789');
});

test('the shared observation contract preserves provider-specific confidence and evidence', () => {
  const observation = createMeetingObservation({
    processName: 'ms-teams',
    pid: 20100,
    title: 'Meeting with Avantika Pandey | Microsoft Teams',
    foreground: true,
    windowId: 'hwnd-1',
  });
  assert.ok(observation);
  assert.equal(observation.provider, 'teams');
  assert.equal(observation.confidence, 'medium');
  assert.ok(observation.evidence.some((item) => item.kind === 'window_title_rule'));
});

test('provider adapters retain explicit joining, leave, and end title surfaces for lifecycle classification', () => {
  const cases = [
    ['chrome', 'You left this meeting - Google Meet', 'left'],
    ['Zoom', 'Meeting has ended - Zoom Meeting', 'ended'],
    ['ms-teams.exe', 'Waiting for the organizer', 'joining'],
    ['ms-teams.exe', 'You left the meeting', 'left'],
    ['CiscoCollabHost.exe', 'Host ended the call', 'ended'],
    ['webexhost.exe', 'Connecting to meeting', 'joining'],
  ];

  for (const [processName, title, expectedState] of cases) {
    const observation = createMeetingObservation({
      processName,
      pid: 9001,
      title,
      foreground: true,
      windowId: 'hwnd-lifecycle',
    });
    assert.ok(observation, `${processName}: ${title} should remain a provider observation`);
    assert.equal(observation.state, expectedState, `${processName}: ${title}`);
  }
});


const webexDesktopMeetingEvidence = {
  pid: 18760,
  windowId: '50122',
  webexHostedInstance: true,
  webexExecutablePathVerified: true,
  webexAccessoriesHelper: false,
  webexUiAutomationInspected: true,
  webexMeetingControlsPresent: true,
};

test('native Webex desktop host is recognized from live meeting-only UI Automation controls', () => {
  const match = detectProviderWindow('CiscoCollabHost.exe', 'Webex', webexDesktopMeetingEvidence);
  assert.ok(match);
  assert.equal(match.provider, 'webex');
  assert.equal(match.source, 'native_window');
  assert.equal(match.rule, 'webex_native_active_meeting_controls');
  assert.equal(match.lifecycleState, 'active');
  assert.equal(match.confidence, 'high');
  assert.equal(match.identityKey, 'webex:window:18760:50122');
  assert.ok(match.evidence.some((item) => item.kind === 'webex_accessibility' && item.value === 'end-meeting-control-present'));
});

test('idle Webex desktop, stale launch arguments, and helper processes are not meetings', () => {
  const idle = { ...webexDesktopMeetingEvidence, webexMeetingControlsPresent: false };
  assert.equal(detectProviderWindow('CiscoCollabHost.exe', 'Webex', idle), null);
  assert.equal(detectProviderWindow('CiscoCollabHost.exe', 'Webex', {
    ...webexDesktopMeetingEvidence, webexUiAutomationInspected: false,
  }), null);
  assert.equal(detectProviderWindow('CiscoCollabHost.exe', 'Webex', {
    ...webexDesktopMeetingEvidence, webexExecutablePathVerified: false,
  }), null);
  assert.equal(detectProviderWindow('CiscoCollabHost.exe', 'Webex', {
    ...webexDesktopMeetingEvidence, webexAccessoriesHelper: true,
  }), null);
  assert.equal(detectProviderWindow('WebexHost.exe', 'Webex', webexDesktopMeetingEvidence), null);
});

test('Webex desktop control disappearance produces a terminal observation for the same HWND', () => {
  const observation = createMeetingObservation({
    processName: 'CiscoCollabHost',
    title: 'Webex',
    foreground: true,
    ...webexDesktopMeetingEvidence,
    webexMeetingControlsPresent: false,
    webexMeetingEnded: true,
  });
  assert.ok(observation);
  assert.equal(observation.provider, 'webex');
  assert.equal(observation.identityKey, 'webex:window:18760:50122');
  assert.equal(observation.state, 'ended');
  assert.equal(observation.confidence, 'high');
});

test('native Webex browser detection remains independent of desktop UI Automation metadata', () => {
  const match = detectProviderWindow('chrome', 'In meeting | Webex', {});
  assert.ok(match);
  assert.equal(match.provider, 'webex');
  assert.equal(match.source, 'browser_window');
});


test('Webex desktop replacement HWND maps to the original active call identity', () => {
  const replacementWindow = {
    ...webexDesktopMeetingEvidence,
    windowId: '3348120',
    webexCanonicalWindowId: '3413572',
    webexCallEpoch: 1,
    webexWindowIdentityChanged: true,
  };
  const match = detectProviderWindow('CiscoCollabHost.exe', 'Webex', replacementWindow);
  assert.ok(match);
  assert.equal(match.identityKey, 'webex:window:18760:3413572');
  assert.ok(match.evidence.some((item) => item.kind === 'webex_window_recreated' && item.value === 'true'));

  const observation = createMeetingObservation({
    processName: 'CiscoCollabHost',
    pid: 18760,
    title: 'Webex',
    foreground: false,
    ...replacementWindow,
  });
  assert.equal(observation.identityKey, 'webex:window:18760:3413572');
  assert.equal(observation.windowId, '3348120');
  assert.equal(observation.state, 'active');
});

test('a new Webex desktop call epoch receives a distinct durable identity', () => {
  const nextCall = {
    ...webexDesktopMeetingEvidence,
    windowId: '3348120',
    webexCanonicalWindowId: '3348120',
    webexCallEpoch: 2,
  };
  const match = detectProviderWindow('CiscoCollabHost.exe', 'Webex', nextCall);
  assert.ok(match);
  assert.equal(match.identityKey, 'webex:window:18760:3348120-call2');
  assert.equal(/^(?:zoom|teams|webex):window:\d+:[A-Za-z0-9_-]{1,80}(?:-call\d+)?$/i.test(match.identityKey), true);
});


test('a previously verified Webex call remains detectable from explicitly stale positive controls after UIA failure', () => {
  const match = detectProviderWindow('CiscoCollabHost.exe', 'Webex', {
    ...webexDesktopMeetingEvidence,
    webexUiAutomationInspected: false,
    webexMeetingControlsPresent: true,
    webexMeetingControlsStale: true,
    webexUiAutomationError: 'uia-process-failed',
    webexCanonicalWindowId: '2954308',
    webexCallEpoch: 1,
  });
  assert.ok(match);
  assert.equal(match.identityKey, 'webex:window:18760:2954308');
  assert.equal(match.lifecycleState, 'active');
  assert.ok(match.evidence.some((item) => item.kind === 'webex_accessibility' && item.value === 'end-meeting-control-present'));
});
