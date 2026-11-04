export const BROWSER_PROCESS_NAMES = Object.freeze(new Set([
  'chrome', 'msedge', 'brave', 'firefox', 'opera', 'operagx', 'vivaldi',
]));

export function normalizeProcessName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/[\s_-]/g, '');
}

export function isBrowserProcess(processName) {
  return BROWSER_PROCESS_NAMES.has(normalizeProcessName(processName));
}

export function normalizeWindowTitle(value) {
  return String(value || '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractLabeledMeetingId(title) {
  const match = String(title || '').match(/\b(?:meeting\s*(?:id|number)|call\s*id)\s*[:#-]?\s*(\d{8,13})\b/i);
  return match ? match[1] : null;
}

export function nativeMatch(processName, nativeProcessNames) {
  const process = normalizeProcessName(processName);
  return nativeProcessNames.has(process) ? process : null;
}

export function makeProviderMatch({ provider, source, rule, processName, meetingId = null, confidence = 'medium' }) {
  return {
    provider,
    source,
    rule,
    process: normalizeProcessName(processName),
    ...(meetingId ? { meetingId: String(meetingId) } : {}),
    confidence,
    evidence: [
      { kind: 'process_name', value: normalizeProcessName(processName) },
      { kind: 'window_title_rule', value: rule },
      ...(meetingId ? [{ kind: 'provider_meeting_id', value: String(meetingId) }] : []),
    ],
  };
}
