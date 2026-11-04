# Contexa Phase 2 — Meeting-aware detection

## Phase 1 exit evidence

The uploaded repository snapshot contains the browser-tab continuity fix, the persisted meeting identity/session recovery work, microphone hot-plug recovery, and the related desktop regression tests. The tested acceptance scenarios reported by the user include window/tab switching, switching between meetings, app quit/restart recovery, and the earlier session lifecycle cases.

Validation run against the uploaded snapshot:

- Desktop syntax checks: passed.
- Desktop tests: 88 passed.
- Backend tests using SQLite: 81 passed.
- Frontend build: not run from this extracted snapshot because `frontend/node_modules` is absent. The user's Windows launcher has already completed a successful frontend production build during the latest live testing.

## Current Phase 2 baseline from source inspection

### Detection implementation

- `desktop/main.mjs` enumerates visible top-level Windows windows through `EnumWindows` and normalizes process name, PID, title, and foreground state.
- `desktop/capture-policy.mjs` uses process-name/title regular expressions to identify supported meeting windows for Zoom, Teams, Webex, and browser-hosted meetings.
- `desktop/meeting-session.mjs` extracts Google Meet call codes from titles. Native Zoom/Teams/Webex identities are durable only when an explicitly labelled numeric meeting/call ID appears; otherwise the code falls back to process-family/title-derived keys.
- `desktop/main.mjs` currently owns a single `currentCapture`, so it can capture only one meeting stream at a time even though it can enumerate multiple windows.
- Browser tab continuity currently uses the owning browser process as a fallback when the selected window title stops identifying the meeting. This prevents false suspension on tab switches, but a browser process remaining alive is not proof that the original meeting tab/call is still active.
- Leave/end/rejoin is presently inferred from title presence, audio activity, idle thresholds, and recovery grace periods. It is not yet driven by provider-specific authoritative call-state observations.

### Key Phase 2 gaps

1. Broad title regexes can produce false positives or miss localized/version-specific titles.
2. Zoom, Teams, and Webex lack reliable durable meeting IDs when their window titles do not expose one.
3. A generic process/window signal cannot reliably distinguish a background live meeting from a closed/ended meeting.
4. Multiple browser windows can be enumerated, but simultaneous meeting detection/capture is constrained by the single `currentCapture` model.
5. Automatic naming relies heavily on the detected title and can remain generic when providers expose no title ID.

## Proposed implementation sequence

### 2.1 Unified meeting-observation contract

Introduce a provider-neutral observation model, for example:

- `provider`: `google_meet | zoom | teams | webex`
- `source`: `browser_window | native_window | provider_integration`
- `meeting_id`: optional stable provider ID
- `process_id` and window identity: diagnostic/continuity metadata, never sole meeting identity
- `state`: `candidate | joining | active | background | left | ended | unknown`
- `confidence`: `high | medium | low`
- `observed_at`, display title, and evidence/source fields

Keep detection separate from capture policy and database session reconciliation.

### 2.2 Provider-specific detectors

Implement separate detector modules with fixture-driven tests for:

- Google Meet: call-code extraction, title variants, tab/window changes, waiting room, leave/end surfaces, and rejoin.
- Zoom: native process/window variants, meeting versus home/chat/settings windows, call identity availability, leave/end surfaces.
- Microsoft Teams: meeting/call versus chat/activity windows, process variants, title changes, leave/end states.
- Webex: meeting/call versus home/chat/calendar windows, process variants, title changes, leave/end states.

Keep title heuristics as evidence, but attach confidence and avoid treating a PID or generic title as a durable ID.

### 2.3 Meeting lifecycle state machine

Model explicit transitions rather than inferring everything from one missing-window timer:

`candidate -> joining -> active -> background/unverified -> left -> ended`

Support `rejoining -> active` with exact identity reuse. Temporary focus/tab changes must not become leave events. Unknown state must fail safely and must not silently merge different calls.

### 2.4 Multi-window and multiple-meeting registry

Replace the single global detection decision with a registry of observed meeting candidates keyed by provider identity when available. Track each window/process association and transition independently. Preserve the current one-capture limitation until Phase 3 provides isolated per-tab/per-app audio streams; do not pretend simultaneous capture is solved by detection alone.

### 2.5 Validation matrix

Build fixture and Windows manual tests for each provider:

- Application launch without a meeting (false-positive rejection).
- Join/waiting room/active call.
- Minimize and switch applications.
- Switch browser tabs and browser windows.
- Open a second meeting in the same browser/process.
- Leave/end the call while the app remains open.
- Rejoin the same call inside/outside the recovery window.
- Close the application and restart Contexa while the call remains open.
- Multiple simultaneous candidates and deterministic selection/reporting.

Record detection latency, false starts, missed starts, identity stability, and end/leave classification.

## Scope boundary with Phase 3

Phase 2 improves meeting identity and lifecycle detection using desktop/provider observations. It does not claim exact per-tab audio isolation. The Chrome extension and native messaging integration, meeting-tab audio capture, and robust per-meeting simultaneous audio streams remain Phase 3 work. The browser-process continuity fallback should remain explicitly marked as lower-confidence until that integration exists.

## Phase 2 completion criterion

Contexa identifies supported meetings consistently, distinguishes ordinary app/browser windows from meetings, preserves identity across leave/rejoin and window changes, avoids duplicate sessions, and reports ambiguous/simultaneous meetings safely. Audio isolation is evaluated separately under Phase 3.

## Phase 2.1 implementation status

Implemented in this working snapshot:

- Added `desktop/meeting-observation.mjs` as the shared provider-neutral observation contract.
- Normalized supported windows into provider/source, provider meeting ID, session identity key, durable-identity flag, process/window IDs, observation state, confidence, timestamp, focus metadata, and evidence.
- Preserved Phase 1 compatibility aliases so current session/capture helpers are unchanged.
- Added HWND identity to the Windows `EnumWindows` snapshot.
- Added provider-aware detection logs without logging ordinary non-meeting window titles.
- Added fixture tests for Google Meet, Zoom, Teams, Webex, browser/native sources, title states, confidence, stable IDs and HWND propagation.

Phase 2.1 is integrated into the live Electron monitoring path. The new observations now supply the detector loop, while compatibility aliases preserve the tested Phase 1 identity/capture behavior.

### Phase 2.2 initial provider-adapter baseline

Implemented in this working snapshot:

- Added provider-specific adapters for Google Meet, Zoom, Microsoft Teams, and Webex under `desktop/providers/`.
- Routed both `capture-policy.mjs` and `meeting-observation.mjs` through the same adapter registry, removing duplicate provider-recognition rules.
- Added positive and negative fixtures for browser and native windows, plus rejection cases for home, settings, chat, activity, calendar, and unrelated windows.
- Distinguished explicit `left` title evidence from explicit `ended` title evidence. `active` means Contexa has an existing capture associated with the currently observed identity; it is not provider-authoritative call state.
- At the initial provider-adapter baseline, desktop validation had 103 passing tests; the later refinement now raises the suite to 133.

The next refinement is to collect fixture titles from actual installed Zoom, Teams, and Webex clients on Windows, improve provider-specific leave/end evidence, and then move to the independent lifecycle registry. Do not interpret the current title rules as authoritative provider call-state detection.

## Phase 2.2 refinement status — fixture-complete, live validation pending

The provider adapters have been tightened beyond the initial baseline:

- Provider matches now emit confidence and evidence, and the shared observation contract preserves those fields.
- Google Meet permission prompts are excluded without suppressing waiting-room or call-code titles.
- Zoom recognizes native/browser meeting, call, and webinar surfaces while rejecting ordinary app areas.
- Microsoft Teams recognizes the current `ms-teams.exe` family, classic Teams, browser meetings, and explicit call-state titles. Generic calendar/chat/schedule text no longer qualifies.
- Webex recognizes the documented Windows host and join-helper executable families, but the process name alone never starts capture.
- Joining, left, and ended title patterns are preserved as explicit lifecycle evidence.

Validation in the reconstructed working tree: desktop syntax checks pass; 133 desktop tests pass. Google Meet and Zoom have passed live Windows tests. Teams and Webex remain unverified on the user's installed clients; Phase 2.2 stays open until those live tests pass.
