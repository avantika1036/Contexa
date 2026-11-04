import { isDurableMeetingKey } from './meeting-session.mjs';
import { restartBlockMatchesIdentity } from './meeting-control.mjs';

const TERMINAL_STATES = new Set(['left', 'ended']);
const PRESENT_STATES = new Set(['candidate', 'joining', 'active', 'background']);
const REJOIN_STATES = new Set(['candidate', 'joining', 'active']);

const STATE_PRIORITY = Object.freeze({
  unknown: 0,
  temporarily_missing: 1,
  background: 2,
  candidate: 3,
  joining: 4,
  active: 5,
  left: 6,
  ended: 7,
});

function cleanText(value) {
  return String(value || '').trim();
}

/**
 * A durable provider call ID is stable across process/window replacement. If a provider
 * exposes no call ID, the process and HWND are included so separate windows are not merged.
 */
export function meetingLifecycleKey(observation) {
  if (!observation || typeof observation !== 'object') return null;
  const provider = cleanText(observation.provider).toLowerCase();
  const identityKey = cleanText(observation.identityKey);
  if (!provider || !identityKey) return null;

  if (observation.durableIdentity === true || isDurableMeetingKey(identityKey)) {
    return `${provider}|${identityKey}`;
  }

  const pid = Number(observation.processId ?? observation.pid);
  const windowId = cleanText(observation.windowId);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return `${provider}|${identityKey}|pid:${pid}|hwnd:${windowId || 'unknown'}`;
}

function chooseRepresentative(observations) {
  // A durable call can be represented by more than one browser/native window. If one
  // duplicate window displays a leave/end surface while another still shows the same
  // call as active/background/joining, the meeting itself is still present. Only choose
  // terminal evidence when no present observation for that same lifecycle key exists.
  const present = observations.filter((item) => PRESENT_STATES.has(String(item.state || '')));
  const candidates = present.length ? present : observations;
  return [...candidates].sort((left, right) =>
    (STATE_PRIORITY[String(right.state || 'unknown')] ?? 0)
      - (STATE_PRIORITY[String(left.state || 'unknown')] ?? 0)
  )[0];
}

function makeEvent(type, entry, fromState = null) {
  return {
    type,
    lifecycleKey: entry.lifecycleKey,
    provider: entry.provider,
    identityKey: entry.identityKey,
    pid: entry.pid,
    fromState,
    state: entry.state,
    epoch: entry.epoch,
    observedAt: entry.lastSeenAt,
  };
}

/**
 * Tracks observed meeting lifecycles independently from the one audio stream Contexa
 * currently captures. Missing windows are temporary/unknown, never silently converted
 * into `left` or `ended`; only provider evidence can produce those terminal states.
 */
export class MeetingLifecycleRegistry {
  constructor({ missingGraceMs = 30_000, retentionMs = 15 * 60_000 } = {}) {
    this.missingGraceMs = Math.max(0, Number(missingGraceMs) || 0);
    this.retentionMs = Math.max(this.missingGraceMs, Number(retentionMs) || 0);
    this.entries = new Map();
  }

  update(observations, { now = Date.now() } = {}) {
    const rows = Array.isArray(observations) ? observations.filter(Boolean) : [];
    const grouped = new Map();

    for (const observation of rows) {
      const lifecycleKey = meetingLifecycleKey(observation);
      if (!lifecycleKey) continue;
      const group = grouped.get(lifecycleKey) || [];
      group.push(observation);
      grouped.set(lifecycleKey, group);
    }

    const seen = new Set();
    const events = [];
    const metadataByKey = new Map();

    for (const [lifecycleKey, group] of grouped) {
      const representative = chooseRepresentative(group);
      const provider = cleanText(representative.provider).toLowerCase();
      const identityKey = cleanText(representative.identityKey);
      const pid = Number(representative.processId ?? representative.pid) || null;
      const incomingState = PRESENT_STATES.has(String(representative.state))
        || TERMINAL_STATES.has(String(representative.state))
        ? String(representative.state)
        : 'unknown';
      let entry = this.entries.get(lifecycleKey);
      let eventType = null;
      let eventFromState = null;

      if (!entry) {
        entry = {
          lifecycleKey,
          provider,
          identityKey,
          pid,
          state: incomingState,
          epoch: 1,
          firstSeenAt: now,
          lastSeenAt: now,
          missingSince: null,
          terminalAt: TERMINAL_STATES.has(incomingState) ? now : null,
          windowCount: group.length,
        };
        eventType = 'discovered';
      } else {
        const previousState = entry.state;
        const wasTerminal = TERMINAL_STATES.has(previousState);
        let retainTerminal = false;

        if (wasTerminal && REJOIN_STATES.has(incomingState)) {
          // A provider has shown a leave/end surface and has now returned to a
          // foreground/call-specific meeting surface with the same identity.
          // This is a new lifecycle epoch, not a temporary window return.
          entry.epoch += 1;
          entry.firstSeenAt = now;
          entry.terminalAt = null;
          eventType = 'rejoined';
          eventFromState = previousState;
        } else if (wasTerminal && !TERMINAL_STATES.has(incomingState)) {
          // A generic background/unknown observation is not enough to undo a confirmed
          // leave/end. Keep the terminal state until provider evidence confirms a join.
          retainTerminal = true;
          entry.provider = provider;
          entry.identityKey = identityKey;
          entry.pid = pid || entry.pid;
          entry.lastSeenAt = now;
          entry.missingSince = null;
          entry.windowCount = group.length;
        } else if (previousState === 'temporarily_missing' || previousState === 'unknown') {
          eventType = 'returned';
          eventFromState = previousState;
        } else if (previousState !== incomingState) {
          eventType = 'state_changed';
          eventFromState = previousState;
        }

        if (!retainTerminal) {
          entry.provider = provider;
          entry.identityKey = identityKey;
          entry.pid = pid || entry.pid;
          entry.state = incomingState;
          entry.lastSeenAt = now;
          entry.missingSince = null;
          entry.terminalAt = TERMINAL_STATES.has(incomingState)
            ? (entry.terminalAt || now)
            : null;
          entry.windowCount = group.length;
        }
      }

      this.entries.set(lifecycleKey, entry);
      seen.add(lifecycleKey);
      metadataByKey.set(lifecycleKey, {
        lifecycleState: entry.state,
        lifecycleEpoch: entry.epoch,
        lifecycleEvent: eventType,
      });
      if (eventType) events.push(makeEvent(eventType, entry, eventFromState));
    }

    for (const [lifecycleKey, entry] of this.entries) {
      if (seen.has(lifecycleKey) || TERMINAL_STATES.has(entry.state)) continue;

      if (entry.state !== 'temporarily_missing' && entry.state !== 'unknown') {
        const previousState = entry.state;
        entry.state = 'temporarily_missing';
        entry.missingSince = now;
        events.push(makeEvent('temporarily_missing', entry, previousState));
      } else if (entry.state === 'temporarily_missing'
        && now - Number(entry.missingSince || now) >= this.missingGraceMs) {
        entry.state = 'unknown';
        events.push(makeEvent('missing_expired', entry, 'temporarily_missing'));
      }
    }

    for (const [lifecycleKey, entry] of this.entries) {
      const age = now - entry.lastSeenAt;
      const retainedTerminal = TERMINAL_STATES.has(entry.state) && now - Number(entry.terminalAt || entry.lastSeenAt) <= this.retentionMs;
      const retainedMissing = ['temporarily_missing', 'unknown'].includes(entry.state) && age <= this.retentionMs;
      if (!seen.has(lifecycleKey) && !retainedTerminal && !retainedMissing) {
        this.entries.delete(lifecycleKey);
      }
    }

    const decorated = rows.map((observation) => {
      const lifecycleKey = meetingLifecycleKey(observation);
      const metadata = lifecycleKey ? metadataByKey.get(lifecycleKey) : null;
      return metadata ? { ...observation, lifecycleKey, ...metadata } : observation;
    });

    return {
      observations: decorated,
      events,
      snapshot: this.getSnapshot(),
    };
  }

  getSnapshot() {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }

  clear() {
    this.entries.clear();
  }
}

/**
 * Only an explicit terminal-to-present transition for the blocked identity may lift an
 * end block early. A UI stop or temporary tab disappearance does not count as a rejoin.
 */
export function lifecycleEventMatchesRestartBlock(event, block) {
  if (!event || event.type !== 'rejoined' || !block) return false;
  if (!restartBlockMatchesIdentity(block, event.identityKey)) return false;
  const durable = block.stableIdentity === true || isDurableMeetingKey(event.identityKey);
  return durable || Number(event.pid) === Number(block.pid);
}
