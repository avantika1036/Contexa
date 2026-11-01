# Phase 1 — Restart Recovery and Meeting History Fix

## Source baseline

This patch is based on the latest uploaded source archives:

- `desktop.zip`
- `frontend(2).zip`
- `backend(20261101-184203).zip`

## Defect 1: Google Meet was not detected after Electron restart

The detector accepted the generic `Google Meet` window title and the initial-loading variants, but did not accept the stable post-load title `Meet - abc-defg-hij` by itself. After Contexa restarted, this meant the still-running Google Meet window was filtered out before the desktop could call `POST /api/meetings/auto` and reclaim the suspended session.

The browser meeting-window predicate now accepts a Google Meet title containing the standard call-code pattern, including the exact title form observed in the Windows logs. Other browser windows remain rejected. The backend already supports reclaiming a recent suspended session by its durable `capture_key`; no backend or database migration change was needed.

## Defect 2: Clicking the selected history row emptied its transcript

`selectMeeting()` cleared `transcriptSegments` on every click. When the user clicked the already-selected meeting, `selectedMeetingId` did not change, so React did not rerun the transcript-loading effect. The cleared transcript therefore remained empty until the user selected a different meeting and returned.

The handler now preserves transcript state when the clicked meeting is already selected, while still switching to the Transcript tab. Selecting a different meeting retains the existing clear-and-load behavior.

## Files changed

- `desktop/capture-policy.mjs`
- `desktop/main.mjs`
- `desktop/test/capture-policy.test.mjs`
- `frontend/src/App.tsx`

## Validation

- Desktop syntax checks: passed
- Desktop unit tests: 59 passed
- Backend tests: 76 passed using `DATABASE_URL=sqlite+pysqlite:///:memory:`
- Frontend TSX transpile syntax check: passed
- Full frontend `npm run build` / `npm run lint`: not run successfully in the extraction environment because the uploaded frontend archive has no `node_modules`; on Windows, run them after dependencies are present.

No database migration is required. Existing meeting rows, transcript segments, environment files, and PostgreSQL volume are unchanged.

## Windows verification

1. Extract the patch over the repository root.
2. Run `npm run check` and `npm test` in `desktop`.
3. Run `npm run build` and `npm run lint` in `frontend`.
4. Launch Contexa while the same Google Meet remains open.
5. Confirm the backend logs `Resumed suspended session ... for capture key meet:<code>` and Electron logs that the backend returned the existing session, followed by `Automatic meeting capture started`.
6. Speak and confirm the new transcript segments appear under the original meeting ID.
7. Click the currently selected meeting-history row repeatedly; the transcript should remain visible.
