// Identity and continuity helpers for a real-world meeting.
// Process IDs are diagnostic hints, never a sufficient meeting identity on their own.

const BROWSER_SUFFIX = /\s*[-–—|]\s*(google chrome|microsoft\s*.?\s*edge|mozilla firefox|brave|chromium|opera)\s*$/i;
const GENERIC_TITLES = new Set([
  '', 'zoom', 'zoom meeting', 'zoom workplace', 'meeting', 'call', 'meeting in progress',
  'microsoft teams', 'teams', 'webex', 'cisco webex meetings', 'google meet', 'meet',
]);

function familyOf(processName) {
  const name = String(processName || '').toLowerCase().replace(/\.exe$/, '').replace(/[\s_-]/g, '');
  if (['zoom', 'zoomworkplace', 'zoommeetings'].includes(name)) return 'zoom';
  if (['msteams', 'teams'].includes(name)) return 'teams';
  if (['webex', 'ciscocollabhost'].includes(name)) return 'webex';
  return 'browser';
}

/**
 * True when the browser process that originally owned a stable meeting window still
 * owns a top-level window, even if that HWND now displays another tab's title.
 * This is a continuity signal only; it is never used to identify or merge meetings.
 */
export function hasSameBrowserProcessWindow(windows, current) {
  if (!current || familyOf(current.processName) !== 'browser' || !Number.isInteger(Number(current.processId))) {
    return false;
  }
  return (Array.isArray(windows) ? windows : []).some((windowInfo) =>
    Number(windowInfo?.pid) === Number(current.processId)
      && familyOf(windowInfo?.processName) === 'browser'
  );
}

/**
 * Keep a browser capture alive only when the meeting identity is currently unmatchable
 * but the exact browser process that owned it still has a top-level window. An explicit
 * different meeting transition must never be swallowed by this fallback.
 */
export function shouldKeepBrowserCaptureDuringTabSwitch(transitionType, windows, current) {
  return transitionType === 'missing' && hasSameBrowserProcessWindow(windows, current);
}

function normalizeTitle(title) {
  return String(title || '')
    .replace(/^auto\s*·\s*/i, '')
    .replace(BROWSER_SUFFIX, '')
    .replace(/^\(\d+\)\s*/, '')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function explicitMeetingId(family, title) {
  const raw = String(title || '');
  const meetCode = raw.match(/\b([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i);
  if (meetCode) return `meet:${meetCode[1].toLowerCase()}`;

  // Only accept numeric IDs when the title explicitly labels them as meeting IDs.
  // This avoids mistaking dates, phone numbers or unrelated numbers for call identity.
  const labeledId = raw.match(/\b(?:meeting\s*(?:id|number)|call\s*id)\s*[:#-]?\s*(\d{8,13})\b/i);
  if (labeledId) return `${family}:id:${labeledId[1]}`;
  return null;
}

/** A stable identity where the window title exposes a real meeting/call identifier. */
export function meetingKey(processName, title) {
  const family = familyOf(processName);
  const explicit = explicitMeetingId(family, title);
  if (explicit) return explicit;

  const normalized = normalizeTitle(title);
  // Native applications often change window titles during the same call. Their generic
  // titles use a process-scoped key; meaningful native titles remain exact identities.
  if (family !== 'browser') {
    if (GENERIC_TITLES.has(normalized)) return `${family}:*`;
    return `${family}:${normalized}`;
  }
  return `${family}:${GENERIC_TITLES.has(normalized) ? '*' : normalized}`;
}

/** Only explicit meeting IDs are safe to deduplicate across Electron/backend restarts. */
export function isDurableMeetingKey(key) {
  return /^(?:meet:[a-z]{3}-[a-z]{4}-[a-z]{3}|(?:zoom|teams|webex):id:\d{8,13}|(?:zoom|teams|webex):window:\d+:[A-Za-z0-9_-]{1,80}(?:-call\d+)?)$/i.test(String(key || ''));
}

/**
 * Return the server-side recovery key for a capture. Native apps do not always
 * expose a durable meeting ID in their window title; the PID/HWND pair remains
 * stable across a Contexa restart while that native meeting window stays open.
 * Keep this separate from identityKey, which still distinguishes meaningful
 * meeting-title changes within the running lifecycle.
 */
export function meetingCaptureKey(windowInfo) {
  if (!windowInfo || typeof windowInfo !== 'object') return null;
  const identityKey = String(windowInfo.identityKey || '').trim();
  if (isDurableMeetingKey(identityKey)) return identityKey;

  const provider = String(windowInfo.provider || '').toLowerCase();
  const source = String(windowInfo.source || '').toLowerCase();
  const pid = Number(windowInfo.processId ?? windowInfo.pid);
  const windowId = String(windowInfo.windowId || '').trim();
  if (source === 'native_window'
    && ['zoom', 'teams', 'webex'].includes(provider)
    && Number.isInteger(pid) && pid > 0
    && /^[A-Za-z0-9_-]{1,80}$/.test(windowId)) {
    return `${provider}:window:${pid}:${windowId}`;
  }
  return identityKey || meetingKey(windowInfo.processName, windowInfo.title);
}

/** Classify a detected window relative to the meeting currently being captured. */
export function classifyWindowTransition(matches, current) {
  const normalizeProcess = (value) => String(value || '').toLowerCase().replace(/\.exe$/, '').replace(/[\s_-]/g, '');
  const sameProcess = (windowInfo) => Number(windowInfo.pid ?? windowInfo.processId) === Number(current.processId)
    && normalizeProcess(windowInfo.processName) === normalizeProcess(current.processName);
  const keyOf = (windowInfo) => String(windowInfo.identityKey || meetingKey(windowInfo.processName, windowInfo.title));

  const isTerminal = (windowInfo) => ['left', 'ended'].includes(String(windowInfo?.state || '').toLowerCase());
  const sameHwndTerminal = current.windowId
    ? matches.find((windowInfo) => sameProcess(windowInfo)
      && String(windowInfo.windowId || '') === String(current.windowId)
      && isTerminal(windowInfo))
    : null;
  if (sameHwndTerminal) return { type: 'meeting-ended', window: sameHwndTerminal };

  const sameIdentityTerminal = matches.find((windowInfo) =>
    sameProcess(windowInfo) && keyOf(windowInfo) === current.sessionKey && isTerminal(windowInfo)
  );
  if (sameIdentityTerminal) return { type: 'meeting-ended', window: sameIdentityTerminal };

  // Some providers replace the meeting title with a generic leave/end screen. Only
  // accept that as terminal evidence when it is the sole same-provider window owned
  // by the process currently being captured; multiple calls remain ambiguous.
  if (current.provider) {
    const sameProviderWindows = matches.filter((windowInfo) =>
      sameProcess(windowInfo) && windowInfo.provider === current.provider
    );
    if (sameProviderWindows.length === 1 && isTerminal(sameProviderWindows[0])) {
      return { type: 'meeting-ended', window: sameProviderWindows[0] };
    }
  }

  const sameWindow = matches.find((windowInfo) => sameProcess(windowInfo) && keyOf(windowInfo) === current.sessionKey);
  if (sameWindow) return { type: 'same-window', window: sameWindow };

  // Native clients sometimes replace a descriptive meeting title with a generic
  // application title during the same call (notably Zoom after Electron restarts).
  // On the same provider/PID/HWND, a transition to or from the provider wildcard
  // is a title fallback, not a new meeting. Two different descriptive titles on
  // the same native HWND represent a meeting switch.
  const sameNativeHwnd = current.windowId
    ? matches.find((windowInfo) => sameProcess(windowInfo)
      && String(windowInfo.windowId || '') === String(current.windowId)
      && String(windowInfo.provider || current.provider || '').toLowerCase() === String(current.provider || '').toLowerCase()
      && ['zoom', 'teams', 'webex'].includes(String(windowInfo.provider || current.provider || '').toLowerCase())
      && String(windowInfo.source || '') === 'native_window')
    : null;
  if (sameNativeHwnd) {
    const nextKey = keyOf(sameNativeHwnd);
    const provider = String(sameNativeHwnd.provider || current.provider || '').toLowerCase();
    const wildcard = `${provider}:*`;
    if (current.sessionKey === wildcard || nextKey === wildcard) {
      return { type: 'same-window', window: sameNativeHwnd, identityFallback: true };
    }
    if (nextKey !== current.sessionKey) {
      return { type: 'different-meeting', window: sameNativeHwnd };
    }
  }

  // Google Meet can initially expose only a generic browser title ("Google Meet"),
  // then expose the actual call code once the meeting surface finishes loading.
  // In the same browser process this is an identity upgrade, not a missing window.
  const chooseUnambiguousWindow = (candidates) => {
    if (candidates.length === 1) return candidates[0];
    const foreground = candidates.filter((windowInfo) => windowInfo.foreground);
    return foreground.length === 1 ? foreground[0] : null;
  };

  if (current.sessionKey === 'browser:*' && familyOf(current.processName) === 'browser') {
    const identifiedMeets = matches.filter((windowInfo) => sameProcess(windowInfo)
      && /^meet:[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(keyOf(windowInfo)));
    const identifiedMeet = chooseUnambiguousWindow(identifiedMeets);
    if (identifiedMeet) {
      return {
        type: 'same-meeting-identity-upgrade',
        window: identifiedMeet,
        sessionKey: keyOf(identifiedMeet),
      };
    }
  }

  const sameMeetingCandidates = isDurableMeetingKey(current.sessionKey)
    ? matches.filter((windowInfo) => keyOf(windowInfo) === current.sessionKey && windowInfo.pid !== current.processId)
    : [];
  const sameMeetingNewProcess = chooseUnambiguousWindow(sameMeetingCandidates);
  if (sameMeetingNewProcess) return { type: 'same-meeting-new-process', window: sameMeetingNewProcess };

  const differentMeetings = matches.filter((windowInfo) => {
    if (!sameProcess(windowInfo)) return false;
    const nextKey = keyOf(windowInfo);
    return nextKey !== current.sessionKey
      && isDurableMeetingKey(nextKey)
      && isDurableMeetingKey(current.sessionKey);
  });
  const differentMeeting = chooseUnambiguousWindow(differentMeetings);
  if (differentMeeting) return { type: 'different-meeting', window: differentMeeting };

  return { type: 'missing', window: null };
}

export function graceForKey(key, { browserMs, nativeMs }) {
  return /^(zoom|teams|webex):/.test(String(key)) ? Math.min(nativeMs, browserMs) : browserMs;
}

/**
 * Holds one stopped-but-not-yet-ended session that the same meeting can reclaim.
 * A matching PID with a different meeting key is deliberately NOT enough to reclaim a session:
 * browsers and some native clients keep one process alive across different meetings.
 */
export class SessionContinuity {
  constructor({ graceMs = 300_000, sameProcessGraceMs = 120_000, now = () => Date.now() } = {}) {
    this.graceMs = graceMs;
    // Retained for source compatibility with existing callers; it is not used as identity.
    this.sameProcessGraceMs = Math.min(sameProcessGraceMs, graceMs);
    this.now = now;
    this.pending = null;
  }

  defer({ meetingId, key, title, pid = null, graceMs = this.graceMs }) {
    const previous = this.pending && this.pending.meetingId !== meetingId ? this.pending : null;
    this.pending = { meetingId, key, title, pid, graceMs, deferredAt: this.now() };
    return previous;
  }

  claim(key, { pid = null } = {}) {
    const pending = this.pending;
    if (!pending) return null;
    const age = this.now() - pending.deferredAt;
    if (pending.key !== key || age > pending.graceMs) return null;

    const nativeWildcard = /^(zoom|teams|webex):\*$/.test(String(key));
    const hasBothProcessIds = pid !== null && pending.pid !== null;
    if (nativeWildcard && hasBothProcessIds && pending.pid !== pid) return null;

    this.pending = null;
    return pending;
  }

  release() {
    const pending = this.pending;
    this.pending = null;
    return pending;
  }

  isExpired() {
    return Boolean(this.pending) && this.now() - this.pending.deferredAt > this.pending.graceMs;
  }
}
