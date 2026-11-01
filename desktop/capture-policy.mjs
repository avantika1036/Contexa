// Decides when automatic capture should stop, and when a just-ended window must not restart it.
//
// Window titles alone are unreliable: a browser reports only its active tab's title, Zoom has
// several windows, and a "You left the meeting" page keeps matching after the call is over.
// Audio activity is the stronger signal, so both are combined.

export const DEFAULT_POLICY = Object.freeze({
  stopAfterMissingMs: 15_000,        // meeting window not seen for this long...
  quietBeforeMissingStopMs: 30_000,  // ...AND nobody has been audible for this long => stop
  maxMissingWhileAudibleMs: 180_000, // a missing window never keeps capture alive past this
  idleEndMs: 180_000,                // no audible activity at all for this long => meeting over
  neverAudibleIdleMs: 600_000,       // ...but wait longer if nothing was ever heard (waiting alone)
});

const CAPTURED_PROCESS_NAMES = new Set([
  'zoom', 'zoomworkplace', 'zoom meetings', 'ms-teams', 'teams', 'webex',
  'ciscocollabhost', 'chrome', 'msedge', 'brave', 'firefox',
]);

/**
 * Return true only for a supported meeting window, not an ordinary app/browser window.
 * Google Meet's title commonly changes from the generic "Google Meet" during initial
 * loading to the stable "Meet - abc-defg-hij" form. The latter must remain detectable
 * after Electron restarts, otherwise the persisted suspended session is never reclaimed.
 */
export function isSupportedMeetingWindow(processName, title) {
  const process = String(processName || '').toLowerCase().replace(/\.exe$/, '').trim();
  const name = String(title || '').trim();
  const lower = name.toLowerCase();
  if (!name || !CAPTURED_PROCESS_NAMES.has(process)) return false;

  if (['zoom', 'zoomworkplace', 'zoom meetings'].includes(process)) {
    return /\bzoom\s+meeting\b|\bmeeting\b.*\bzoom\b|\bcall\b.*\bzoom\b|\bzoom\b.*\bcall\b/i.test(name)
      && !/home|settings|contacts|chat|schedule/i.test(lower);
  }
  if (['ms-teams', 'teams'].includes(process)) {
    return /\bmeeting\b|\bcall\b|\bhuddle\b/i.test(name)
      && /teams|meeting|call|huddle/i.test(lower)
      && !/settings|chat list|activity/i.test(lower);
  }
  if (['webex', 'ciscocollabhost'].includes(process)) {
    return /\bmeeting\b|\bcall\b|\bwebex\b/i.test(name)
      && !/home|settings|chat|calendar/i.test(lower);
  }

  // Include the explicit Google Meet call-code title. Keep the generic/provider URL
  // patterns for compatibility with other browser meeting surfaces.
  return /google meet|\bmeet\s*[-–|]\s*[a-z]{3}-[a-z]{4}-[a-z]{3}\b|meet\s*[-–|].*chrome|meet\s*[-–|].*edge|meet\.google|zoom meeting|zoom\.us.*meeting|meeting.*zoom|microsoft teams.*meeting|meeting.*microsoft teams|teams\.microsoft|webex.*meeting|meeting.*webex/i.test(name)
    && !/settings|extensions|history|downloads/i.test(lower);
}

/**
 * @returns {null | { reason: 'window-missing' | 'idle', missingForMs: number, quietForMs: number }}
 */
export function captureStopReason({ now, startedAt, lastMatchedAt, lastAudibleAt, policy = {} }) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const missingForMs = now - lastMatchedAt;
  const quietForMs = now - (lastAudibleAt || startedAt);

  if (missingForMs >= p.stopAfterMissingMs) {
    // While people are still talking, a flapping window title must not cut the meeting in two.
    const keptAliveByAudio = quietForMs < p.quietBeforeMissingStopMs && missingForMs < p.maxMissingWhileAudibleMs;
    if (!keptAliveByAudio) return { reason: 'window-missing', missingForMs, quietForMs };
  }
  const heardAnything = Boolean(lastAudibleAt);
  const idleLimit = heardAnything ? p.idleEndMs : Math.max(p.idleEndMs, p.neverAudibleIdleMs);
  if (p.idleEndMs > 0 && quietForMs >= idleLimit) {
    return { reason: 'idle', missingForMs, quietForMs };
  }
  return null;
}

/**
 * After an idle stop the meeting page usually still matches ("You left the meeting"), so the
 * same window must not immediately start a new capture. The block lifts when that window
 * disappears (tab closed, new call) or after `until`.
 */
export function selectStartCandidate(matches, block, now, keyOf) {
  let activeBlock = block;
  if (activeBlock) {
    const stillPresent = matches.some((m) => m.pid === activeBlock.pid && keyOf(m) === activeBlock.key);
    if (!stillPresent || now >= activeBlock.until) activeBlock = null;
  }
  const candidate = matches.find((m) => !(activeBlock && m.pid === activeBlock.pid && keyOf(m) === activeBlock.key)) || null;
  return { candidate, block: activeBlock };
}

/**
 * Auto Capture is on by default once the user has given recording consent, and stays on across
 * restarts until the user explicitly pauses it. Without recorded consent it is never on.
 */
export function resolveAutoCapture(settings) {
  if (settings.consentVersion !== 1) return false;
  return settings.autoCapturePausedByUser !== true;
}

/**
 * Normalize every visible top-level HWND returned by EnumWindows.
 * Keep non-meeting browser windows too: the selected tab title can change while the
 * original Meet call remains alive in another tab of the same browser process.
 */
export function normalizeDesktopWindows(rawWindows) {
  const rows = Array.isArray(rawWindows) ? rawWindows : rawWindows ? [rawWindows] : [];
  return rows
    .filter((window) => Number.isInteger(Number(window?.pid)) && Number(window.pid) > 0
      && String(window?.processName || '').trim().length > 0)
    .map((window) => ({
      pid: Number(window.pid),
      processName: String(window.processName),
      title: String(window.title || '')
        .replace(/\s+-\s+(Google Chrome|Microsoft Edge|Mozilla Firefox|Brave)$/i, '')
        .trim()
        .slice(0, 180),
      foreground: Boolean(window.foreground),
    }))
    .sort((left, right) => Number(right.foreground) - Number(left.foreground));
}

/** Meeting-only view used when selecting new sessions and resolving stable call IDs. */
export function normalizeMeetingWindows(rawWindows) {
  return normalizeDesktopWindows(rawWindows)
    .filter((window) => isSupportedMeetingWindow(window.processName, window.title));
}
