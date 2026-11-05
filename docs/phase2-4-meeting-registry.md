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
