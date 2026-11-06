import { isDurableMeetingKey, meetingKey } from './meeting-session.mjs';
import { normalizeMeetingWindows } from './capture-policy.mjs';
import { detectProviderWindow } from './providers/index.mjs';

const JOINING_PATTERN = /waiting room|waiting to be admitted|waiting for (?:the )?(?:host|organizer)|connecting to (?:the )?meeting|joining (?:the )?(?:meeting|call)|meeting\s+join(?:ing)?|ready to join|join (?:now|meeting|call)\b/i;
const LEFT_PATTERN = /you (?:have )?left (?:the|this) (?:meeting|call)|left (?:the|this) meeting|left (?:the|this) call/i;
const ENDED_PATTERN = /meeting has ended|meeting ended|call has ended|call ended|(?:host|organizer) ended (?:the )?(?:meeting|call)/i;

function normalizeProcessName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/[\s_-]/g, '');
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
  if (LEFT_PATTERN.test(text)) return 'left';
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
  const providerMatch = detectProviderWindow(processName, title, windowInfo);
  if (!providerMatch) return null;

  const identityKey = providerMatch.identityKey || meetingKey(processName, title);
  const meetingId = providerMatch.meetingId || extractProviderMeetingId(providerMatch.provider, title, identityKey);
  const confidence = providerMatch.confidence || inferConfidence({
    identityKey,
    provider: providerMatch.provider,
    source: providerMatch.source,
    rule: providerMatch.rule,
  });
  const foreground = Boolean(windowInfo.foreground);
  const state = providerMatch.lifecycleState || inferLifecycleState(title, foreground);

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
      ...(Array.isArray(providerMatch.evidence) ? providerMatch.evidence : [{ kind: 'process', rule: providerMatch.rule }]),
      ...(meetingId ? [{ kind: 'provider_meeting_id', value: meetingId }] : []),
      { kind: 'window_focus', value: foreground ? 'foreground' : 'background' },
    ],

    // Phase 1 compatibility aliases; retained while the lifecycle registry migrates.
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

/**
 * Promote the observation that belongs to the currently running capture to `active`.
 * This is deliberately conservative: title evidence such as `joining` or `ended` takes
 * precedence, and a browser process alone is never enough to mark an arbitrary tab active.
 */
export function markActiveMeetingObservations(observations, currentCapture) {
  if (!currentCapture) return observations;
  const currentKey = String(currentCapture.sessionKey || '');
  const currentPid = Number(currentCapture.processId);
  const currentProcess = normalizeProcessName(currentCapture.processName);

  return observations.map((observation) => {
    if (observation.state === 'joining' || observation.state === 'left' || observation.state === 'ended') return observation;

    const sameIdentity = observation.identityKey === currentKey;
    const sameProcess = Number(observation.pid) === currentPid
      && normalizeProcessName(observation.processName) === currentProcess;
    const provisionalGoogleMeet = currentKey === 'browser:*'
      || (currentCapture.provider === 'google_meet' && currentKey.startsWith('browser:'));
    const sameGoogleMeetWindow = !currentCapture.windowId
      || String(observation.windowId || '') === String(currentCapture.windowId);
    const googleMeetIdentityUpgrade = provisionalGoogleMeet
      && sameProcess
      && sameGoogleMeetWindow
      && observation.provider === 'google_meet'
      && observation.durableIdentity;
    const durableIdentityMovedProcess = observation.durableIdentity
      && sameIdentity;

    if (sameIdentity && (sameProcess || durableIdentityMovedProcess) || googleMeetIdentityUpgrade) {
      return { ...observation, state: 'active' };
    }
    return observation;
  });
}
