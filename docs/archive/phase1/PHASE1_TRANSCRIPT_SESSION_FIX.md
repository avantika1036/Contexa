# Phase 1 follow-up: session creation, history selection, live transcript delivery

This patch addresses three Windows runtime issues reported after Phase 1.

## Changes

1. **HTTP 404/405 compatibility:** if the durable `POST /api/meetings/auto` endpoint is missing on an already-running older backend, Electron falls back to `POST /api/meetings` so the call can still be captured. A tray warning and console warning explain that database-backed deduplication is unavailable until the stale backend process is restarted. Other errors (500, 503, etc.) do not trigger fallback.
2. **Manual history selection:** background polling no longer forces the UI back to the active auto-captured meeting after the user clicks a historical meeting. Capture continues independently. Clicking the active meeting in the sidebar returns to the live session.
3. **Interim transcript delivery:** Electron now forwards all Deepgram `transcript.segment` messages (interim and final) to the React window over a narrow preload IPC subscription. The renderer filters by meeting ID, shows interim text immediately, and continues using the transcript API for persisted/final segments. The backend logs a text-free interim heartbeat at most every two seconds.

Deepgram's `interim_results=true`, `endpointing=300` and `utterance_end_ms=1000` settings are retained. The 300 ms endpointing setting is for finalizing after a short pause; it should not suppress interim results. A long continuous utterance may still have its final segment only after the speaker pauses, but the interim words should now be visible while they speak.

## Verification performed

- Backend: 69 tests passed against SQLite.
- Desktop: 53 Node tests passed.
- Electron main, new API helper and preload JavaScript syntax checks passed.
- React TSX syntax transpilation passed using TypeScript's transpile API.
- Full Windows Vite type-check/build and actual Deepgram/Windows microphone integration still require the user's machine.

No schema migration is included. `.env`, `.git`, PostgreSQL data, and existing migrations are not changed.

## One-time stale backend restart

The 405 likely comes from a FastAPI process started before the Phase 1 route was installed. Close Contexa, inspect the process listening on port 8000, and stop only the process launched from this project's `backend\\.venv` if it is an old Uvicorn process. Then relaunch `Start-Contexa.ps1`. The compatibility fallback allows a meeting to proceed before that restart, but stable database-backed dedup requires the updated backend to be loaded.
