# Contexa Phase 1 — Repository reconciliation & session reliability

This is an incremental overlay for the existing `C:\Work\Contexa` repository. It preserves
the current FramePacer, SampleQueue, microphone reader, capture policy, React UI, audio pipeline,
transcription, memory and Q&A implementations.

## What this update changes

- Removes PID-only session reclamation: a matching process ID cannot override a different
  meeting key.
- Keeps exact-key continuity for short capture interruptions.
- Extracts explicit meeting identities from visible Google Meet codes and explicitly labelled
  numeric meeting/call IDs.
- Adds `POST /api/meetings/auto`, an idempotent create-or-reuse endpoint for explicit stable
  meeting IDs.
- Adds migration `20261101_0006`, with nullable meeting capture identity fields and a partial
  unique index that permits one active session per stable key. Ended sessions can be followed by
  a new occurrence using the same external meeting ID.
- Detects a different explicit meeting ID in the same long-lived browser process and switches
  sessions instead of silently continuing the old session.
- Reuses a stable meeting session when the same call moves to a replacement browser process.
- Runs stale-session cleanup before starting automatic detection at app startup and when Auto
  Capture is enabled.
- Reconciles the README, architecture and session-lifecycle docs with actual behavior and
  remaining limitations.

## Important boundary

This is Phase 1, not the browser-extension or real-time-memory phase. Detection still uses Windows
process/window-title heuristics. Stable external IDs receive database-backed deduplication.
Generic native window titles (for example, a Zoom window that exposes only `Zoom Meeting`) remain
best-effort because they do not expose a reliable call ID. Browser audio is still process-scoped,
so another audible tab in the same browser process can be included. These are explicit Phase 2/3
items, not solved by this update.

## Apply on Windows

1. Quit Contexa completely, including the system-tray process. Stop a manually launched Uvicorn
   process if one is running.
2. Back up PostgreSQL before applying the additive migration. With the default Compose names:

   ```powershell
   Set-Location C:\Work\Contexa
   docker compose exec -T postgres pg_dump -U contexa_user -d contexa > "$env:USERPROFILE\Desktop\contexa-before-phase1.sql"
   ```

   If your `.env` uses different database/user names, use those values instead. Do not run
   `docker compose down -v` and do not delete the PostgreSQL volume.
3. Extract `Contexa_Phase1_Session_Reliability_Patch.zip` directly over `C:\Work\Contexa`:

   ```powershell
   Set-Location C:\Work\Contexa
   Expand-Archive `
     -LiteralPath "$env:USERPROFILE\Downloads\Contexa_Phase1_Session_Reliability_Patch.zip" `
     -DestinationPath "C:\Work\Contexa" `
     -Force
   ```
4. Apply the new database migration:

   ```powershell
   Set-Location C:\Work\Contexa\backend
   .\.venv\Scripts\Activate.ps1
   python -m alembic current
   python -m alembic upgrade head
   python -m alembic current
   ```

   Expected head: `20261101_0006`.
5. Verify backend tests:

   ```powershell
   python -m pytest tests -q
   ```
6. Verify desktop tests:

   ```powershell
   Set-Location C:\Work\Contexa\desktop
   npm run check
   npm test
   ```
7. Launch normally:

   ```powershell
   Set-Location C:\Work\Contexa
   .\Start-Contexa.ps1
   ```

The desktop launcher already applies Alembic migrations during service startup. The manual
migration step above makes it possible to see and verify the revision before launching.

## Manual validation scenarios

- Join one Google Meet call. Repeated detection polls must not add more history rows.
- Keep that call open while its window title changes. The explicit Meet code should preserve the
  same key.
- Switch to a different Google Meet code in the same Chrome process. Contexa should end the old
  session and start a distinct session.
- Stop capture briefly and return to the same Meet code within the grace period. It should reuse
  the same session.
- Restart Contexa while a stable-ID meeting session is still active and has recent activity.
  The API should return the existing active session instead of creating another.
- Try a native Zoom/Teams/Webex call whose window exposes only a generic title. Treat continuity
  as best-effort until Phase 2 adds client-specific meeting-state detection.

## Files changed

- `backend/app/main.py`
- `backend/app/models.py`
- `backend/app/schemas.py`
- `backend/migrations/versions/20261101_0006_add_capture_identity.py`
- `backend/tests/test_phase1_sessions.py`
- `desktop/main.mjs`
- `desktop/meeting-session.mjs`
- `desktop/test/meeting-session.test.mjs`
- `README.md`
- `desktop/README.md`
- `docs/architecture.md`
- `docs/session-lifecycle.md`

No `.env`, API keys, `.git`, node_modules, Python virtual environment, PostgreSQL data, frontend
source or built frontend assets are included.

## Verification performed in the patch environment

- Backend: 69 tests passed using in-memory SQLite with external AI calls disabled by test fixtures.
- Desktop: `npm run check` passed; 49 tests passed.
- Alembic: clean upgrade to `20261101_0006` passed on SQLite.
- Upgrade from an existing database at `20261030_0005` preserved existing meeting rows.
- Partial unique-index behavior was exercised on SQLite and its PostgreSQL DDL was compiled.
- No actual Windows Zoom/Teams/Webex or microphone test was available here; perform the manual
  validation scenarios above on the Windows machine before marking Phase 1 fully accepted.
