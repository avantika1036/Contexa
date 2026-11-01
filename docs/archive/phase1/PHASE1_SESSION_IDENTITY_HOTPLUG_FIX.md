# Phase 1 — Stable Meeting Identity, Recovery and Microphone Hot-plug Fix

This patch addresses the latest Contexa Windows test findings using the uploaded 2026-11-01 source snapshot plus the already-installed microphone hot-plug implementation.

## Root causes addressed

1. **Google Meet identity was only upgraded in Electron memory.** When capture began from a generic `Meet` title, Contexa created `Auto · Meet` without a `capture_key`. Once a call code appeared, only `currentCapture.sessionKey` changed. PostgreSQL retained a provisional row with no durable key, so the next Electron launch could not find it through `/api/meetings/auto` and created another session.
2. **Window identity could be ambiguous when several Meet windows shared one Chrome PID.** The detector selected the first matching call code even if no window was foreground. That could switch capture to the wrong meeting.
3. **Windows audio endpoint enumeration can lag behind `EDEVICELOST`.** Recovery could reopen an endpoint while Windows was still changing the default input. This patch requires the selected input to remain stable across consecutive enumerations before reopening it.
4. **Suspended-session cleanup used the generic stale-session timeout.** That could leave a meeting showing Recoverable/Paused well beyond the intended 300-second recovery window after Contexa had been closed.

## Changes

- Briefly wait for Google Meet's stable call code before creating the first session. The wait is bounded; generic capture can still proceed if a provider ID never appears.
- Add `PATCH /api/meetings/{meeting_id}/identity` to persist a late-discovered stable `capture_key`, process name and corrected `Auto · Meet - <code>` title on the original session.
- On `/api/meetings/auto`, adopt one unambiguous recent legacy `Auto · Meet` provisional row when no stable row exists.
- If one stable row and one recent provisional row coexist, merge the provisional transcript and memory records into the stable row before opening the next audio WebSocket. Timeline offsets are preserved when both rows contain transcript data. Empty ambiguous legacy rows can be discarded; non-empty ambiguous rows are preserved rather than guessed/merged into the wrong call.
- Choose a Google Meet identity transition only when there is one stable candidate or exactly one foreground candidate. Do not guess among multiple background Meet windows in the same process.
- On microphone hot-plug recovery, re-enumerate inputs and require a stable Windows default selection across consecutive polls before reopening the reader. Existing thresholds and separate audio channels are unchanged.
- Expire suspended sessions using `suspended_at` and `suspended_session_resume_grace_seconds` (default 300 seconds), not the longer generic stale-active timeout.

## Database and migration impact

No schema changes or migrations are required. Existing `capture_key`, `suspended_at`, transcript and memory columns are reused. PostgreSQL data and Docker volumes are not reset.

## Verification

- Backend: 81 tests passed.
- Desktop: 78 tests passed.
- Desktop syntax checks passed.
- Backend `compileall` passed.
- Full Windows Electron + Windows audio-device hot-plug testing still needs to be performed on the user's machine.

## Windows installation

1. Quit Contexa completely from the system tray.
2. Extract this patch ZIP over `C:\Work\Contexa`.
3. Stop the existing Contexa FastAPI process on port 8000 (only if its executable is `C:\Work\Contexa\backend\.venv\Scripts\python.exe` and its command line is `uvicorn app.main:app`). The updated backend must be reloaded; `Start-Contexa.ps1` may reuse an already healthy server.
4. Run the backend and desktop test commands below, then relaunch Contexa.

```powershell
Set-Location C:\Work\Contexa\backend
.\.venv\Scripts\Activate.ps1
python -m pytest tests -q

Set-Location C:\Work\Contexa\desktop
npm run check
npm test

Set-Location C:\Work\Contexa
.\Start-Contexa.ps1
```

No `alembic upgrade` command is needed for this patch because it adds no database columns or indexes.
