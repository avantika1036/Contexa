// Decides when automatic capture should stop, and when a just-ended window must not restart it.
//
// Window titles alone are unreliable: provider adapters only identify candidates.
// Capture lifecycle decisions combine these observations with continuity and audio evidence.

import { detectProviderWindow } from './providers/index.mjs';
import { isDurableMeetingKey } from './meeting-session.mjs';

export const DEFAULT_POLICY = Object.freeze({
  stopAfterMissingMs: 15_000,        // meeting window not seen for this long...
  quietBeforeMissingStopMs: 30_000,  // ...AND nobody has been audible for this long => stop
  maxMissingWhileAudibleMs: 180_000, // a missing window never keeps capture alive past this
  idleEndMs: 180_000,                // no audible activity at all for this long => meeting over
  neverAudibleIdleMs: 600_000,       // ...but wait longer if nothing was ever heard (waiting alone)
});

/**
 * Return true only when one provider-specific adapter recognizes this process/title pair.
 * The adapters identify candidate windows; they do not decide whether a call is live.
 */
export function isSupportedMeetingWindow(processName, title, metadata = {}) {
  return Boolean(detectProviderWindow(processName, title, metadata));
}

/**
 * @returns {null | { reason: 'window-missing' | 'idle', missingForMs: number, quietForMs: number }}
 */
export function captureStopReason({ now, startedAt, lastMatchedAt, lastAudibleAt, lastMeetingAudioAt = lastAudibleAt, policy = {} }) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const missingForMs = now - lastMatchedAt;
  // A microphone can remain active after the user leaves a call. It is not reliable
  // evidence that the provider meeting itself is still live. Prefer application-side
  // meeting audio for the lifecycle idle clock; retain lastAudibleAt as a fallback
  // for older callers and tests.
  const meetingAudioAt = Number(lastMeetingAudioAt) || 0;
  const quietForMs = now - (meetingAudioAt || startedAt);

  if (missingForMs >= p.stopAfterMissingMs) {
    // While people are still talking, a flapping window title must not cut the meeting in two.
    const keptAliveByAudio = quietForMs < p.quietBeforeMissingStopMs && missingForMs < p.maxMissingWhileAudibleMs;
    if (!keptAliveByAudio) return { reason: 'window-missing', missingForMs, quietForMs };
  }
  const heardAnything = Boolean(meetingAudioAt);
  const idleLimit = heardAnything ? p.idleEndMs : Math.max(p.idleEndMs, p.neverAudibleIdleMs);
  if (p.idleEndMs > 0 && quietForMs >= idleLimit) {
    return { reason: 'idle', missingForMs, quietForMs, activitySource: meetingAudioAt ? 'meeting-audio' : 'no-meeting-audio-observed' };
  }
  return null;
}

/**
 * Select a new capture target only from foreground meetings. Background observations
 * remain in the lifecycle registry, but should not start or resurrect capture by themselves.
 * `blocks` accepts either the legacy single-block shape or the current array of blocks.
 */
function normalizeRestartBlocks(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value && typeof value === 'object' ? [value] : [];
}

function isDurableKey(value) {
  return /^(?:meet:[a-z]{3}-[a-z]{4}-[a-z]{3}|(?:zoom|teams|webex):id:\d{8,13}|webex:launch:[a-f0-9]{24}|webex:window:\d+:[A-Za-z0-9_-]{1,80}(?:-call\d+)?)$/i.test(String(value || ''));
}

function lifecycleIdentityForObservation(row) {
  const provider = String(row?.provider || '').toLowerCase();
  const identityKey = String(row?.identityKey || '').trim();
  if (!provider || !identityKey) return '';
  if (row?.lifecycleKey) return String(row.lifecycleKey);
  if (row?.durableIdentity === true || isDurableMeetingKey(identityKey)) {
    return `${provider}|${identityKey}`;
  }
  const pid = Number(row?.pid ?? row?.processId);
  const windowId = String(row?.windowId || '');
  return `${provider}|${identityKey}|pid:${Number.isInteger(pid) ? pid : 0}|hwnd:${windowId || 'unknown'}`;
}

/**
 * Return process IDs that currently represent more than one independent meeting.
 * Process-loopback audio cannot separate those meetings, so auto capture must not
 * start or remain attached to either one until a meeting-tab/native isolated source
 * is available. Duplicate windows for one durable meeting remain a single identity.
 */
function flattenMeetingObservationRows(observations) {
  const rows = [];
  for (const item of Array.isArray(observations) ? observations : []) {
    if (Array.isArray(item?.windows)) {
      for (const window of item.windows) {
        rows.push({
          ...window,
          provider: item.provider,
          identityKey: item.identityKey,
          durableIdentity: item.durableIdentity === true,
          lifecycleKey: item.lifecycleKey,
        });
      }
    } else if (item && typeof item === 'object') {
      rows.push(item);
    }
  }
  return rows;
}

export function findAmbiguousMeetingProcessIds(observations) {
  // Retained lifecycle snapshots contain window records that may have disappeared
  // from the latest EnumWindows scan. Treat temporarily-missing records as potentially
  // active during the configured missing grace period. `unknown` is the post-grace
  // state: retain it for recovery/history, but no longer treat it as current.
  const states = new Set(['candidate', 'joining', 'active', 'background', 'temporarily_missing']);
  const rows = flattenMeetingObservationRows(observations);

  // Google Meet may briefly expose a generic `browser:*` surface while the same
  // browser process also has a call-specific `meet:<code>` observation. A generic
  // background surface is not proof of a second live call. Do not let it veto a
  // known call merely because the browser title changed or another ordinary Meet
  // page is open. A foreground generic Meet surface alongside a different call is
  // still treated as ambiguous, because it may be a second pre-join/live meeting.
  const concreteGoogleMeetPids = new Set(rows
    .filter((row) => String(row?.provider || '').toLowerCase() === 'google_meet'
      && /^meet:[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(String(row?.identityKey || '')))
    .map((row) => Number(row?.pid ?? row?.processId))
    .filter((pid) => Number.isInteger(pid) && pid > 0));

  // A single Google Meet HWND can change from a page-title fallback such as
  // `browser:google meet: online...` to its durable `meet:<code>` identity after
  // the call loads. The lifecycle registry intentionally keeps both identity
  // histories for recovery, but they are NOT two independent meetings when they
  // refer to the exact same PID + HWND. A different HWND remains independent.
  const concreteGoogleMeetWindows = new Set(rows
    .filter((row) => String(row?.provider || '').toLowerCase() === 'google_meet'
      && /^meet:[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(String(row?.identityKey || ''))
      && String(row?.windowId || '').trim())
    .map((row) => `${Number(row?.pid ?? row?.processId)}|${String(row.windowId)}`));

  const identitiesByPid = new Map();
  for (const row of rows) {
    const pid = Number(row?.pid ?? row?.processId);
    const state = String(row?.state || '').toLowerCase();
    const identity = lifecycleIdentityForObservation(row);
    if (!Number.isInteger(pid) || pid <= 0 || !states.has(state) || !identity) continue;

    const provider = String(row?.provider || '').toLowerCase();
    const identityKey = String(row?.identityKey || '').trim().toLowerCase();
    const isGenericGoogleMeet = provider === 'google_meet' && identityKey === 'browser:*';
    const isForeground = row?.foreground === true || row?.windowFocus === 'foreground';
    if (isGenericGoogleMeet && concreteGoogleMeetPids.has(pid) && !isForeground) continue;

    const isProvisionalGoogleMeet = provider === 'google_meet'
      && identityKey.startsWith('browser:')
      && !/^meet:[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(identityKey);
    const windowId = String(row?.windowId || '').trim();
    if (isProvisionalGoogleMeet && windowId
      && concreteGoogleMeetWindows.has(`${pid}|${windowId}`)) continue;

    const identities = identitiesByPid.get(pid) || new Set();
    identities.add(identity);
    identitiesByPid.set(pid, identities);
  }
  return [...identitiesByPid.entries()]
    .filter(([, identities]) => identities.size > 1)
    .map(([pid]) => pid)
    .sort((left, right) => left - right);
}

/** Return privacy-minimized identity/state diagnostics for one ambiguous process. */
export function describeMeetingProcessIdentities(observations, processId) {
  const wantedPid = Number(processId);
  if (!Number.isInteger(wantedPid) || wantedPid <= 0) return [];
  const summaries = new Map();
  const rows = flattenMeetingObservationRows(observations);
  const concreteGoogleMeetWindows = new Set(rows
    .filter((row) => String(row?.provider || '').toLowerCase() === 'google_meet'
      && /^meet:[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(String(row?.identityKey || ''))
      && String(row?.windowId || '').trim())
    .map((row) => `${Number(row?.pid ?? row?.processId)}|${String(row.windowId)}`));

  for (const row of rows) {
    const pid = Number(row?.pid ?? row?.processId);
    if (pid !== wantedPid) continue;
    const provider = String(row?.provider || 'unknown').toLowerCase();
    const identityKey = String(row?.identityKey || 'unknown');
    const windowId = String(row?.windowId || '').trim();
    if (provider === 'google_meet' && identityKey.toLowerCase().startsWith('browser:')
      && windowId && concreteGoogleMeetWindows.has(`${pid}|${windowId}`)) continue;
    const state = String(row?.state || 'unknown').toLowerCase();
    const focus = row?.foreground === true || row?.windowFocus === 'foreground' ? 'foreground' : 'background';
    const key = `${provider}|${identityKey}|${state}|${focus}|${windowId}`;
    summaries.set(key, `${provider}/${identityKey}:${state}:${focus}${windowId ? `:hwnd=${windowId}` : ''}`);
  }
  return [...summaries.values()].sort((a, b) => a.localeCompare(b, 'en'));
}

function isRestartBlocked(row, blocks, now, keyOf) {
  const pid = Number(row?.pid ?? row?.processId);
  const provider = String(row?.provider || '').toLowerCase();
  const key = String(keyOf(row) || '');
  const windowId = String(row?.windowId || '');
  return blocks.some((block) => {
    if (now >= Number(block.until || 0)) return false;
    if (block.provider && provider && provider !== String(block.provider).toLowerCase()) return false;

    const blockedKey = String(block.key || '');
    // A durable call ID identifies the meeting independently of its browser process
    // or HWND. Check it before the PID/window fallback: Chrome can restart while the
    // same Google Meet call is still open, producing a different PID and HWND.
    if (key && key === blockedKey && isDurableKey(key)) return true;

    // Non-durable keys (for example provider/title fallbacks) remain scoped to the
    // original process. They must not suppress a different process that happens to
    // show the same generic title.
    if (pid !== Number(block.pid)) return false;
    if (key && key === blockedKey) return true;
    if (!block.windowId || !windowId || windowId !== String(block.windowId)) return false;
    // A different explicit call ID in the same browser/native HWND is a new meeting.
    if (isDurableKey(key) && isDurableKey(blockedKey) && key !== blockedKey) return false;
    // Generic-title fallback on the same HWND still belongs to the explicitly-ended window.
    return true;
  });
}

export function hasVerifiedActiveWebexDesktopEvidence(row) {
  if (String(row?.provider || '').toLowerCase() !== 'webex') return false;
  if (String(row?.source || '').toLowerCase() !== 'native_window') return false;
  if (String(row?.state || '').toLowerCase() !== 'active' || row?.confidence !== 'high') return false;
  if (!/^webex:window:\d+:[A-Za-z0-9_-]+$/i.test(String(row?.identityKey || ''))) return false;
  return Array.isArray(row?.evidence) && row.evidence.some((item) =>
    item?.kind === 'webex_accessibility' && item?.value === 'end-meeting-control-present'
  );
}

export function selectStartCandidate(matches, blocks, now, keyOf, registrySnapshot = null) {
  const rows = Array.isArray(matches) ? matches : [];
  const ambiguitySource = registrySnapshot ? [...rows, ...registrySnapshot] : rows;
  const ambiguousProcessIds = new Set(findAmbiguousMeetingProcessIds(ambiguitySource));
  const activeBlocks = normalizeRestartBlocks(blocks).filter((block) => now < Number(block.until || 0));
  const eligible = rows.filter((row) => {
    const pid = Number(row?.pid ?? row?.processId);
    if (ambiguousProcessIds.has(pid)) return false;
    const state = String(row?.state || '').toLowerCase();
    if (['left', 'ended', 'temporarily_missing', 'unknown'].includes(state)) return false;
    // Normal background windows must never steal the capture slot. Webex Desktop is
    // the sole exception: an inspected `End meeting` accessibility control is direct
    // evidence that a call is active, even while Contexa or another window has focus.
    // Requiring its PID/HWND identity, source, state, confidence and evidence prevents
    // an idle Webex Home window or an ordinary browser title from bypassing focus safety.
    const verifiedBackgroundWebex = hasVerifiedActiveWebexDesktopEvidence(row);
    if (row?.foreground !== true && row?.windowFocus !== 'foreground' && !verifiedBackgroundWebex) return false;
    return !isRestartBlocked(row, activeBlocks, now, keyOf);
  });
  const candidate = eligible.sort((a, b) => {
    const confidenceRank = (value) => value === 'high' ? 2 : value === 'medium' ? 1 : 0;
    const stateRank = (value) => ({ active: 4, joining: 3, candidate: 2, background: 1 })[String(value || '').toLowerCase()] || 0;
    const foregroundRank = (row) => row?.foreground === true || row?.windowFocus === 'foreground' ? 1 : 0;
    const foregroundDifference = foregroundRank(b) - foregroundRank(a);
    if (foregroundDifference) return foregroundDifference;
    const confidenceDifference = confidenceRank(b.confidence) - confidenceRank(a.confidence);
    if (confidenceDifference) return confidenceDifference;
    const stateDifference = stateRank(b.state) - stateRank(a.state);
    if (stateDifference) return stateDifference;
    const observedDifference = (Number(b.observedAt) || 0) - (Number(a.observedAt) || 0);
    if (observedDifference) return observedDifference;
    const keyOf = (row) => [
      String(row?.provider || '').toLowerCase(),
      String(row?.identityKey || ''),
      Number(row?.pid ?? row?.processId) || 0,
      String(row?.windowId || ''),
    ].join('|');
    return keyOf(a).localeCompare(keyOf(b), 'en');
  })[0] || null;
  return { candidate, block: activeBlocks, blocks: activeBlocks };
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
      windowId: window.windowId ? String(window.windowId) : null,
      title: String(window.title || '')
        .replace(/\s+-\s+(Google Chrome|Microsoft Edge|Mozilla Firefox|Brave)$/i, '')
        .trim()
        .slice(0, 180),
      foreground: Boolean(window.foreground),
      foregroundProcessId: Number.isInteger(Number(window.foregroundProcessId)) ? Number(window.foregroundProcessId) : null,
      foregroundWindowId: window.foregroundWindowId ? String(window.foregroundWindowId) : null,
      // Sanitized native Webex process/accessibility evidence. Raw command lines,
      // protocol URIs, join tokens and accessibility tree contents are never retained.
      ...(window.webexHostedInstance === true ? { webexHostedInstance: true } : {}),
      ...(window.webexExecutablePathVerified === true ? { webexExecutablePathVerified: true } : {}),
      ...(window.webexAccessoriesHelper === true ? { webexAccessoriesHelper: true } : {}),
      ...(window.webexUiAutomationInspected === true ? { webexUiAutomationInspected: true } : {}),
      ...(typeof window.webexUiAutomationError === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(window.webexUiAutomationError)
        ? { webexUiAutomationError: window.webexUiAutomationError }
        : {}),
      ...(window.webexMeetingControlsPresent === true
        && (window.webexUiAutomationInspected === true || window.webexMeetingControlsStale === true)
        ? { webexMeetingControlsPresent: true }
        : {}),
      ...(window.webexMeetingControlsStale === true ? { webexMeetingControlsStale: true } : {}),
      ...(window.webexCanonicalWindowId && /^[A-Za-z0-9_-]{1,80}$/.test(String(window.webexCanonicalWindowId))
        ? { webexCanonicalWindowId: String(window.webexCanonicalWindowId) }
        : {}),
      ...(Number.isInteger(Number(window.webexCallEpoch)) && Number(window.webexCallEpoch) > 0
        ? { webexCallEpoch: Number(window.webexCallEpoch) }
        : {}),
      ...(window.webexWindowIdentityChanged === true ? { webexWindowIdentityChanged: true } : {}),
      ...(window.webexMeetingEnded === true ? { webexMeetingEnded: true } : {}),
    }))
    .sort((left, right) => Number(right.foreground) - Number(left.foreground));
}

/** Meeting-only view used when selecting new sessions and resolving stable call IDs. */
export function normalizeMeetingWindows(rawWindows) {
  const windows = normalizeDesktopWindows(rawWindows);
  const supported = windows.filter((window) => isSupportedMeetingWindow(window.processName, window.title, window));

  // Some Chromium/Teams builds return a focused child/owned HWND that does not match
  // the top-level HWND returned by EnumWindows. The snapshot includes the foreground
  // PID and root HWND. Prefer exact HWND evidence; only fall back to PID when exactly
  // one supported meeting window belongs to that foreground process. This avoids
  // promoting multiple background calls in the same Chrome process.
  if (!supported.some((window) => window.foreground)) {
    const foregroundRow = windows.find((window) => Number(window.foregroundProcessId) > 0);
    const foregroundPid = foregroundRow?.foregroundProcessId;
    const foregroundRootKnown = Boolean(foregroundRow?.foregroundWindowId)
      && windows.some((window) => window.windowId === foregroundRow.foregroundWindowId);
    if (foregroundPid && !foregroundRootKnown) {
      const sameProcessWindows = windows.filter((window) => window.pid === foregroundPid);
      const foregroundCandidates = supported.filter((window) => window.pid === foregroundPid);
      // PID fallback is safe only when there is one top-level window in the process.
      // If multiple browser windows share the PID, require the exact foreground HWND.
      if (sameProcessWindows.length === 1 && foregroundCandidates.length === 1) {
        foregroundCandidates[0].foreground = true;
      }
    }
  }

  return supported.sort((left, right) => Number(right.foreground) - Number(left.foreground));
}
