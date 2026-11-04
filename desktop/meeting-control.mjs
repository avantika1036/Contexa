import { createHash } from 'node:crypto';
import { isDurableMeetingKey } from './meeting-session.mjs';

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
 * Confirms a deliberate switch to a different provider before releasing Contexa's
 * single active audio stream. A candidate must remain foreground across multiple
 * detector polls while the previous capture is no longer foreground and its
 * meeting-side audio has gone quiet. Microphone activity is intentionally ignored.
 */
export class CrossProviderHandoffTracker {
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
    const provider = String(currentCapture.provider).toLowerCase();
    const pid = Number(currentCapture.processId);
    const sessionKey = String(currentCapture.sessionKey || '');
    const currentRows = rows.filter((row) =>
      String(row?.provider || '').toLowerCase() === provider
      && Number(row?.pid ?? row?.processId) === pid
      && (!sessionKey || String(row?.identityKey || '') === sessionKey)
    );
    const currentIsBackground = currentRows.length
      ? currentRows.every((row) => row.foreground !== true && row.windowFocus !== 'foreground')
      : transitionType === 'missing' || currentCapture.detectionState === 'browser-tab-unverified';

    const meetingAudioAt = Number(lastMeetingAudioAt) || 0;
    const meetingAudioQuietMs = meetingAudioAt > 0
      ? Math.max(0, now - meetingAudioAt)
      : 0;

    if (!currentIsBackground || !meetingAudioAt || meetingAudioQuietMs < this.quietMs) {
      this.reset();
      return null;
    }

    const blocked = (row) => isObservationBlocked(row, blocks, now, (candidate) => candidate?.identityKey);
    const candidates = rows.filter((row) => {
      const rowProvider = String(row?.provider || '').toLowerCase();
      const rowPid = Number(row?.pid ?? row?.processId);
      const state = String(row?.state || '').toLowerCase();
      const confidence = String(row?.confidence || '').toLowerCase();
      return rowProvider
        && rowProvider !== provider
        && Number.isInteger(rowPid)
        && rowPid > 0
        && rowPid !== pid
        && (row.foreground === true || row.windowFocus === 'foreground')
        && !['left', 'ended', 'temporarily_missing', 'unknown'].includes(state)
        && ['high', 'medium'].includes(confidence)
        && !blocked(row);
    });

    if (!candidates.length) {
      if (this.pending && now - this.pending.lastSeenAt > this.candidateWindowMs) this.reset();
      return null;
    }

    // A provider/PID pair is stable even when its window title changes from a named
    // call to a generic app title during startup (for example Zoom -> Zoom Meeting).
    const candidate = candidates.sort((a, b) => {
      const confidenceRank = (value) => value === 'high' ? 2 : 1;
      return confidenceRank(b.confidence) - confidenceRank(a.confidence);
    })[0];
    const candidateKey = `${String(candidate.provider).toLowerCase()}|${Number(candidate.pid ?? candidate.processId)}`;

    if (this.pending && this.pending.key === candidateKey
      && now - this.pending.lastSeenAt <= this.candidateWindowMs) {
      this.pending.confirmations += 1;
      this.pending.lastSeenAt = now;
      this.pending.candidate = candidate;
    } else {
      this.pending = {
        key: candidateKey,
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
