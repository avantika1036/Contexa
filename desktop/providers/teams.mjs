import { extractLabeledMeetingId, isBrowserProcess, makeProviderMatch, nativeMatch, normalizeWindowTitle } from './shared.mjs';

// New Teams is ms-teams.exe. Some Windows builds expose the calling stack in
// ms-teams_modulehost.exe; the title must still contain explicit meeting evidence.
const NATIVE_PROCESSES = new Set([
  'teams', 'msteams', 'msteamshost', 'msteamsmodulehost',
]);
const NATIVE_MEETING_TITLE = /^(?:meeting with\s+.+?(?:\s*\|\s*microsoft teams)?)$|\bmeeting\s+(?:in progress|is in progress|controls|now|has ended|ended|finished)\b|\bcall\s+(?:in progress|is in progress|controls|has ended|ended|finished)\b|\bin a (?:meeting|call)\b|\bjoin(?:ing)? (?:the )?(?:meeting|call)\b|\bcall with\s+[^|–—-]+|\b(?:left|ended)\s+(?:the )?(?:meeting|call)\b|\b(?:host|organizer) ended (?:the )?(?:meeting|call)\b|\bwaiting (?:room|to join|for (?:the )?(?:host|organizer))\b|\bconnecting to (?:the )?(?:meeting|call)\b/i;
const BROWSER_MEETING_TITLE = /(?:teams\.microsoft\.com|teams\.live\.com).*\b(meeting|call|huddle)\b|\b(meeting|call|huddle)\b.*(?:teams\.microsoft\.com|teams\.live\.com)|\b(?:meeting|call)\s*[|–—-]\s*microsoft teams\b|\bmicrosoft teams\b.*\b(meeting|call)\b|\b(?:left|ended)\s+(?:the )?(?:meeting|call)\b.*\bmicrosoft teams\b|\b(?:host|organizer) ended (?:the )?(?:meeting|call)\b.*\bmicrosoft teams\b|\b(?:meeting|call)\s+(?:has )?(?:ended|finished)\b.*\bmicrosoft teams\b/i;
const EXCLUDED_TITLE = /\b(settings|chat list|activity|calendar|files|home|contacts|chat)\b/i;

export function detectTeamsWindow(processName, title, metadata = {}) {
  const value = normalizeWindowTitle(title);
  if (!value || EXCLUDED_TITLE.test(value)) return null;

  const nativeProcess = nativeMatch(processName, NATIVE_PROCESSES);
  if (nativeProcess && NATIVE_MEETING_TITLE.test(value)) {
    return makeProviderMatch({
      provider: 'teams',
      source: 'native_window',
      rule: `teams_native_meeting_state:${nativeProcess}`,
      processName,
      meetingId: extractLabeledMeetingId(value),
      confidence: /\bmeeting\s*(?:id|number)|\bcall\s*id\b/i.test(value) ? 'high' : 'medium',
    });
  }

  if (isBrowserProcess(processName) && BROWSER_MEETING_TITLE.test(value)) {
    return makeProviderMatch({
      provider: 'teams',
      source: 'browser_window',
      rule: 'teams_browser_meeting_title',
      processName,
      meetingId: extractLabeledMeetingId(value),
      confidence: /\bmeeting\s*(?:id|number)|\bcall\s*id\b/i.test(value) ? 'high' : 'medium',
    });
  }

  return null;
}
