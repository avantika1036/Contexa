# Audio capture troubleshooting

## No meeting is detected

- Confirm Auto Capture was explicitly enabled from the Contexa tray menu and is not paused.
- Join the meeting in a supported Zoom, Teams, Webex or browser meeting window. Detection relies on process names and window titles; localized or changed titles may need a rule update.
- Open the Contexa window or tray menu and confirm PostgreSQL and FastAPI are running.
- The monitor intentionally does not start on a generic browser window or app home screen.

## One Google Meet appears as two Contexa meetings

Google Meet can first expose a generic browser title (`Google Meet`) and only later include its call code (for example, `Meet - abc-defg-hij`). Contexa treats that same-process title change as an identity upgrade and keeps the existing session. A different explicit Meet call code is still treated as a new meeting. If this happens again, capture the desktop log around the `Automatic meeting capture started/stopped` messages and check whether the PID stayed the same.

## Meeting detected, but there is no transcript

- Confirm `DEEPGRAM_API_KEY` is set in the repository-root `.env` and restart Contexa/FastAPI after changing it.
- Make sure the selected meeting app is producing audio through a Windows output endpoint.
- In Windows Settings, allow microphone access for desktop applications and choose a working microphone.
- Inspect the backend terminal/log for `Deepgram stream started`, `Deepgram transcript received`, and any `transcription.error` message. A connected WebSocket does not prove audible speech was present.
- Very short audio chunks often correspond to silence. Contexa suppresses sustained near-silence in the desktop app to reduce useless streaming.

## Your voice or remote participants are missing

The desktop app mixes process-specific meeting audio with a microphone stream. Check both the Windows default/selected microphone and the meeting app's output device. Use a headset to reduce echo. Mixed audio diarization is approximate and can assign uncertain speaker IDs; it is not equivalent to separate per-speaker audio tracks.

For browser meetings, process-loopback can include other audible tabs within the browser process. Keep unrelated tabs quiet. Native process capture is the preferred desktop path; the manual browser fallback asks for browser audio sharing plus microphone permission and may have OS/browser limitations.

## Consent and stopping

Auto Capture is off until enabled after the consent prompt. Pause it anytime from the tray menu. Raw audio is processed in memory and streamed to Deepgram, not written to local audio files. The microphone can pick up other people in the room while a meeting is active; tell participants and obtain any required permission.

## Split-channel capture (desktop + local microphone)

The Windows desktop capture path uses 48 kHz signed 16-bit PCM with two channels. Channel 0 contains audio rendered by the detected meeting application's process tree; channel 1 contains the local microphone. Deepgram receives `channels=2&multichannel=true`, so the sources are transcribed independently rather than mixed into one stream. Saved transcript segments store the provider's `audio_channel` value (`0` for meeting-process audio, `1` for the local microphone) when returned. A new additive Alembic migration creates this nullable field; existing transcript data is retained.

The app deliberately refuses to claim capture started if the microphone API does not produce actual buffers within four seconds. Check Windows microphone privacy permissions and the selected/default input device. In the desktop log, `Microphone reader started` confirms initialization; `Audio channel activity` reports separate meeting and microphone activity counts. `Deepgram transcript received` confirms result events are coming back.

Capture is limited to recognized meeting windows while Auto Capture is enabled, not a strict semantic detector of whether every spoken word is meeting-related. The physical microphone is active for the recognized meeting window so the local speaker can be transcribed. Browser process capture can include other audible tabs belonging to the same browser process tree. Pause capture or quit Contexa when you do not want these sources sent for transcription.

## "No audio backend available" or "microphone produced no audio buffers"

Two separate causes have been seen on Windows:

1. **Missing native addon.** `@audio/mic` loads its Windows addon from `@audio/mic-win32-x64`.
   An old lockfile pinned that package to the empty placeholder version `0.0.0`, so `mic.node`
   was missing. `desktop/package.json` now requires `@audio/mic` and `@audio/mic-win32-x64`
   `^1.4.0`. Check with:

   ```powershell
   Set-Location .\desktop
   npm ls @audio/mic @audio/mic-win32-x64
   Test-Path .\node_modules\@audio\mic-win32-x64\mic.node
   ```

2. **One buffer, then silence.** `@audio/mic` returns a single chunk per `read()` call. Capture
   code that registers its callback once receives about 20 ms of audio and then nothing, which
   looks exactly like a blocked microphone. `desktop/mic-reader.mjs` re-arms the read after
   every chunk. If you ever see "no audio buffers within 4 seconds" again, first rule out
   Windows privacy settings (Settings > Privacy & security > Microphone, including "Let desktop
   apps access your microphone"), the default input device, and exclusive-mode apps.

## Live transcript updates in the Electron desktop window

The native Electron capture process owns the Deepgram WebSocket. Deepgram sends interim (`is_final=false`) results before finalizing a phrase. Electron forwards these events to the React renderer through a narrowly scoped preload IPC subscription. The renderer filters events by the currently selected meeting ID, shows interim text immediately, and continues polling the transcript REST endpoint for persisted/finalized segments. This prevents the UI from waiting only for finalized database rows while a participant is still speaking.

The backend logs a privacy-safe `Deepgram interim transcript update` heartbeat at most once every two seconds when non-empty interim text arrives. It logs finalized results separately. If audio chunks are forwarded but there are no interim heartbeats, investigate the audio stream format, channel activity and Deepgram connection; if interim heartbeats are present but the UI does not update, inspect the Electron renderer/IPC bridge and selected meeting ID.

Deepgram `endpointing=300` is retained: it finalizes a phrase after a 300 ms pause. Interim updates should arrive before that finalization; a long continuous utterance may therefore produce one final segment only after a pause, while its interim text should still be visible in Contexa.

## Browsing older meetings during a live call

The meeting list continues refreshing in the background. Automatic selection follows a detected live meeting until the user manually clicks a history item. After a manual selection, polling no longer forcibly switches the workspace back to the live meeting. Capture continues independently in Electron; select the active meeting in history to return to its live transcript.

## HTTP 405 from `/api/meetings/auto`

This usually means the local FastAPI process answering port 8000 is an older process that does not have the Phase 1 idempotent endpoint loaded. The desktop now falls back to the legacy `POST /api/meetings` endpoint so capture can continue and emits a warning. The fallback preserves in-process session continuity but cannot provide database-backed deduplication across an Electron restart. Stop the old FastAPI process from this project's `backend/.venv` and relaunch Contexa to load the new endpoint.
