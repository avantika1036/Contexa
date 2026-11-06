# Phase 2.4 — Multiple Windows and Meeting Registry

## Scope

This milestone separates meeting identity from the individual desktop windows that represent a meeting. The registry remains independent of the one audio stream selected for capture.

## 2.4.1 — Independent window inventory

`desktop/meeting-lifecycle.mjs` maintains two related levels of state:

- **Meeting lifecycle entry:** keyed by provider and meeting identity. Durable provider call IDs remain stable across process/window replacement. Non-durable identities remain scoped to process and HWND.
- **Window record:** keyed by observation source, process ID and HWND. A durable meeting can therefore contain multiple independently addressable browser/native window records, including records from different processes.

Each window record retains only meeting-window metadata needed for registry and UI integration: source, PID, process name, HWND, display title, meeting observation state, confidence, foreground state and observation timestamps. It does not retain arbitrary process command lines or raw accessibility trees.

Window records have their own availability state. When one window disappears while another representation of the same durable meeting remains visible, the missing window becomes `temporarily_missing`, then `unknown` after the configured grace period. It is retained for the configured registry retention period and can return without creating a new meeting lifecycle epoch. Provider-confirmed `left`/`ended` evidence remains terminal for that specific window until an explicit rejoin observation is seen.

The meeting-level state still uses the existing representative-observation policy: an active/present representation takes precedence over a terminal duplicate representation for the same durable call.

## Non-goals and limitations

This registry change does **not** implement simultaneous audio capture. The desktop runtime still owns a single `currentCapture` stream. The registry does not yet expose its snapshot to the Electron renderer or add multi-meeting capture arbitration. Those are subsequent Phase 2.4 milestones.

The registry is in-memory. It does not persist detected window records across an application restart; persisted meeting sessions remain the responsibility of the existing backend/session-continuity implementation.

## Automated coverage

The lifecycle tests cover:

- One durable meeting represented by windows in multiple browser processes.
- Two different durable meetings in the same browser process.
- One window disappearing while another representation remains visible.
- A missing window returning without a new meeting lifecycle epoch.
- Snapshot isolation (mutating a returned snapshot cannot mutate registry state).
- Distinct active and ended evidence for different windows representing the same call.
- A stale background surface not reviving an individually ended window.

## Validation still required on Windows

Automated Node tests do not replace live Windows validation. Test two Google Meet windows, two meetings in one Chrome process, Chrome and Edge simultaneously, native/browser combinations, focus switching, ending one meeting while another remains, window closure, rejoin and Electron restart before marking Phase 2.4 complete.

## 2.4.2 — Deterministic selection and single-stream arbitration

`desktop/capture-policy.mjs` now selects among eligible foreground observations deterministically. Priority is:

1. Explicit foreground evidence over the verified-background-Webex exception.
2. Higher provider confidence.
3. More advanced live observation state (`active`, then `joining`, then `candidate`).
4. More recent observation timestamp.
5. Stable provider/identity/PID/HWND ordering as a final tie-breaker.

`findAmbiguousMeetingProcessIds()` detects when one process currently represents multiple independent live meeting identities. Because the current `loopback-capture` integration captures a process audio stream rather than an isolated meeting tab, Contexa must not assign that mixed stream to one meeting. If an already-running capture process becomes ambiguous, the desktop suspends the current session and pauses process-level capture. Initial auto-selection also refuses candidates from an ambiguous PID. Duplicate windows for the same durable meeting identity do not count as separate meetings.

Ambiguity is based on currently observed states plus `temporarily_missing` records during the registry's missing grace period. A record that has advanced to `unknown` is retained for recovery/history but no longer vetoes process capture. A generic Google Meet `browser:*` background surface is not treated as proof of a second call when a call-specific `meet:<code>` identity is present in the same process; a foreground generic Meet surface alongside a different call remains ambiguous.

Google Meet can initially expose a descriptive page-title fallback such as `browser:google meet: online...` before the call code appears. When the same PID and HWND later expose `meet:<code>`, Contexa upgrades the existing capture session to the durable call identity. The ambiguity detector treats the provisional title identity and durable call identity as one window only when both observations refer to the exact same PID + HWND. A fallback observation on a different HWND remains independent and can still trigger the same-process safety pause. The initial identity-stabilization probe is likewise restricted to the original HWND, so a call code from another window in the same browser process cannot be borrowed.

During an existing capture, a Google Meet page-title fallback is not eligible to take over the single capture slot. Handoff waits until the candidate exposes a durable `meet:<code>` identity. If that code matches the current call, it is treated as another representation of the already captured meeting; if it differs, it can proceed through normal foreground and quiet-period confirmation. This prevents a second browser opened to the Google Meet home/pre-join page from stealing capture before its actual call identity is known.

When capture is paused, diagnostics list provider/identity/state/focus and the HWND where available, without logging raw window titles.

`MeetingHandoffTracker` generalizes the former provider-only handoff tracker. It can hand off between different meeting identities across different PIDs, including meetings from the same provider. It requires the current meeting to be backgrounded and the new candidate to be confirmed across the configured number of detector polls. Meeting-side audio (not microphone audio) is the preferred quiet-time reference. If no remote meeting audio has ever been observed, capture start time is used as the quiet baseline so a silent meeting does not block handoff indefinitely. Verified active Webex Desktop evidence (freshly inspected End Meeting control) follows the same background eligibility exception for handoff as it does for initial capture; genuine foreground candidates still outrank this exception. The current capture's background state is evaluated using actual OS focus only, so the Webex candidate exception cannot accidentally make a backgrounded current Webex stream appear foregrounded. Terminal, unknown, missing or restart-blocked candidates reset the confirmation chain.

Same-PID handoff is deliberately blocked. A process-scoped audio stream cannot prove which of two meetings inside that PID produced the audio. Safe support for those cases depends on Phase 3 meeting-tab/native isolated capture. A focus switch is not an End Meeting event: the previous session is suspended rather than ended, and no automatic-handoff restart block is added.

### Current boundaries

- The desktop still owns exactly one active capture stream.
- Different-process arbitration selects one stream owner; it does not provide simultaneous capture.
- Multiple independent meetings inside one PID are detected but process-level auto capture is paused for that PID until isolated capture exists.
- A meeting in a single browser window whose selected tab changes without exposing the other tab as a separate top-level window cannot be independently enumerated by the current Windows window detector. The Chrome extension/native messaging work in Phase 3 is required for tab-level visibility and audio isolation.
- Handoff has automated unit coverage, but live Windows focus-switch testing remains required before declaring 2.4.2 complete.

### Automated coverage

The desktop tests cover same-provider handoff across different PIDs, same-PID handoff refusal, current-meeting duplicate representations, ended-candidate confirmation reset, candidate title changes on a stable HWND, deterministic initial candidate ranking, ambiguous same-PID process detection, duplicate durable-window representations, per-PID ambiguity isolation, generic background Meet fallback handling, page-title-to-call-ID upgrades on the same HWND, refusal to borrow a call ID from a different HWND, refusal to hand off to an unconfirmed Google Meet page-title fallback, post-grace `unknown` record exclusion, no-remote-audio handoff, verified-background Webex handoff, foreground priority over the Webex exception, handoff away from a backgrounded captured Webex meeting, and retained missing-window safety checks.

### Missing-window focus semantics

A window record that is no longer returned by the OS window enumerator immediately loses its live focus claim: `foreground` becomes `false` and `windowFocus` becomes `unknown`. Its meeting identity remains `temporarily_missing` during the configured 30-second grace period and continues to count as a possible same-process audio conflict. After the grace expires it becomes `unknown` and no longer blocks an otherwise eligible meeting. This intentionally favors preventing mixed process-loopback audio over immediate recovery when the provider did not expose explicit leave/end evidence.
