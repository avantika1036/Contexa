# Phase 1 — Persisted meeting-session lifecycle

## What changed

- Added a persisted `suspended` state distinct from `active` and `ended`.
- Added `suspended_at` and migration `20261101_0007`.
- Expanded stable capture-key uniqueness to cover both active and suspended rows.
- Added suspend and resume API endpoints.
- The auto-session endpoint resumes a recent suspended Google Meet session after an Electron restart.
- Expired suspended sessions are finalized (or discarded if empty) before a new session is created.
- Electron flushes the transcript stream and suspends capture on graceful quit / Ctrl+C instead of silently terminating the WebSocket.
- If a stale local continuity reference points to an ended session, Electron falls back to a valid session rather than retrying the ended session.
- Existing transcript data, memory items, `.env`, Docker volumes, and Git history are not reset or deleted.

## State transitions

```text
ACTIVE --capture interruption / app shutdown--> SUSPENDED
SUSPENDED --same meeting returns within 300s--> ACTIVE
SUSPENDED --different meeting appears---------> ENDED + new ACTIVE
SUSPENDED --resume window expires-------------> ENDED (or discarded if empty)
ACTIVE --explicit pause / confirmed end--------> ENDED
ENDED --resume request------------------------> rejected; never revived
```

## Database migration

Run `python -m alembic upgrade head` from `C:\Work\Contexa\backend` after applying the patch.
No database reset or Docker volume deletion is required.

## Validation

Backend regression tests cover suspend/resume, bounded recovery, stale cleanup, and ended-session rejection.
Desktop regression tests cover lifecycle API calls and safe handling of an ended local session.
