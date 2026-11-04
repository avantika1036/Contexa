import { extractLabeledMeetingId, isBrowserProcess, makeProviderMatch, nativeMatch, normalizeWindowTitle } from './shared.mjs';

// Cisco documents CiscoCollabHost.exe as the multiprocess Webex host,
// and webexhost.exe / CiscoWebExStart.exe as meeting-join executables.
const NATIVE_PROCESSES = new Set([
  'webex', 'ciscocollabhost', 'webexhost', 'ciscowebexstart',
]);
const NATIVE_MEETING_TITLE = /\bwebex\b.*\b(meeting|webinar|call)\b|\b(meeting|webinar|call)\b.*\bwebex\b|\bmeeting\s+(?:in progress|controls|has ended|ended|finished)\b|\bcall\s+(?:in progress|controls|has ended|ended|finished)\b|\bjoin(?:ing)? (?:the )?(?:meeting|call)\b|\b(?:left|ended)\s+(?:the )?(?:meeting|call)\b|\b(?:host|organizer) ended (?:the )?(?:meeting|call)\b|\bwaiting (?:room|to join|for (?:the )?(?:host|organizer))\b|\bconnecting to (?:the )?(?:meeting|call)\b/i;
const MEETING_HELPER_PROCESSES = new Set(['webexhost', 'ciscowebexstart']);
const BROWSER_MEETING_TITLE = /\bwebex(?:\.com)?\b.*\b(meeting|webinar|call)\b|\b(meeting|webinar|call)\b.*\bwebex(?:\.com)?\b|\b(join|joining)\s+(?:the )?(?:meeting|call)\b.*\bwebex\b|\b(?:left|ended)\s+(?:the )?(?:meeting|call)\b.*\bwebex\b|\b(?:host|organizer) ended (?:the )?(?:meeting|call)\b.*\bwebex\b|\b(?:meeting|call)\s+(?:has )?(?:ended|finished)\b.*\bwebex\b/i;
const EXCLUDED_TITLE = /\b(home|settings|chat|calendar|contacts|spaces|messages)\b/i;

export function detectWebexWindow(processName, title, metadata = {}) {
  const value = normalizeWindowTitle(title);
  if (!value || EXCLUDED_TITLE.test(value)) return null;

  const nativeProcess = nativeMatch(processName, NATIVE_PROCESSES);

  // Native Cisco Webex desktop evidence from this installation:
  // - visible CiscoCollabHost.exe window titled exactly "Webex"
  // - verified per-user CiscoSparkLauncher executable path
  // - /Hosted=true host instance
  // - UI Automation sees the meeting-only "End meeting" control
  //
  // The webex://meet protocol is intentionally NOT used: the user's live process
  // retained that stale launch URI after leaving the call.
  const verifiedNativeHost = nativeProcess === 'ciscocollabhost'
    && value.toLowerCase() === 'webex'
    && metadata.webexHostedInstance === true
    && metadata.webexExecutablePathVerified === true
    && metadata.webexAccessoriesHelper !== true
    && (metadata.webexUiAutomationInspected === true
      || (metadata.webexUiAutomationInspected !== true && metadata.webexMeetingControlsStale === true));

  if (verifiedNativeHost && (metadata.webexMeetingControlsPresent === true || metadata.webexMeetingEnded === true)) {
    const pid = Number(metadata.pid);
    const windowId = String(metadata.windowId || '');
    const canonicalWindowId = String(metadata.webexCanonicalWindowId || windowId);
    const callEpoch = Math.max(1, Math.floor(Number(metadata.webexCallEpoch) || 1));
    if (!Number.isInteger(pid) || pid <= 0 || !windowId || !/^[A-Za-z0-9_-]{1,80}$/.test(canonicalWindowId)) return null;

    const ended = metadata.webexMeetingEnded === true;
    const match = makeProviderMatch({
      provider: 'webex',
      source: 'native_window',
      rule: ended ? 'webex_native_meeting_controls_disappeared' : 'webex_native_active_meeting_controls',
      processName,
      confidence: 'high',
    });

    return {
      ...match,
      // A recreated HWND in the same active CiscoCollabHost call must keep the
      // original canonical identity. A confirmed subsequent call receives a new epoch.
      identityKey: `webex:window:${pid}:${canonicalWindowId}${callEpoch > 1 ? `-call${callEpoch}` : ''}`,
      lifecycleState: ended ? 'ended' : 'active',
      evidence: [
        ...match.evidence,
        { kind: 'webex_hosted_instance', value: 'true' },
        { kind: 'webex_executable_path', value: 'CiscoSparkLauncher/CiscoCollabHost.exe' },
        { kind: 'webex_accessibility', value: ended ? 'meeting-controls-disappeared' : 'end-meeting-control-present' },
        { kind: 'webex_window_identity', value: `${pid}:${canonicalWindowId}` },
        { kind: 'webex_call_epoch', value: String(callEpoch) },
        ...(metadata.webexWindowIdentityChanged === true ? [{ kind: 'webex_window_recreated', value: 'true' }] : []),
      ],
    };
  }

  if (nativeProcess && (NATIVE_MEETING_TITLE.test(value)
    || (MEETING_HELPER_PROCESSES.has(nativeProcess) && /\b(meeting|webinar|call|joining|connecting|waiting)\b/i.test(value)))) {
    return makeProviderMatch({
      provider: 'webex',
      source: 'native_window',
      rule: `webex_native_meeting_surface:${nativeProcess}`,
      processName,
      meetingId: extractLabeledMeetingId(value),
      confidence: 'medium',
    });
  }

  if (isBrowserProcess(processName) && BROWSER_MEETING_TITLE.test(value)) {
    return makeProviderMatch({
      provider: 'webex',
      source: 'browser_window',
      rule: 'webex_browser_meeting_title',
      processName,
      meetingId: extractLabeledMeetingId(value),
      confidence: /\bmeeting\s*(?:id|number)|\bcall\s*id\b/i.test(value) ? 'high' : 'medium',
    });
  }

  return null;
}
