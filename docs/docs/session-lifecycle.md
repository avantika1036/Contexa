# Session lifecycle and meeting identity

Contexa should create one session for one identifiable meeting, not one session for every
window-detection poll or audio reconnect. The lifecycle has two layers: an in-process grace
period for short capture interruptions, and a database uniqueness rule for stable external
meeting IDs.

## Identity rules

`desktop/meeting-session.mjs` builds a meeting key from the detected process name and window title.

1. **Explicit meeting IDs take priority.** Google Meet codes such as `abc-defg-hij` become
   `meet:abc-defg-hij`. A numeric ID is accepted for Zoom, Teams or Webex only when the window
   title explicitly labels it as a meeting/call ID.
2. **Meaningful title fallback.** If no explicit ID is available, a normalized browser or native
   title is used. Browser names, notification counters and running call timers are removed.
3. **Generic native titles.** Titles such as `Zoom Meeting` cannot identify a particular call,
   so they use a family wildcard (`zoom:*`, `teams:*`, `webex:*`). These keys are useful for
   short in-process reconnects but are not persisted as globally unique meeting identities.
4. **A process ID is not a meeting ID.** A browser or native application can keep the same PID
   across different calls. A matching PID with a different meeting key must never reclaim the
   prior session.

## Database-backed idempotency

For explicit stable IDs, the desktop calls `POST /api/meetings/auto` with the capture key. The
backend returns the existing active session or creates one. Migration `20261101_0006` adds
`meetings.capture_key` and a partial unique index that permits only one active row per key while
allowing a later occurrence to reuse the same external ID after the old session has ended.

The endpoint uses the database unique index as the final race guard. Two overlapping detector
requests for the same stable ID therefore converge on one active Contexa meeting.

Generic titles and process IDs are deliberately not persisted as globally unique IDs: doing so
would risk merging two different meetings that happen to use the same app/title. Their fallback
continuity remains process-local and best-effort until platform-specific call-state integrations
can provide better IDs.

## Lifecycle

1. **Startup.** Electron starts local services, waits for migrations, runs stale-session
   cleanup, and only then starts automatic detection.
2. **Create or reuse.** Explicit stable identities use `/api/meetings/auto`; manual sessions
   continue to use `POST /api/meetings`.
3. **Capture.** Electron connects to `/ws/meeting/{meeting_id}` and streams audio. Repeated
   detector polls do not create new sessions while a capture is active.
4. **Short interruption.** When capture stops temporarily, the session remains active for a
   grace period. An exact meeting-key match can reclaim it. PID equality alone cannot.
5. **Meeting change.** If a different explicit meeting ID appears in the same process, the old
   session is ended and the new meeting starts a separate session.
6. **End.** After the grace period, or when Auto Capture is paused/quit, the session is ended.
   Empty automatic sessions are discarded; sessions containing transcript data are retained.
7. **Stale recovery.** On startup, `POST /api/meetings/cleanup` ends abandoned active rows and
   removes empty stale sessions. Rows with live WebSocket connections are protected.

## Capture stop policy

`desktop/capture-policy.mjs` combines window presence with audio activity:

| Situation | Behavior |
|---|---|
| Brief window/title gap while speech is audible | Keep capture alive for a bounded period. |
| Meet title changes to another tab title while the same Chrome/Edge process still owns a window | Keep the same session and capture attached; do not interpret a selected-tab title change as leaving the call. |
| Browser process disappears and the meeting window is not found | Apply the missing-window and quiet thresholds, then suspend and defer ending the session. |
| Window remains but no audio is heard for the idle limit | Treat the meeting as ended and block immediate restart from the same still-open page. |
| Deepgram/WebSocket connection drops | Stop and let the detector reconnect using the same meeting key/session during the grace period. |
| A different explicit meeting ID appears in the same process | End the previous session and start a new one. |

Relevant optional settings:

- `CONTEXA_IDLE_END_SECONDS` (default 180; `0` disables idle ending)
- `CONTEXA_IDLE_RESTART_BLOCK_SECONDS` (default 600)
- `CONTEXA_SESSION_GRACE_SECONDS` (default 300)
- `CONTEXA_NATIVE_SESSION_GRACE_SECONDS` (default 60)
- `CONTEXA_STOP_AFTER_MISSING_SECONDS` (default 15)

## Known identity and detection limits

- Window-title detection is heuristic. When a stable Meet title disappears but the same
  Chrome/Edge process still owns a top-level window, Contexa treats this as an unverified tab
  switch and keeps the existing meeting attached instead of suspending after 15 seconds.
  The browser process may serve multiple tabs; this prevents false session splits but does not
  prove that the original Meet tab is still live. Tab-specific verification and audio isolation
  require the planned browser-extension/native-messaging integration. If the browser process
  itself disappears, the existing missing-window/quiet thresholds apply. The independent
  audio-idle end policy still applies while a capture is unverified.
- Some native clients expose only generic titles and no stable meeting ID. Two different calls
  in the same long-lived native process can be indistinguishable from a reconnect. The PID is
  not used to override a different known identity, but generic same-family titles remain a
  best-effort fallback.
- Browser process loopback can include other audible tabs in the same browser process. The
  browser-extension/tab-specific capture work is a later phase; it is not part of this patch.
- The desktop currently captures one detected meeting at a time.

## Cleaning up duplicates from earlier versions

Older empty duplicates are not automatically deleted at every startup. To remove ended sessions
that have no transcript (meetings with transcript data are untouched), run this manually after
reviewing the meeting history:

```powershell
Invoke-RestMethod -Method Post "http://127.0.0.1:8000/api/meetings/cleanup?purge_empty=true"
```

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/meetings` | Create a manual session. |
| `POST /api/meetings/auto` | Atomically create/reuse an active or recently suspended session for an explicit stable meeting ID. |
| `POST /api/meetings/{id}/suspend` | Persist a recoverable interruption without ending the meeting. |
| `POST /api/meetings/{id}/resume` | Reactivate a suspended session within the configured recovery window; ended sessions are rejected. |
| `POST /api/meetings/{id}/end?discard_if_empty=true` | End an automatic session; discard it only if it has no transcript. |
| `DELETE /api/meetings/{id}` | Delete a meeting and dependent transcript/memory rows (409 while connected). |
| `POST /api/meetings/cleanup` | Close abandoned active sessions; optionally purge old empty ended sessions. |

## Speaker segmentation

Deepgram word-level speaker IDs are split into separate transcript segments when the diarized
speaker changes. Very short one-word ID flickers may be merged by the existing segmentation
policy because diarization can be unstable on short interjections. The labels remain estimates;
Contexa does not infer real participant names.

## Persisted suspension and desktop restarts

Desktop capture interruptions are persisted as `status="suspended"` with `suspended_at`.
This is distinct from `ended`: a suspended row has not triggered end-of-meeting memory
extraction and can be resumed. The desktop first flushes the Deepgram stream, closes the
capture devices, then calls `POST /api/meetings/{id}/suspend`.

On restart, a stable provider identity is sent to `POST /api/meetings/auto`. A recent
suspended row is atomically returned to `active`; an ended row is never revived. The default
resume window is 300 seconds (`SUSPENDED_SESSION_RESUME_GRACE_SECONDS`). Expired suspended
sessions are finalized (or discarded if empty) before a fresh session is created. The unique
capture-key index covers both `active` and `suspended` rows, preventing duplicate open sessions.

The desktop's explicit resume endpoint (`POST /api/meetings/{id}/resume`) is also bounded by
the same recovery window. If the backend reports 404/409 for an old local continuity reference,
Electron discards that reference and requests a valid session rather than repeatedly trying to
open a WebSocket for an ended row.

Closing the main window only hides Contexa in the system tray; capture continues. Choosing
Quit or shutting down through the desktop's graceful exit path flushes and suspends the current
session rather than ending a meeting that may still be running. A hard process kill cannot flush
audio, but a still-active stable-key row can be recovered through the idempotent auto-session
endpoint on the next launch.


## Shutdown suspension and audio-stream fencing

The backend distinguishes live WebSocket connections from active upstream audio/transcription streams. UI/control WebSockets may remain connected briefly after `audio.stop` while the ASGI disconnect cleanup is still running. They must not block suspension once the upstream Deepgram stream has been finalized.

`ACTIVE_MEETING_STREAMS` is incremented only after an upstream transcription stream is established and decremented after finalization and provider close complete. The backend sends the `audio.stop` acknowledgement after that decrement. The suspend endpoint rejects only while this stream count is non-zero; the WebSocket connection count remains in place for cleanup and deletion protection.

This ordering makes Electron's shutdown sequence deterministic: stop microphone and loopback readers, flush/finalize the transcription stream, receive the `audio.stop` acknowledgement, close the WebSocket, then persist the meeting as `suspended`. No database migration is required for this correction.
