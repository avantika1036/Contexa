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
