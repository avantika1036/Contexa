# Contexa meeting audio + restrained UI refresh

This is an overlay patch for the cleaned Contexa project. It does not include `.env`, `.git`, dependencies, database files, or generated build output.

## What this patch changes

- Desktop capture sends two independent PCM channels to Deepgram: channel 0 is audio rendered by the detected meeting application's process tree; channel 1 is the local microphone.
- The microphone reader is registered once using the `@audio/mic` 1.2 callback API. The desktop capture refuses to start if the microphone does not produce a real buffer, rather than silently claiming to capture both sides.
- Browser tab/window manual capture preserves meeting audio and microphone as separate channels. The backend declares `channels=2` and `multichannel=true` to Deepgram for both PCM and container capture when applicable.
- Final transcript segments persist the provider's channel index in a new nullable `audio_channel` column. Existing rows remain valid and unchanged.
- The Electron app applies pending Alembic migrations additively at startup after the local database health check succeeds. The new migration adds only `transcript_segments.audio_channel`; it does not reset or delete data.
- Transcript labels distinguish `You · microphone` from `Meeting speaker N` when the provider returns channel indexes. Provider diarization is still an estimate; one mixed remote-meeting channel cannot guarantee perfect person identity.
- The overview gets restrained violet, teal, blue and amber accents and cleaner independent scrolling. The existing layout is retained.

## Apply on Windows

1. Exit Contexa completely using the tray menu's **Quit Contexa** item. Stop any manually running Uvicorn server before continuing.
2. Extract this ZIP into `C:\Work\Contexa` and allow files to be overwritten. Do not delete or replace `.env`, `.git`, Docker volumes, or the database.
3. Run from PowerShell:

   ```powershell
   Set-Location C:\Work\Contexa
   Set-ExecutionPolicy -Scope Process Bypass
   .\Start-Contexa.ps1
   ```

4. On startup, Electron checks the database and runs `python -m alembic upgrade head` using `backend\.venv\Scripts\python.exe`. If the migration fails, Contexa shows an error dialog and does not reset the database.
5. Keep Auto Capture enabled only after consenting. Test a short meeting with audible remote speech and your own speech. Inspect the backend log for `Deepgram transcript received` messages and the desktop log for `Audio channel activity` counts.

## Verification in the packaging environment

- Backend pytest: 37 passed.
- Alembic chain: migrated a disposable SQLite database through `20261030_0005` and verified the new `audio_channel` column plus existing decision-state column.
- Desktop source: `node --check` passed for `main.mjs` and `preload.cjs`; 2 desktop UI-server tests passed.
- React/TypeScript: syntax transpilation passed.
- A Windows production Vite build and physical microphone/process-loopback test could not be performed here. Run the project launcher on Windows and verify both audio sources during a real meeting before relying on it.

## Audio behavior and privacy limits

Capture starts only while Auto Capture is enabled and a supported meeting window is recognized. The microphone is captured while that window is recognized so your voice can be transcribed; the app cannot generically infer every meeting client's mute state. Nearby speech can therefore be sent while the meeting window is open. Browser process audio may include other audible tabs in the same browser process tree. Raw audio is streamed for transcription and is not stored by Contexa. Pause/quit Auto Capture and notify participants as required.
