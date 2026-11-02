import { isDurableMeetingKey, meetingKey } from './meeting-session.mjs';
import { normalizeMeetingWindows } from './capture-policy.mjs';

const NATIVE_PROCESS_PROVIDERS = new Map([
  ['zoom', 'zoom'],
  ['zoomworkplace', 'zoom'],
  ['zoommeetings', 'zoom'],
  ['msteams', 'teams'],
  ['teams', 'teams'],
  ['webex', 'webex'],
  ['ciscocollabhost', 'webex'],
]);

const BROWSER_PROCESS_NAMES = new Set([
  'chrome', 'msedge', 'brave', 'firefox', 'chromium', 'opera',
]);

const TITLE_RULES = [
  {
    provider: 'google_meet',
    rule: 'google_meet_title',
    pattern: /google meet|meet\.google|\bmeet\s*[-–|]\s*[a-z]{3}-[a-z]{4}-[a-z]{3}\b/i,
  },
  {
    provider: 'zoom',
    rule: 'zoom_meeting_title',
    pattern: /zoom\.us|zoom workplace|zoom meeting|\bzoom\b.*\b(call|meeting)\b|\b(call|meeting)\b.*\bzoom\b/i,
  },
  {
    provider: 'teams',
    rule: 'teams_meeting_title',
    pattern: /teams\.microsoft|microsoft teams|\bteams\b.*\b(meeting|call)\b|\b(meeting|call)\b.*\bteams\b/i,
  },
  {
    provider: 'webex',
    rule: 'webex_meeting_title',
    pattern: /webex|cisco webex/i,
  },
];

const JOINING_PATTERN = /waiting room|waiting to be admitted|waiting for (?:the )?host|connecting to (?:the )?meeting|joining (?:the )?(?:meeting|call)/i;
const ENDED_PATTERN = /you (?:have )?left (?:the )?(?:meeting|call)|left the meeting|meeting has ended|meeting ended|call has ended|call ended|host ended the meeting/i;

function normalizeProcessName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/[\s_-]/g, '');
}

function inferProvider(processName, title) {
  const process = normalizeProcessName(processName);
  const nativeProvider = NATIVE_PROCESS_PROVIDERS.get(process);
  if (nativeProvider) {
    return {
      provider: nativeProvider,
      source: 'native_window',
      rule: `native_process:${process}`,
    };
  }

  const browserLike = BROWSER_PROCESS_NAMES.has(process);
  if (!browserLike) return null;
  const rule = TITLE_RULES.find((candidate) => candidate.pattern.test(String(title || '')));
  if (!rule) return null;
  return {
    provider: rule.provider,
    source: 'browser_window',
    rule: rule.rule,
  };
}

function extractProviderMeetingId(provider, title, identityKey) {
  if (provider === 'google_meet') {
    const code = String(title || '').match(/\b([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i);
    return code ? code[1].toLowerCase() : null;
  }

  const labeledId = String(title || '').match(/\b(?:meeting\s*(?:id|number)|call\s*id)\s*[:#-]?\s*(\d{8,13})\b/i);
  if (labeledId) return labeledId[1];

  // Native providers may already have a durable identity parsed by meetingKey().
  const match = String(identityKey || '').match(/^(?:zoom|teams|webex):id:(\d{8,13})$/i);
  return match ? match[1] : null;
}

function inferLifecycleState(title, foreground) {
  const text = String(title || '');
  if (ENDED_PATTERN.test(text)) return 'ended';
  if (JOINING_PATTERN.test(text)) return 'joining';
  // A background window is a focus observation, not proof that the provider call
  // is still live. Keep it explicit so callers don't equate focus with call state.
  return foreground ? 'candidate' : 'background';
}

function inferConfidence({ identityKey, provider, source, rule }) {
  if (isDurableMeetingKey(identityKey)) return 'high';
  if (source === 'native_window') return 'medium';
  if (rule === 'google_meet_title') return provider === 'google_meet' ? 'medium' : 'low';
  return 'medium';
}

/**
 * Convert a supported Windows window into the provider-neutral Phase 2 observation
 * contract. Compatibility aliases (pid/title/foreground) remain so Phase 1 capture
 * and meeting-session helpers can consume the same object without behavioral changes.
 */
export function createMeetingObservation(windowInfo, { observedAt = Date.now() } = {}) {
  if (!windowInfo || typeof windowInfo !== 'object') return null;

  const processName = String(windowInfo.processName || '');
  const title = String(windowInfo.title || '').trim();
  const providerMatch = inferProvider(processName, title);
  if (!providerMatch) return null;

  const identityKey = meetingKey(processName, title);
  const meetingId = extractProviderMeetingId(providerMatch.provider, title, identityKey);
  const confidence = inferConfidence({
    identityKey,
    provider: providerMatch.provider,
    source: providerMatch.source,
    rule: providerMatch.rule,
  });
  const foreground = Boolean(windowInfo.foreground);
  const state = inferLifecycleState(title, foreground);

  return {
    // Provider-neutral observation contract.
    provider: providerMatch.provider,
    source: providerMatch.source,
    meetingId,
    identityKey,
    durableIdentity: isDurableMeetingKey(identityKey),
    processId: Number(windowInfo.pid),
    processName,
    windowId: windowInfo.windowId ? String(windowInfo.windowId) : null,
    state,
    confidence,
    observedAt: Number(observedAt),
    displayTitle: title,
    windowFocus: foreground ? 'foreground' : 'background',
    evidence: [
      { kind: 'process', rule: providerMatch.rule },
      ...(meetingId ? [{ kind: 'provider_meeting_id', value: meetingId }] : []),
      { kind: 'window_focus', value: foreground ? 'foreground' : 'background' },
    ],

    // Phase 1 compatibility aliases; these are intentionally retained until the
    // provider adapters and lifecycle registry are migrated in Phase 2.2/2.3.
    pid: Number(windowInfo.pid),
    title,
    foreground,
  };
}

/**
 * Create an observation list from the current supported-window detector results.
 * Unsupported ordinary windows never enter the meeting observation stream.
 */
export function normalizeMeetingObservations(rawWindows, { observedAt = Date.now() } = {}) {
  return normalizeMeetingWindows(rawWindows)
    .map((windowInfo) => createMeetingObservation(windowInfo, { observedAt }))
    .filter(Boolean);
}

export const MEETING_OBSERVATION_PROVIDERS = Object.freeze([
  'google_meet', 'zoom', 'teams', 'webex',
]);

export const MEETING_OBSERVATION_STATES = Object.freeze([
  'candidate', 'joining', 'active', 'background', 'left', 'ended', 'unknown',
]);

export const MEETING_OBSERVATION_CONFIDENCE = Object.freeze([
  'high', 'medium', 'low',
]);
