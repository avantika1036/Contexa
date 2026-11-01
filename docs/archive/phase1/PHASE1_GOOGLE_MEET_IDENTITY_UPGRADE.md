# Google Meet session continuity fix

## Observed failure

A single Google Meet call initially appeared to Windows as the generic title `Google Meet`, which Contexa classified as `browser:*`. After the call surface loaded, Windows exposed the call code in the title (`Meet - fai-wivv-szk`), which Contexa classified as `meet:fai-wivv-szk`.

The transition classifier did not recognize the generic-to-explicit identity change in the same Chrome process. It therefore treated the original window as missing. Once the missing-window and quiet-period thresholds elapsed, capture stopped and a second Contexa meeting was created for the same call.

## Change

- Detect a same-process transition from `browser:*` to an explicit Google Meet call-code identity.
- Upgrade the active capture's in-memory session key and title, and refresh `lastMatchedAt`.
- Keep the same Contexa meeting ID and active audio/transcription stream.
- Preserve the existing behavior where a different explicit Meet call code in the same browser process is a new meeting.
- Do not change database schema, persisted transcript data, audio capture policy, or microphone thresholds.

## Verification

Desktop unit tests cover the same-process identity upgrade and reject promotion from a different browser process. Existing explicit-meeting transition tests continue to protect the new-call behavior.

This patch affects future captures. It does not automatically merge two historical Contexa meeting records that were already created by the earlier bug.
