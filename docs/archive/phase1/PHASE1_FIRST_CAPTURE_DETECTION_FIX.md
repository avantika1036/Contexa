# Phase 1 — First-capture detection stability fix

## What the reported log showed

The desktop successfully started a capture, then stopped it because the meeting window had not been matched for 17 seconds while the audio pipeline had reported approximately 90 seconds without audible activity. The audio stats showed only 23 forwarded 100-ms frames and 11 microphone-active frames, so the supplied log does not demonstrate sustained speech reaching the transcription service.

## Root cause addressed

`getMeetingWindows()` previously used `Get-Process.MainWindowTitle`. That API reports one main title per process, not every top-level window. Chrome and Edge can have multiple browser windows under the same process; when the one reported title is an unrelated tab/window, a still-open Meet window can be omitted from the detector's result. The current capture is then treated as missing and suspended after the existing policy threshold.

The detector now enumerates visible top-level HWNDs with the Windows `EnumWindows` API, retrieves each title and owning process, and filters those individual windows through the existing supported-meeting predicate. This preserves the existing stable meeting identity logic and does not change the 15-second missing-window policy or 300-second recovery window.

## Tests

Added pure unit tests for normalization of multiple top-level browser windows in a shared Chrome PID and PowerShell's single-object JSON shape. Run `npm run check` and `npm test` in `desktop`.

## Important limitation of the supplied log

Only 23 frames were forwarded and 11 microphone-active frames were recorded. This is about 2.3 seconds of forwarded audio and 1.1 seconds of mic activity, while 894 frames were classified as silent. There were no Deepgram error messages in the excerpt. After applying this patch, test with the Google Meet mic unmuted and speak continuously for 10–15 seconds. The log should show sustained microphone activity and final transcript lines. If microphone-active frames remain very low, investigate Windows input selection/permission or microphone mute separately from meeting-window detection.

No database migration is required. No transcript, meeting row, `.env`, or Docker volume is modified.
