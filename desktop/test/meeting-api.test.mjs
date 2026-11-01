import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeetingSession } from '../meeting-api.mjs';

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

test('durable auto-session endpoint returns the server-reused meeting', async () => {
  const calls = [];
  const meeting = { id: 'meeting-1', title: 'Auto · Sprint', status: 'active' };
  const result = await createMeetingSession({
    apiBase: 'http://127.0.0.1:8000',
    title: 'Sprint', sessionKey: 'meet:abc-defg-hij', processName: 'chrome',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, { meeting, reused: true });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8000/api/meetings/auto');
  assert.equal(result.id, 'meeting-1');
  assert.equal(result.reused_by_server, true);
  assert.equal(result.durable_identity_fallback, false);
});

test('a stale backend 405 falls back to the legacy session endpoint', async () => {
  const calls = [];
  const meeting = { id: 'meeting-2', title: 'Auto · Standup', status: 'active' };
  const result = await createMeetingSession({
    apiBase: 'http://127.0.0.1:8000',
    title: 'Standup', sessionKey: 'meet:abc-defg-hij', processName: 'chrome',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/api/meetings/auto')) return response(405, { detail: 'Method Not Allowed' });
      return response(201, meeting);
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'http://127.0.0.1:8000/api/meetings');
  assert.equal(result.id, 'meeting-2');
  assert.equal(result.durable_identity_fallback, true);
  assert.equal(result.reused_by_server, false);
});

test('a non-compatibility failure is not hidden by a legacy fallback', async () => {
  let calls = 0;
  await assert.rejects(
    createMeetingSession({
      apiBase: 'http://127.0.0.1:8000',
      title: 'Standup', sessionKey: 'meet:abc-defg-hij', processName: 'chrome',
      fetchImpl: async () => { calls += 1; return response(500, { detail: 'database unavailable' }); },
    }),
    /Could not create Contexa meeting session \(500\)/,
  );
  assert.equal(calls, 1);
});

test('non-durable keys continue using the legacy create endpoint directly', async () => {
  const calls = [];
  const result = await createMeetingSession({
    apiBase: 'http://127.0.0.1:8000',
    title: 'Zoom Meeting', sessionKey: 'zoom:*', processName: 'zoom',
    fetchImpl: async (url, options) => {
      calls.push(url);
      return response(201, { id: 'meeting-3', title: 'Auto · Zoom Meeting', status: 'active' });
    },
  });
  assert.deepEqual(calls, ['http://127.0.0.1:8000/api/meetings']);
  assert.equal(result.durable_identity_fallback, false);
});


import { resumeMeetingSession, suspendMeetingSession } from '../meeting-api.mjs';

test('suspension and resumption use explicit meeting lifecycle endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ id: 'meeting-1', status: url.endsWith('/suspend') ? 'suspended' : 'active' }) };
  };
  await suspendMeetingSession({ apiBase: 'http://127.0.0.1:8000', meetingId: 'meeting/1', fetchImpl });
  await resumeMeetingSession({ apiBase: 'http://127.0.0.1:8000', meetingId: 'meeting/1', fetchImpl });
  assert.deepEqual(calls.map((call) => call.url), [
    'http://127.0.0.1:8000/api/meetings/meeting%2F1/suspend',
    'http://127.0.0.1:8000/api/meetings/meeting%2F1/resume',
  ]);
  assert.ok(calls.every((call) => call.options.method === 'POST'));
});

test('resume helper preserves HTTP status so ended sessions can be recovered safely', async () => {
  await assert.rejects(
    resumeMeetingSession({
      apiBase: 'http://127.0.0.1:8000',
      meetingId: 'ended-meeting',
      fetchImpl: async () => ({ ok: false, status: 409, text: async () => 'This meeting session has ended.' }),
    }),
    (error) => error.status === 409 && /has ended/.test(error.message),
  );
});

import { upgradeMeetingIdentitySession } from '../meeting-api.mjs';

test('identity upgrade persists the stable call key and corrected title on the existing session', async () => {
  const calls = [];
  const result = await upgradeMeetingIdentitySession({
    apiBase: 'http://127.0.0.1:8000',
    meetingId: 'provisional-session',
    sessionKey: 'meet:fai-wivv-szk',
    title: 'Meet - fai-wivv-szk',
    processName: 'chrome',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, { id: 'provisional-session', title: 'Auto · Meet - fai-wivv-szk', status: 'active' });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8000/api/meetings/provisional-session/identity');
  assert.equal(calls[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    capture_key: 'meet:fai-wivv-szk',
    title: 'Auto · Meet - fai-wivv-szk',
    process_name: 'chrome',
  });
  assert.equal(result.title, 'Auto · Meet - fai-wivv-szk');
});

test('identity upgrade preserves the HTTP status for an existing stable-identity conflict', async () => {
  await assert.rejects(
    upgradeMeetingIdentitySession({
      apiBase: 'http://127.0.0.1:8000',
      meetingId: 'provisional-session',
      sessionKey: 'meet:fai-wivv-szk',
      title: 'Meet - fai-wivv-szk',
      processName: 'chrome',
      fetchImpl: async () => response(409, { detail: 'Another open session owns the identity.' }),
    }),
    (error) => error.status === 409 && /Another open session/.test(error.message),
  );
});
