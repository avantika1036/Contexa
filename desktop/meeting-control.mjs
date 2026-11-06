import { createHash } from 'node:crypto';
import { isDurableMeetingKey } from './meeting-session.mjs';
import { hasVerifiedActiveWebexDesktopEvidence } from './capture-policy.mjs';

/**
 * Explicitly-ended meeting suppression and single-stream provider arbitration.
 * A suppression belongs to a meeting/window, not to the single most-recently-ended
 * session. This prevents ending Zoom from accidentally unblocking an older Meet.
 */
function normalizeBlocks(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value && typeof value === 'object' ? [value] : [];
}

function isStableProviderMeetingKey(value) {
  const key = String(value || '').trim();
  // Webex desktop identities are anchored to the first verified HWND but remain
  // stable across later HWND recreation. The optional callN suffix is the tracker’s
  // new-call epoch, so a genuinely new call is not suppressed by an older block.
  const webexCallIdentity = /^webex:window:\d+:[A-Za-z0-9_-]{1,80}(?:-call\d+)?$/i;
  return /^(?:meet:[a-z]{3}-[a-z]{4}-[a-z]{3}|(?:zoom|teams|webex):id:\d{8,13}|webex:launch:[a-f0-9]{24})$/i.test(key)
    || webexCallIdentity.test(key);
}

/**
 * Hash a provider meeting identity for privacy-minimized persisted restart blocks.
 * Kept compatible with lifecycle records written by the Phase 2.3 implementation.
 */
export function hashMeetingIdentity(value) {
  const key = String(value || '').trim();
  return key ? createHash('sha256').update(key, 'utf8').digest('hex') : '';
}

/**
 * Match a restart block against a meeting identity. Blocks created by the current
 * in-memory path keep `key`; persisted Phase 2.3 blocks may carry only `identityHash`.
 */
export function restartBlockMatchesIdentity(block, identityKey) {
  const key = String(identityKey || '').trim();
  if (!key) return false;
  if (String(block?.key || '') === key) return true;
  const identityHash = String(block?.identityHash || '').toLowerCase();
  return /^[a-f0-9]{64}$/.test(identityHash)
    && identityHash === hashMeetingIdentity(key);
}

function blockIdentity(block) {
  return [
    String(block.provider || '').toLowerCase(),
    Number(block.pid) || 0,
    String(block.key || ''),
    String(block.windowId || ''),
  ].join('|');
}

/** Add/replace one suppression while retaining the blocks for previously ended meetings. */
export function addRestartBlock(blocks, nextBlock, { maxBlocks = 32 } = {}) {
  const current = normalizeBlocks(blocks);
  if (!nextBlock || !Number(nextBlock.pid) || !String(nextBlock.key || '').trim()) return current;
  const normalized = {
    ...nextBlock,
    pid: Number(nextBlock.pid),
    provider: String(nextBlock.provider || '').toLowerCase() || null,
    key: String(nextBlock.key),
    windowId: nextBlock.windowId ? String(nextBlock.windowId) : null,
    until: Number(nextBlock.until) || 0,
    missingWindowPolls: 0,
  };
  const identity = blockIdentity(normalized);
  return [...current.filter((block) => blockIdentity(block) !== identity), normalized].slice(-Math.max(1, maxBlocks));
}

/**
 * Keep a block while its original top-level HWND still exists. A durable provider call ID
 * survives browser/app replacement, so retain that block until expiry or an explicit
 * terminal-to-present lifecycle transition clears it. Non-durable window/title blocks are
 * released after two missing scans so a new window can be selected safely.
 */
export function reconcileRestartBlocks(blocks, desktopWindows, now = Date.now()) {
  const windows = Array.isArray(desktopWindows) ? desktopWindows : [];
  return normalizeBlocks(blocks).filter((block) => {
    if (now >= Number(block.until || 0)) return false;
    if (isStableProviderMeetingKey(block.key) || !block.windowId) return true;
    const sameWindowExists = windows.some((windowInfo) =>
      Number(windowInfo?.pid) === Number(block.pid)
      && String(windowInfo?.windowId || '') === String(block.windowId)
    );
    if (sameWindowExists) {
      block.missingWindowPolls = 0;
      return true;
    }
    block.missingWindowPolls = Number(block.missingWindowPolls || 0) + 1;
    return block.missingWindowPolls < 2;
  });
}

function isObservationBlocked(observation, blocks, now, keyOf) {
  const pid = Number(observation?.pid ?? observation?.processId);
  const provider = String(observation?.provider || '').toLowerCase();
  const observationKey = String(keyOf(observation) || '');
  const windowId = String(observation?.windowId || '');

  return blocks.some((block) => {
    if (now >= Number(block.until || 0)) return false;
    if (block.provider && provider && provider !== String(block.provider).toLowerCase()) return false;

    const blockKey = String(block.key || '');
    // Durable provider call IDs survive browser/app process replacement. Match these
    // before PID checks, but do not let generic title keys suppress another process.
    if (observationKey && observationKey === blockKey && isStableProviderMeetingKey(observationKey)) return true;

    if (pid !== Number(block.pid)) return false;
    if (observationKey && observationKey === blockKey) return true;

    // If the same provider reuses the same HWND but the title falls back to a generic
    // browser/app title, keep suppressing that old ended window. A different durable
    // call ID in the same HWND is a new meeting and is allowed.
    const sameWindow = Boolean(block.windowId && windowId && windowId === String(block.windowId));
    if (!sameWindow) return false;
    const observationHasDurableId = isStableProviderMeetingKey(observationKey);
    const blockHasDurableId = isStableProviderMeetingKey(blockKey);
    if (observationHasDurableId && blockHasDurableId && observationKey !== blockKey) return false;
    return true;
  });
}

/**
 * Plan an explicit End Meeting action initiated from the Contexa renderer.
 * The UI may only stop the exact session it asked to end; it must not terminate
 * whichever different meeting happens to be active at the time the IPC arrives.
 */
export function planAutoCaptureEnd(meetingId, currentCapture, now, blockMs) {
  const targetId = String(meetingId || '').trim();
  if (!targetId) return { ok: false, reason: 'missing-meeting-id' };
  if (!currentCapture) return { ok: true, shouldStop: false, restartBlock: null };
  if (String(currentCapture.meetingId) !== targetId) {
    // The requested history row is not the stream currently owned by Electron.
    // Finalizing that database row is safe; the live capture must remain untouched.
    return { ok: true, shouldStop: false, restartBlock: null, reason: 'capture-session-mismatch' };
  }

  return {
    ok: true,
    shouldStop: true,
    restartBlock: {
      pid: currentCapture.processId,
      provider: currentCapture.provider || null,
      key: currentCapture.sessionKey,
      windowId: currentCapture.windowId || null,
      until: Number(now) + Math.max(0, Number(blockMs) || 0),
    },
  };
}

/**
 * Select a new capture target only from foreground meetings. Background observations
 * remain registered, but are never allowed to resurrect an old meeting after the user
 * has ended another session or when Contexa starts while an old meeting window is open.
 */
export function selectStartCandidate(matches, blocks, now, keyOf) {
  const rows = Array.isArray(matches) ? matches : [];
  const activeBlocks = normalizeBlocks(blocks).filter((block) => now < Number(block.until || 0));
  const eligible = rows.filter((row) => {
    const state = String(row?.state || '').toLowerCase();
    if (['left', 'ended', 'temporarily_missing', 'unknown'].includes(state)) return false;
    if (row?.foreground !== true && row?.windowFocus !== 'foreground') return false;
    return !isObservationBlocked(row, activeBlocks, now, keyOf);
  });
  const candidate = eligible.sort((a, b) => {
    const confidenceRank = (value) => value === 'high' ? 2 : value === 'medium' ? 1 : 0;
    return confidenceRank(b.confidence) - confidenceRank(a.confidence);
  })[0] || null;
  return { candidate, block: activeBlocks, blocks: activeBlocks };
}

/**
 * Return whether an observation represents the exact meeting whose stream is active.
 * Durable call IDs survive process/window replacement. Non-durable title fallbacks are
 * scoped to their owning process/window so two generic-title windows are not conflated.
 */
function isSameCaptureMeeting(row, currentCapture) {
  const provider = String(currentCapture?.provider || '').toLowerCase();
  const rowProvider = String(row?.provider || '').toLowerCase();
  if (!provider || rowProvider !== provider) return false;

  const currentKey = String(currentCapture?.sessionKey || '').trim();
  const rowKey = String(row?.identityKey || '').trim();
  if (!currentKey || !rowKey || currentKey !== rowKey) return false;
  if (isStableProviderMeetingKey(currentKey)) return true;

  const currentPid = Number(currentCapture.processId);
  const rowPid = Number(row?.pid ?? row?.processId);
  if (!Number.isInteger(currentPid) || currentPid <= 0 || rowPid !== currentPid) return false;

  const currentWindowId = String(currentCapture.windowId || '');
  const rowWindowId = String(row?.windowId || '');
  return !currentWindowId || !rowWindowId || currentWindowId === rowWindowId;
}

function isForegroundObservation(row) {
  // Keep handoff eligibility consistent with initial start selection. A verified
  // active Webex desktop call is a special case: a freshly inspected End Meeting
  // control is direct evidence that the call is live even when the app is behind
  // Contexa or another window. Ordinary background meetings remain ineligible.
  return row?.foreground === true
    || row?.windowFocus === 'foreground'
    || hasVerifiedActiveWebexDesktopEvidence(row);
}

function isActuallyForeground(row) {
  return row?.foreground === true || row?.windowFocus === 'foreground';
}

function candidateMeetingKey(row) {
  const provider = String(row?.provider || '').toLowerCase();
  const identityKey = String(row?.identityKey || '').trim();
  const pid = Number(row?.pid ?? row?.processId);
  const windowId = String(row?.windowId || '');
  if (!provider || !identityKey) return '';
  if (isStableProviderMeetingKey(identityKey)) return `${provider}|${identityKey}`;
  // A title may become generic during startup. Keeping the same HWND stable avoids
  // resetting confirmation just because its display title changed between polls.
  return `${provider}|pid:${Number.isInteger(pid) ? pid : 0}|hwnd:${windowId || 'unknown'}`;
}

function compareHandoffCandidates(left, right) {
  const confidenceRank = (value) => value === 'high' ? 2 : value === 'medium' ? 1 : 0;
  const stateRank = (value) => ({ active: 4, joining: 3, candidate: 2, background: 1 })[String(value || '').toLowerCase()] || 0;
  // A genuinely foreground meeting always outranks the verified-background Webex
  // exception, even if Webex has stronger lifecycle evidence.
  const foregroundDifference = Number(isActuallyForeground(right)) - Number(isActuallyForeground(left));
  if (foregroundDifference) return foregroundDifference;
  const confidenceDifference = confidenceRank(right.confidence) - confidenceRank(left.confidence);
  if (confidenceDifference) return confidenceDifference;
  const stateDifference = stateRank(right.state) - stateRank(left.state);
  if (stateDifference) return stateDifference;
  const leftKey = candidateMeetingKey(left);
  const rightKey = candidateMeetingKey(right);
  return leftKey.localeCompare(rightKey, 'en');
}

/**
 * Confirms a deliberate switch from the currently captured meeting to a different
 * foreground meeting, including another meeting from the same provider or process.
 * The current meeting must be backgrounded and its meeting-side audio must have gone
 * quiet. Microphone activity is intentionally ignored. This arbitrates one capture
 * slot; it does not create simultaneous or isolated audio streams.
 */
export class MeetingHandoffTracker {
  constructor({ quietMs = 30_000, confirmations = 2, candidateWindowMs = 15_000 } = {}) {
    this.quietMs = Math.max(0, Number(quietMs) || 0);
    this.confirmations = Math.max(1, Math.floor(Number(confirmations) || 1));
    this.candidateWindowMs = Math.max(1_000, Number(candidateWindowMs) || 15_000);
    this.pending = null;
  }

  reset() {
    this.pending = null;
  }

  observe(observations, currentCapture, {
    now = Date.now(),
    transitionType = 'missing',
    lastMeetingAudioAt = 0,
    restartBlock = null,
    restartBlocks = null,
  } = {}) {
    if (!currentCapture?.provider) {
      this.reset();
      return null;
    }

    const rows = Array.isArray(observations) ? observations : [];
    const blocks = normalizeBlocks(restartBlocks ?? restartBlock);
    const currentRows = rows.filter((row) => isSameCaptureMeeting(row, currentCapture));
    // Determine whether the *currently captured* window lost actual OS focus.
    // The verified-background Webex exception is only for choosing a candidate;
    // it must not make a backgrounded current Webex capture look foregrounded.
    const currentIsBackground = currentRows.length
      ? currentRows.every((row) => !isActuallyForeground(row))
      : transitionType === 'missing' || currentCapture.detectionState === 'browser-tab-unverified';

    const meetingAudioAt = Number(lastMeetingAudioAt) || 0;
    // A meeting can be perfectly valid while nobody on the remote side speaks.
    // In that case there is no lastMeetingAudioAt timestamp; use capture start as
    // the quiet baseline instead of making a handoff impossible forever. Once any
    // remote audio is observed, its most recent timestamp takes precedence.
    const captureStartedAt = Number(currentCapture.startedAt) || 0;
    const quietSince = meetingAudioAt > 0 ? meetingAudioAt : captureStartedAt;
    const hasQuietBaseline = quietSince > 0;
    const meetingAudioQuietMs = hasQuietBaseline ? Math.max(0, now - quietSince) : 0;

    if (!currentIsBackground || !hasQuietBaseline || meetingAudioQuietMs < this.quietMs) {
      this.reset();
      return null;
    }

    const blocked = (row) => isObservationBlocked(row, blocks, now, (candidate) => candidate?.identityKey);
    const candidates = rows.filter((row) => {
      const rowPid = Number(row?.pid ?? row?.processId);
      const state = String(row?.state || '').toLowerCase();
      const confidence = String(row?.confidence || '').toLowerCase();
      const provider = String(row?.provider || '').trim().toLowerCase();
      const identityKey = String(row?.identityKey || '').trim();
      // A generic Google Meet page title is not enough evidence to move an already
      // captured stream to another browser process. It may be the same call still
      // loading its code, or merely the Meet home/pre-join page. Wait until the
      // provider exposes `meet:<code>`: the same call will then be recognized as a
      // duplicate representation, while a genuinely different call can hand off.
      const unconfirmedGoogleMeet = provider === 'google_meet'
        && !/^meet:[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(identityKey);
      return provider
        && identityKey
        && !unconfirmedGoogleMeet
        && Number.isInteger(rowPid)
        && rowPid > 0
        // loopback-capture is process-scoped today. A second meeting in the same PID
        // cannot be attributed to an independent transcript/session until Phase 3 adds
        // tab-isolated capture, so never hand off within that PID.
        && rowPid !== Number(currentCapture.processId)
        && !isSameCaptureMeeting(row, currentCapture)
        && isForegroundObservation(row)
        && !['left', 'ended', 'temporarily_missing', 'unknown'].includes(state)
        && ['high', 'medium'].includes(confidence)
        && !blocked(row);
    });

    if (!candidates.length) {
      // A disappeared, ended, blocked or otherwise ineligible candidate breaks the
      // confirmation chain. A later reappearance must earn fresh confirmations.
      this.reset();
      return null;
    }

    const candidate = [...candidates].sort(compareHandoffCandidates)[0];
    const key = candidateMeetingKey(candidate);
    if (!key) {
      this.reset();
      return null;
    }

    if (this.pending && this.pending.key === key
      && now - this.pending.lastSeenAt <= this.candidateWindowMs) {
      this.pending.confirmations += 1;
      this.pending.lastSeenAt = now;
      this.pending.candidate = candidate;
    } else {
      this.pending = {
        key,
        candidate,
        confirmations: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      };
    }

    if (this.pending.confirmations < this.confirmations) return null;
    const confirmed = this.pending.candidate;
    this.reset();
    return confirmed;
  }
}

// Backwards-compatible export for callers/tests that used the earlier provider-only
// tracker name. Its behavior now covers any distinct meeting identity.
export class CrossProviderHandoffTracker extends MeetingHandoffTracker {}
