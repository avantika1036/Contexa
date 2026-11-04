const HOST_PROCESS = 'ciscocollabhost';
const DEFAULT_MISSED_POLLS_TO_END = 2;
const DEFAULT_RETENTION_MS = 30 * 60 * 1000;
const DEFAULT_WINDOW_ABSENCE_GRACE_MS = 20 * 1000;

function normalizeProcessName(value) {
  return String(value || '').toLowerCase().replace(/\.exe$/, '').replace(/[\s_-]/g, '');
}

function validWindowId(windowInfo) {
  const value = String(windowInfo?.windowId || '');
  return /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null;
}

function createEntry(pid, now) {
  return {
    pid,
    callEpoch: 0,
    canonicalWindowId: null,
    currentWindowIds: [],
    hasSeenMeetingControls: false,
    missingPolls: 0,
    ended: false,
    lastSeenAt: now,
    lastWindowSeenAt: null,
    lastPositiveAt: null,
    windowMissingSince: null,
    windowMissingPolls: 0,
  };
}

/**
 * Debounces Webex desktop UI Automation evidence at the hosted-process/call level,
 * not at the HWND level.
 *
 * CiscoCollabHost can recreate its top-level `Webex` HWND while the same call remains
 * active. A new HWND with verified meeting controls therefore inherits the current
 * call's canonical identity while that call has not been observed to end. Two
 * successful UIA scans without meeting controls terminate the call. A later positive
 * scan starts a new call epoch, including when Windows reuses the same HWND.
 *
 * Missing window snapshots and UIA failures are unknown, not terminal. They do not
 * increment the successful-miss debounce counter.
 */
export class WebexMeetingControlTracker {
  constructor({
    missedPollsToEnd = DEFAULT_MISSED_POLLS_TO_END,
    retentionMs = DEFAULT_RETENTION_MS,
    windowAbsenceGraceMs = DEFAULT_WINDOW_ABSENCE_GRACE_MS,
  } = {}) {
    this.missedPollsToEnd = Math.max(1, Math.floor(Number(missedPollsToEnd) || DEFAULT_MISSED_POLLS_TO_END));
    this.retentionMs = Math.max(60_000, Number(retentionMs) || DEFAULT_RETENTION_MS);
    this.windowAbsenceGraceMs = Math.max(5_000, Number(windowAbsenceGraceMs) || DEFAULT_WINDOW_ABSENCE_GRACE_MS);
    this.sessionsByPid = new Map();
    this.events = [];
  }

  update(windows, { now = Date.now() } = {}) {
    this.events = [];
    const rows = Array.isArray(windows) ? windows : [];
    const hostRowsByPid = new Map();

    for (const windowInfo of rows) {
      const isHostWindow = normalizeProcessName(windowInfo?.processName) === HOST_PROCESS
        && String(windowInfo?.title || '').trim().toLowerCase() === 'webex'
        && windowInfo?.webexHostedInstance === true
        && windowInfo?.webexExecutablePathVerified === true
        && windowInfo?.webexAccessoriesHelper !== true;
      if (!isHostWindow) continue;

      const pid = Number(windowInfo.pid);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (!hostRowsByPid.has(pid)) hostRowsByPid.set(pid, []);
      hostRowsByPid.get(pid).push(windowInfo);
    }

    const decoratedByWindow = new Map();
    for (const [pid, hostRows] of hostRowsByPid) {
      const entry = this.sessionsByPid.get(pid) || createEntry(pid, now);
      const windowIds = [...new Set(hostRows.map(validWindowId).filter(Boolean))];
      const inspectedRows = hostRows.filter((row) => row.webexUiAutomationInspected === true);
      const positiveRows = inspectedRows.filter((row) => row.webexMeetingControlsPresent === true);
      const negativeRows = inspectedRows.filter((row) => row.webexMeetingControlsPresent !== true);

      entry.lastSeenAt = now;
      entry.windowMissingSince = null;
      entry.windowMissingPolls = 0;
      if (windowIds.length) {
        entry.lastWindowSeenAt = now;
        entry.currentWindowIds = windowIds;
      }

      if (positiveRows.length) {
        const preferredRow = positiveRows.find((row) => row.foreground === true) || positiveRows[0];
        const observedWindowId = validWindowId(preferredRow);
        // Only a successful, debounced absence of the meeting controls can end a
        // call. A long gap, missing HWND snapshot, or UIA timeout is not terminal
        // evidence: Webex's accessibility provider can stall while the call is live.
        const shouldStartNewEpoch = entry.ended;

        if (!entry.canonicalWindowId || shouldStartNewEpoch) {
          entry.callEpoch = Math.max(1, entry.callEpoch + 1);
          entry.canonicalWindowId = observedWindowId;
        }

        entry.hasSeenMeetingControls = true;
        entry.missingPolls = 0;
        entry.ended = false;
        entry.lastPositiveAt = now;
        entry.lastSeenAt = now;
        entry.currentWindowIds = windowIds;

        for (const row of hostRows) {
          const actualWindowId = validWindowId(row);
          decoratedByWindow.set(row, {
            ...row,
            webexMeetingControlsPresent: true,
            webexMeetingEnded: false,
            webexCanonicalWindowId: entry.canonicalWindowId,
            webexCallEpoch: entry.callEpoch,
            ...(actualWindowId && entry.canonicalWindowId && actualWindowId !== entry.canonicalWindowId
              ? { webexWindowIdentityChanged: true }
              : {}),
          });
        }
      } else if (negativeRows.length) {
        // A successful inspection with no call controls is the only signal that
        // advances the leave/end debounce. UIA errors and missing HWND snapshots do not.
        if (entry.hasSeenMeetingControls && !entry.ended) {
          entry.missingPolls += 1;
          if (entry.missingPolls >= this.missedPollsToEnd) entry.ended = true;
        }
        for (const row of hostRows) {
          decoratedByWindow.set(row, {
            ...row,
            webexMeetingControlsPresent: entry.hasSeenMeetingControls
              && !entry.ended
              && entry.missingPolls < this.missedPollsToEnd,
            webexMeetingEnded: entry.ended,
            ...(entry.canonicalWindowId ? { webexCanonicalWindowId: entry.canonicalWindowId } : {}),
            ...(entry.callEpoch > 0 ? { webexCallEpoch: entry.callEpoch } : {}),
          });
        }
      } else {
        // Inspection failed. Preserve the last confirmed active/ended state but do not
        // infer leave from a timeout, inaccessible tree, or changed top-level HWND.
        for (const row of hostRows) {
          decoratedByWindow.set(row, {
            ...row,
            webexMeetingControlsPresent: entry.hasSeenMeetingControls && !entry.ended,
            webexMeetingControlsStale: entry.hasSeenMeetingControls && !entry.ended,
            webexMeetingEnded: entry.ended,
            ...(entry.canonicalWindowId ? { webexCanonicalWindowId: entry.canonicalWindowId } : {}),
            ...(entry.callEpoch > 0 ? { webexCallEpoch: entry.callEpoch } : {}),
          });
        }
      }

      this.sessionsByPid.set(pid, entry);
    }

    // A Webex call can remove its top-level HWND entirely while leaving the
    // CiscoCollabHost process alive. The previous tracker only processed PIDs that
    // still had a visible `Webex` row, so this real end transition was invisible and
    // the next call in the same PID inherited the previous call epoch forever.
    // Treat a sustained absence as terminal, but tolerate brief HWND recreation gaps.
    for (const [pid, entry] of this.sessionsByPid) {
      if (hostRowsByPid.has(pid) || !entry.hasSeenMeetingControls || entry.ended) continue;
      entry.lastSeenAt = now;
      entry.windowMissingSince ??= now;
      entry.windowMissingPolls += 1;
      const missingForMs = Math.max(0, now - entry.windowMissingSince);
      if (entry.windowMissingPolls >= 2 && missingForMs >= this.windowAbsenceGraceMs) {
        entry.ended = true;
        entry.missingPolls = this.missedPollsToEnd;
        this.events.push({
          type: 'call-ended-window-absent',
          pid,
          canonicalWindowId: entry.canonicalWindowId,
          callEpoch: entry.callEpoch,
          missingForMs,
        });
      }
    }

    for (const [pid, entry] of this.sessionsByPid) {
      if (now - entry.lastSeenAt > this.retentionMs) this.sessionsByPid.delete(pid);
    }

    return rows.map((row) => decoratedByWindow.get(row) || row);
  }

  consumeEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }
}
