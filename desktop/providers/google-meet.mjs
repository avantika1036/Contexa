import { isBrowserProcess, makeProviderMatch, normalizeWindowTitle } from './shared.mjs';

const GOOGLE_MEET_TITLE = /google meet|meet\.google|\bmeet\s*[-–|]\s*[a-z]{3}-[a-z]{4}-[a-z]{3}\b/i;
// Browser permission prompts are not meeting surfaces. Keep waiting-room and
// pre-join titles eligible; they are useful joining observations, not false positives.
const EXCLUDED_TITLE = /\b(?:settings|extensions|history|downloads)\b|\bwants to\b|\buse your microphone\b|\ballow (?:this )?site\b/i;
const MEET_CODE = /\b([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i;

export function detectGoogleMeetWindow(processName, title, metadata = {}) {
  const value = normalizeWindowTitle(title);
  if (!isBrowserProcess(processName) || !value || EXCLUDED_TITLE.test(value)) return null;
  if (!GOOGLE_MEET_TITLE.test(value)) return null;

  const code = value.match(MEET_CODE)?.[1]?.toLowerCase() || null;
  return makeProviderMatch({
    provider: 'google_meet',
    source: 'browser_window',
    rule: code ? 'google_meet_call_code' : 'google_meet_page_title',
    processName,
    meetingId: code,
    confidence: code ? 'high' : 'medium',
  });
}
