import { isDurableMeetingKey } from './meeting-session.mjs';

async function responseDetail(response) {
  try {
    const text = await response.text();
    return text || `Request failed (${response.status}).`;
  } catch {
    return `Request failed (${response.status}).`;
  }
}

/**
 * Create a Contexa session, preferring the Phase 1 idempotent endpoint.
 * Older already-running FastAPI processes may not expose /api/meetings/auto yet;
 * for 404/405 only, fall back to the legacy create endpoint so capture can proceed.
 * The caller is told that server-side durable deduplication was unavailable.
 */
export async function createMeetingSession({
  apiBase,
  title,
  sessionKey,
  processName,
  fetchImpl = fetch,
}) {
  const durableIdentity = isDurableMeetingKey(sessionKey);
  const endpoint = durableIdentity ? `${apiBase}/api/meetings/auto` : `${apiBase}/api/meetings`;
  const payload = durableIdentity
    ? { title: `Auto · ${title}`.slice(0, 200), capture_key: sessionKey, process_name: processName }
    : { title: `Auto · ${title}`.slice(0, 200) };

  let response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });

  let durableIdentityFallback = false;
  if (durableIdentity && [404, 405].includes(response.status)) {
    durableIdentityFallback = true;
    response = await fetchImpl(`${apiBase}/api/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: payload.title }),
      signal: AbortSignal.timeout(8000),
    });
  }

  if (!response.ok) {
    throw new Error(`Could not create Contexa meeting session (${response.status}): ${await responseDetail(response)}`);
  }

  const result = await response.json();
  if (durableIdentity && !durableIdentityFallback) {
    return {
      ...result.meeting,
      reused_by_server: Boolean(result.reused),
      durable_identity_fallback: false,
    };
  }

  return {
    ...result,
    reused_by_server: false,
    durable_identity_fallback: durableIdentityFallback,
  };
}


async function meetingStateRequest({ apiBase, meetingId, state, fetchImpl = fetch }) {
  const response = await fetchImpl(`${apiBase}/api/meetings/${encodeURIComponent(meetingId)}/${state}`, {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
    try { detail = (await response.text()) || detail; } catch { /* keep status detail */ }
    const error = new Error(`Could not ${state} Contexa meeting session (${response.status}): ${detail}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export function suspendMeetingSession(args) {
  return meetingStateRequest({ ...args, state: 'suspend' });
}

export function resumeMeetingSession(args) {
  return meetingStateRequest({ ...args, state: 'resume' });
}
