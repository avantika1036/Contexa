# Webex Desktop UI Automation troubleshooting

Contexa uses two independent Windows PowerShell helpers:

- `desktop/windows-window-snapshot.ps1` enumerates ordinary top-level windows and remains responsible for Google Meet, Zoom, Teams and browser detection.
- `desktop/webex-uia-snapshot.ps1` performs the CiscoCollabHost-specific UI Automation query for the Webex `End meeting` / `Leave meeting` controls.

The Webex UI Automation helper first resolves the exact CiscoCollabHost top-level window by PID, then searches only that window for the meeting-control names. It no longer enumerates every UI Automation descendant on the entire Windows desktop. The four supported names (`End meeting`, `Leave meeting`, `End call`, and `Leave call`) are combined into one `OrCondition`, so the helper performs one descendant-tree search rather than up to four full traversals. A successful probe includes an elapsed-time measurement in the privacy-safe accessibility diagnostic.

Electron caches positive Webex meeting-control evidence for 12 seconds after the helper completes, not from before the helper launches. The PowerShell timeout is 20 seconds. It does not cache a successful absence: each of the two scans required to end a call must come from a distinct successful UI Automation query. If a later UIA process fails or returns `inspected:false`, the last verified positive result can be carried as explicitly stale evidence for up to 60 seconds. Stale evidence preserves the current call identity but does not count as a fresh positive or negative scan. A UIA failure is never treated as a leave event.

## Background Webex calls

The detector normally requires a foreground meeting window to start automatic capture so an old background browser/app window cannot steal the capture slot. Webex Desktop has a stronger, provider-specific signal: the verified CiscoCollabHost process and PID/HWND identity plus a successful UI Automation inspection that finds the live `End meeting`/`Leave meeting` control. That exact high-confidence active Webex Desktop observation is eligible even while Contexa or another window has focus. Idle Webex Home, inaccessible UIA state, browser Webex pages, and background windows from other providers do not get this exception.

## Expected logs

During a Webex Desktop call, expect a diagnostic similar to:

```text
[Webex desktop] accessibility evidence: pid=18760:uia=available:meeting-controls=present:...ms
[Meeting lifecycle] discovered: webex/webex:window:18760:<hwnd>, state=active, epoch=1.
[Meeting detector] supported meeting windows: webex/native_window:webex:window:18760:<hwnd>:active:high:18760:background:epoch1
Automatic meeting capture started: Webex
```

The `background` focus label is expected if Contexa has focus. The verified active-Webex exception allows capture to start in that case.

After leaving the meeting, two distinct successful UIA scans without the meeting control produce the terminal observation. An inaccessible UIA tree or a timed-out helper does not count as a missing-control scan.

## Validation

- `npm run check` passes.
- `npm test` passes with tests for verified background Webex selection, idle/unverified Webex rejection, other-provider background rejection, top-level UIA scoping, and probe-duration diagnostics.
- The actual PowerShell UI Automation behavior still requires a live Windows test with the installed Webex Desktop client.


## Webex window recreation and duplicate-session prevention

The top-level Webex HWND can change while the same CiscoCollabHost process remains in the same active call. Contexa therefore tracks confirmed Webex meeting-control state per verified host PID. The first active HWND is retained as the canonical call identity while positive `End meeting`/`Leave meeting` evidence continues. A replacement HWND becomes the current window observation but does not change the Contexa meeting identity or backend recovery key.

Missing window snapshots and UI Automation timeouts are not counted as successful absence scans. Two successful UIA scans with no meeting controls mark the call ended. A subsequent positive call starts a new call epoch and receives a distinct identity (`webex:window:<pid>:<hwnd>-call2`, etc.), even if Windows reuses a prior HWND. A different CiscoCollabHost PID is never merged into the existing call. A new call epoch begins only after two successful UIA scans have confirmed the meeting controls are absent and a later scan finds them present again. If UIA remains unavailable throughout a leave-and-rejoin sequence, the detector cannot reliably distinguish those calls from a continuously active call; it conservatively preserves continuity rather than manufacturing a duplicate session.

Expected continuity log behavior: the `[Meeting detector]` identity remains the original canonical HWND after a replacement HWND is observed, and no `different meeting identity` stop/start pair appears for that transition. A true new call after an observed end should use a `-call2` (or later epoch) suffix and create a new Contexa session.

## Detecting a second Webex meeting in the same desktop process

A further edge case occurs when Webex removes its top-level `Webex` HWND completely between two calls. In that state there is no row for the UI Automation helper to inspect, so the meeting-control tracker previously received an empty window list and never advanced the call epoch. The next meeting in the same `CiscoCollabHost` PID then inherited the previous call identity and its explicit End Meeting suppression block.

Contexa now treats a sustained absence of the verified top-level Webex host window as terminal after a 20-second grace (configurable with `CONTEXA_WEBEX_WINDOW_ABSENCE_SECONDS`, minimum 10 seconds). One or brief missing snapshots do not end a call. A returning HWND before the grace expires preserves the original canonical identity. Once the grace expires, the tracker ends that call epoch; the next positive UIA meeting-control observation gets a new identity with a `-callN` suffix. The new epoch is a different durable capture key, so the previous explicit-stop block does not suppress the new meeting and the backend creates a separate history row.

The positive UIA cache is discarded when the top-level Webex host window disappears, forcing a fresh accessibility query when the window returns. This prevents an old call's cached positive control result from being mistaken for evidence about the next call.

Expected transition logs:

```text
[Webex desktop] no verified Webex host window for 20s; ending call identity webex:window:18760:10093378.
[Meeting lifecycle] discovered: webex/webex:window:18760:3348120-call2, state=active, epoch=1.
[Meeting session] provider=webex ... semanticKey=webex:window:18760:3348120-call2 recoveryKey=webex:window:18760:3348120-call2
```

A new call may take up to the configured absence grace to become distinguishable when Webex removes its top-level window entirely and never exposes a successful UIA scan with meeting controls absent. This is deliberately conservative to avoid splitting one call during ordinary HWND recreation.

