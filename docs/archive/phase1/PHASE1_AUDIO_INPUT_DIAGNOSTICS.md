# Phase 1 — Audio input diagnostics

This patch adds privacy-preserving numeric signal diagnostics to the desktop capture path.

## What it logs

- The currently detected supported Windows meeting windows (PID, normalized meeting key, foreground/background flag, window title), only when the snapshot changes.
- Microphone and meeting-channel PCM RMS and peak levels, updated approximately every two seconds.
- Whether each channel crossed the existing silence-gate threshold.
- The final audio counters already present on capture stop.

No PCM samples, audio content, transcript text, device names, or credentials are logged by the new diagnostics.

## Why the gate is intentionally unchanged

The latest supplied logs show that Deepgram connected, but only 16 PCM chunks reached it and the microphone was classified active for 10 output frames. This is consistent with the silence gate suppressing almost all frames, but it does not tell us whether the raw microphone signal is silent/very quiet or whether the threshold is too high. The new RMS/peak log separates those cases without blindly increasing Deepgram usage by forwarding background noise.

## Install

Extract the ZIP over `C:\Work\Contexa`, then run:

```powershell
Set-Location C:\Work\Contexa\desktop
npm run check
npm test
```

No backend changes or database migration are required.

## What to look for

During a 10–15 second spoken test, inspect lines beginning with:

```text
Audio input meter (no audio content logged):
```

- `mic_rms` / `mic_peak` persistently `0`: microphone reader is not receiving nonzero samples.
- Values change while speaking but `mic_gate_active=false`: the existing activity threshold is suppressing the speech; tune it based on measured levels.
- `mic_gate_active=true` and `forwardedFrames` rises, but there are no Deepgram interim/final result logs: investigate provider stream/PCM format and backend result handling.
- `visible supported windows` lists multiple Meet codes: compare `foreground` and keys to determine whether a stale/background Meet window is being selected.
