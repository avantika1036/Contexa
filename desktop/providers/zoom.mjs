import { extractLabeledMeetingId, isBrowserProcess, makeProviderMatch, nativeMatch, normalizeWindowTitle } from './shared.mjs';

const NATIVE_PROCESSES = new Set(['zoom', 'zoomworkplace', 'zoommeetings', 'zoomrooms']);
const NATIVE_MEETING_TITLE = /\bzoom(?:\s+workplace)?\b.*\b(meeting|webinar|call)\b|\b(meeting|webinar|call)\b.*\bzoom\b|\b(?:left|ended)\s+(?:the )?(?:meeting|call)\b|\b(?:meeting|call)\s+(?:has )?(?:ended|finished)\b|\b(?:waiting|joining|connecting)\b.*\b(meeting|call)\b/i;
const BROWSER_MEETING_TITLE = /\bzoom\.us\b.*\b(meeting|webinar|call)\b|\b(meeting|webinar|call)\b.*\bzoom\.us\b|\bzoom\b.*\b(meeting|webinar|call)\b|\b(meeting|webinar|call)\b.*\bzoom\b|\b(?:left|ended)\s+(?:the )?(?:meeting|call)\b.*\bzoom\b|\b(?:meeting|call)\s+(?:has )?(?:ended|finished)\b.*\bzoom\b/i;
const EXCLUDED_TITLE = /\b(home|settings|contacts|chat|schedule|calendar|whiteboard|mail|phone)\b/i;

export function detectZoomWindow(processName, title, metadata = {}) {
  const value = normalizeWindowTitle(title);
  if (!value || EXCLUDED_TITLE.test(value)) return null;

  const nativeProcess = nativeMatch(processName, NATIVE_PROCESSES);
  if (nativeProcess && NATIVE_MEETING_TITLE.test(value)) {
    return makeProviderMatch({
      provider: 'zoom',
      source: 'native_window',
      rule: `zoom_native_meeting_title:${nativeProcess}`,
      processName,
      meetingId: extractLabeledMeetingId(value),
      confidence: /\bmeeting\s*(?:id|number)\b/i.test(value) ? 'high' : 'medium',
    });
  }

  if (isBrowserProcess(processName) && BROWSER_MEETING_TITLE.test(value)) {
    return makeProviderMatch({
      provider: 'zoom',
      source: 'browser_window',
      rule: 'zoom_browser_meeting_title',
      processName,
      meetingId: extractLabeledMeetingId(value),
      confidence: /\bmeeting\s*(?:id|number)\b/i.test(value) ? 'high' : 'medium',
    });
  }

  return null;
}
