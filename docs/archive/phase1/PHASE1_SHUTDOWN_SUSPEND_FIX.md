# Phase 1 shutdown suspension race fix

## Symptom

During tray Quit, Electron stopped the audio stream and then called the backend suspend endpoint. The backend sometimes returned HTTP 409 with `Stop the active capture stream before suspending this meeting`, even though Electron had received the `audio.stop` acknowledgement and closed its local WebSocket. The meeting therefore remained `active`, and a later app launch could not follow the intended persisted-suspension recovery path.

## Root cause

The backend used `ACTIVE_MEETING_CONNECTIONS` to decide whether suspension was safe. That counter tracks ASGI WebSocket connections, not active audio capture. A connection can remain open for UI/control traffic after its Deepgram stream has been finalized; additionally, server-side disconnect cleanup can run after the client observes its own close event.

## Fix

- Add `ACTIVE_MEETING_STREAMS`, separate from WebSocket connection accounting.
- Increment the stream count when a Deepgram upstream stream is established.
- Decrement it only after `Finalize`, `CloseStream`, result-reader completion and provider close have been attempted.
- Keep the meeting suspend endpoint fenced only by active audio streams.
- Preserve `ACTIVE_MEETING_CONNECTIONS` for cleanup and deletion protection.
- Add a regression test proving suspension returns 409 before `audio.stop`, then succeeds after the `audio.stop` acknowledgement even while the control WebSocket remains connected.

## Compatibility

No migration is required. No transcript rows, meeting records, settings, or environment files are rewritten. The existing Electron shutdown order already waits for the `audio.stop` acknowledgement before calling suspend; this patch makes the backend's guard match that contract.
