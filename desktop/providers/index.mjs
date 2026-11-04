import { detectGoogleMeetWindow } from './google-meet.mjs';
import { detectZoomWindow } from './zoom.mjs';
import { detectTeamsWindow } from './teams.mjs';
import { detectWebexWindow } from './webex.mjs';

const PROVIDER_DETECTORS = Object.freeze([
  detectGoogleMeetWindow,
  detectZoomWindow,
  detectTeamsWindow,
  detectWebexWindow,
]);

/**
 * Return the first provider-specific match for a visible desktop window.
 * Every adapter is intentionally narrow and returns structured evidence rather than
 * deciding whether an entire meeting session should start or stop.
 */
export function detectProviderWindow(processName, title, metadata = {}) {
  for (const detect of PROVIDER_DETECTORS) {
    const match = detect(processName, title, metadata);
    if (match) return match;
  }
  return null;
}

export const SUPPORTED_MEETING_PROVIDERS = Object.freeze([
  'google_meet', 'zoom', 'teams', 'webex',
]);
