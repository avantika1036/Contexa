# Phase 2.3 — Meeting Lifecycle State Machine Hardening

## Scope

This milestone hardens the existing observation-to-lifecycle path. It does not change provider matching rules, audio routing, or the one-active-audio-stream policy. Phase 2.4 remains separate.

## Runtime model

`MeetingLifecycleRegistry` consumes provider-neutral observations on each detector poll and maintains one lifecycle entry per identity:

- Durable provider identity: `provider|identityKey` (for example, a Google Meet call code or the Webex desktop PID/HWND identity).
- Non-durable fallback: `provider|identityKey|pid:<pid>|hwnd:<windowId>` so generic application windows are not merged across unrelated windows.
- Each entry records state, epoch, first/last observation time, terminal time, missing time, and the number of windows currently representing that identity.

## State transitions

| Incoming evidence | Previous state | Result |
|---|---|---|
| First candidate/joining/active/background | Not tracked | `discovered`, epoch 1 |
| Observation temporarily absent | Present | `temporarily_missing` |
| Still absent past the 30-second grace | `temporarily_missing` | `unknown` / `missing_expired`; this is not a leave/end event |
| Same identity returns after a temporary gap | `temporarily_missing` or `unknown` | `returned`; preserve epoch |
| Provider explicitly reports leave/end | Present | `left` or `ended`; keep terminal state |
| Terminal identity appears only as background/unknown | `left` or `ended` | Keep terminal state; do not rejoin |
| Same identity returns as candidate/joining/active | `left` or `ended` | `rejoined`; increment epoch |

Only a candidate, joining, or active observation can create a new lifecycle epoch. A background-only window is not proof that a user rejoined the call. For duplicate windows representing one durable call, a live candidate/joining/active observation takes precedence over a terminal duplicate so one stale window cannot terminate a call still represented by another live window.

Lifecycle events preserve `fromState` for `state_changed`, `returned`, and `rejoined`, allowing diagnostics and tests to explain the transition rather than only its destination.

## Capture/session coordination

- The lifecycle registry is separate from the currently selected audio capture. The desktop still captures one meeting at a time.
- Explicit provider leave/end stops and finalizes the matching capture, and adds a restart suppression for that exact identity/window.
- Restart suppressions are retained as a list, not a single last-ended item. Ending Zoom cannot erase an earlier Google Meet suppression.
- Suppression records are persisted in Electron `userData/settings.json` using a SHA-256 identity hash rather than raw meeting titles/codes. Stable identities are suppressed across process/window replacement until expiry; non-durable identities remain scoped to their PID/HWND.
- A matching terminal-to-present `rejoined` event may clear only that identity's suppression. A generic background observation or ordinary temporary return cannot.
- Explicit Contexa shutdown flushes the audio stream and persists the backend session as `suspended`. A deliberate End Meeting or confirmed provider terminal event ends it. Backend resume rejects ended sessions and enforces the configured recovery window.
- Short capture interruptions use the existing continuity grace: 300 seconds for browser meetings and 60 seconds for native meetings by default. The idle restart suppression defaults to 600 seconds. These are separate clocks.

## Provider-specific evidence and limits

- Webex desktop uses a stable `webex:window:<pid>:<hwnd>` identity and Windows UI Automation meeting controls. The `End meeting` control is debounced; one missing scan is tolerated and two successful scans without it produce terminal evidence. An inaccessible UI Automation tree is not treated as an end event.
- Google Meet, Zoom and Teams use their current provider adapter evidence and title/state patterns. Browser title detection is not an authoritative provider call-state API.
- The 180-second meeting-side-audio idle fallback is still a heuristic. It can stop a genuinely live meeting with no incoming application-side audio for the full interval; it is not equivalent to an authoritative leave event.
- Browser process continuity can preserve capture when the selected tab title changes, but the current implementation cannot prove which tab is still live or isolate a tab's audio. That requires the Phase 3 extension/native-messaging work.
- The lifecycle registry itself is in-memory. Durable backend meeting status and privacy-minimized restart suppressions survive Electron restarts; detailed per-window observation history/epochs do not.
- The state machine and detector remain Windows-specific. macOS/Linux validation belongs to Phase 2.5.

## Validation performed on the supplied repository snapshot

- Desktop `npm run check`: passed.
- Desktop `npm test`: 162 passed, 0 failed.
- Backend `DATABASE_URL=sqlite+pysqlite:///:memory: python -m pytest tests -q`: 82 passed.
- Frontend build/lint was not run successfully in this extracted environment because its dependencies are not installed (`vite/client` and `node` type definitions are unavailable). This milestone changes no frontend files.

Automated tests cover temporary-missing versus terminal state, grace-period return, terminal-to-active rejoin epochs, background-only non-rejoin, duplicate durable windows, Webex PID/HWND continuity, restart-block matching/persistence, and cross-provider handoff confirmation. Windows live smoke tests are still required before declaring the milestone complete.

## Windows smoke test before commit

1. Start Google Meet, confirm one session, switch tabs and return within the grace period; the same session should continue.
2. Leave Google Meet and wait for the supported leave/idle behavior; confirm its capture ends and an old background window does not resurrect it.
3. Start Zoom, then Teams desktop, then Webex desktop; each should get its own session and previous capture should finalize on confirmed handoff.
4. Quit Contexa from the tray while a meeting remains active; restart within five minutes; the suspended session should resume without a duplicate.
5. Explicitly end a meeting in Contexa; it must not restart from the still-open window. A different meeting must still be selectable.
6. In Webex Desktop, confirm the UI Automation `End meeting` control marks the captured PID/HWND terminal, then join a fresh meeting and confirm a new lifecycle epoch/session.

Do not close Phase 2.3 until these live Windows checks pass on the user's current build.
