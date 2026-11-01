# Phase 1 — Earphone / microphone hot-plug recovery

## Confirmed failure

On Windows, connecting the user's earphones invalidated the microphone endpoint already opened by `@audio/mic`. The native reader reported `EDEVICELOST` (`the input device stopped (unplugged?)`). The previous handler treated every microphone error as fatal and stopped the entire meeting capture, suspending the Contexa session. Removing the earphones did not recreate the microphone reader.

## Change

- Enumerate Windows input devices with `devices()` from `@audio/mic` at capture startup and every recovery attempt.
- Open the selected endpoint explicitly by its enumerated device ID.
- Prefer the current Windows default input endpoint. If Windows does not report a default, retain the previous endpoint when it is still present; use the sole remaining input if there is exactly one. Do not guess between multiple non-default devices.
- Treat `EDEVICELOST` and `ENODEVICE` as recoverable endpoint changes.
- Close the invalid reader, keep the existing meeting WebSocket/session alive, and retry input enumeration/open with bounded backoff (500 ms, 1 s, 2 s, 4 s, then 5 s).
- Resume microphone PCM into channel 1 after the new endpoint delivers its first buffer. Meeting application audio on channel 0 remains on the same stream.
- Keep the user informed through the existing capture-card error text, the tray tooltip, and tray notifications. On successful recovery, clear the hot-plug warning.
- Continue to treat unrelated microphone errors (for example permission failures) as fatal. This avoids silently pretending that the local speaker channel is being captured.

## Privacy and data handling

The change does not store audio, change transcription thresholds, or introduce OS-wide audio capture. It only enumerates input-device metadata and reopens an input already authorized by the user's Auto Capture consent. Device names may appear in local diagnostics; device IDs are not logged.

## Tests

The desktop test suite covers default-device preference, retaining a still-present device, sole-device fallback, ambiguous-device refusal, recoverable device-loss errors, permission-error classification, and bounded retry delays.

## Windows acceptance test

1. Start Contexa with the current default microphone and join one Google Meet.
2. Speak and confirm transcription.
3. Insert the earphones while keeping the same Meet open.
4. Confirm Contexa logs `Microphone capture error ... EDEVICELOST`, then `Microphone input recovered: <device name>`.
5. Confirm the meeting remains `In progress` (not `Recoverable · paused`), its meeting ID does not change, and transcription resumes after the replacement endpoint delivers its first buffer.
6. Remove the earphones and repeat. Contexa should again reconnect to the Windows default input without creating another meeting.

Expected limitation: speech during the short interval between endpoint loss and successful input reopen cannot be recovered retroactively. The UI must indicate microphone reconnection during that interval.
