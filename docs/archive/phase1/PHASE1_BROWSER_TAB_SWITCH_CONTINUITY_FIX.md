# Phase 1 — Browser tab/window switch continuity fix

## Finding in the uploaded current repository

The stop policy in `desktop/capture-policy.mjs` defaults to:

- `stopAfterMissingMs`: 15 seconds
- `quietBeforeMissingStopMs`: 30 seconds
- `maxMissingWhileAudibleMs`: 180 seconds

The stop requires both a sufficiently long meeting-window miss and the quiet condition (unless the bounded audible hold expires). If the room has already been quiet for 30 seconds when the user changes tabs, the 15-second missing-window threshold can cause the session to suspend shortly after the tab switch.

The actual detection bug is in `desktop/main.mjs`: the Windows `EnumWindows` scan returns top-level window titles, but the detector used `normalizeMeetingWindows()` immediately. That filtered out non-meeting titles. Chrome/Edge often expose the currently selected tab title on the HWND; when the user selects a different tab, the same browser HWND/PID remains but its title no longer identifies the background Meet call. `classifyWindowTransition()` then returns `missing`, and `captureStopReason()` can suspend the meeting.

The backend suspend endpoint is not the cause. It persists the suspension requested by the desktop monitor.

## Fix

1. Keep a normalized snapshot of all visible top-level HWNDs in memory.
2. Continue deriving the meeting-only list from that snapshot for new-session selection and stable meeting identity matching.
3. When the current meeting identity is temporarily unmatchable, check whether the exact Chrome/Edge process PID that owned it still has a top-level window.
4. If that PID is still present, classify the state as an unverified tab/window switch, refresh `lastMatchedAt`, and retain the current meeting session. Do not suspend or create another session merely because the selected tab title changed.
5. If an explicit different meeting identity is visible, the existing different-meeting transition still takes precedence and starts a new session.
6. If the original browser process disappears, the existing missing-window and audio-quiet policy applies normally.

No ordinary non-meeting window titles are written to logs. Only recognized meeting-window metadata and the unverified process PID are logged.

## Important limitation

This is the correct desktop-only Phase 1 continuity fix, but it is not exact tab-level call-state detection. A browser process can remain open after its Meet tab is closed, and process loopback may include audio from other audible tabs. Contexa's existing 180-second audio-idle end policy still applies. Exact verification that a specific Meet tab remains in a call, and isolated tab audio, require the planned browser extension/native-messaging integration in Phase 3.

## Files changed

- `desktop/main.mjs`
- `desktop/capture-policy.mjs`
- `desktop/meeting-session.mjs`
- `desktop/test/capture-policy.test.mjs`
- `desktop/test/meeting-session.test.mjs`
- `docs/docs/session-lifecycle.md`

No backend files, database migrations, `.env` files, credentials, node_modules, or PostgreSQL data are included or changed.

## Validation

- `npm run check`: passed
- `npm test`: 88 passed, 0 failed

The Windows EnumWindows/PowerShell path still needs an actual Windows acceptance test.

## Install on Windows

1. Quit Contexa completely from its system-tray menu.
2. Extract this ZIP over `C:\Work\Contexa` with overwrite enabled.
3. Run:

```powershell
Set-Location C:\Work\Contexa\desktop
npm run check
npm test

Set-Location C:\Work\Contexa
.\Start-Contexa.ps1
```

No backend restart or Alembic migration is required.

## Acceptance test

1. Start one Google Meet and wait until Contexa logs its stable `meet:<code>` identity.
2. Switch to another browser tab or another application for more than 15 seconds, ideally 45–60 seconds.
3. While the other tab/window is selected, confirm there is no `Automatic meeting capture stopped` or `Session ... is suspended` event solely because the Meet title is absent.
4. Return to the original Meet tab. Confirm Contexa logs that the meeting window became identifiable again and that the same meeting/session continues without a second `POST /api/meetings/auto` session creation.
5. Close the browser process completely. Confirm the existing missing-window/quiet policy can now suspend the session.
6. Open a different Google Meet code in the same browser process. Confirm the explicit different-meeting transition still creates a separate session.
