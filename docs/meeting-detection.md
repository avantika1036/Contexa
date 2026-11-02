# Meeting detection architecture

## Phase 2.1 — Unified meeting-observation contract

Contexa now converts the existing supported-window detector results into a provider-neutral `MeetingObservation` object in `desktop/meeting-observation.mjs`.

Each observation contains:

| Field | Meaning |
|---|---|
| `provider` | `google_meet`, `zoom`, `teams`, or `webex` |
| `source` | `browser_window` or `native_window` |
| `meetingId` | Provider ID extracted only when explicit evidence exists; otherwise `null` |
| `identityKey` | Existing Phase 1 session identity key |
| `durableIdentity` | Whether the identity is safe for backend deduplication/recovery |
| `processId`, `processName` | Process continuity and diagnostics metadata |
| `windowId` | Windows HWND identity when supplied by `EnumWindows` |
| `state` | Conservative observation state (`candidate`, `joining`, `background`, `ended`) |
| `confidence` | `high`, `medium`, or `low` based on identity evidence |
| `observedAt` | Timestamp of the scan |
| `displayTitle` | Window title used by the provider detector |
| `windowFocus` | `foreground` or `background`; this is not call-state proof |
| `evidence` | Machine-readable provider/process/ID/focus evidence |

### State interpretation

- `candidate`: a supported meeting-like window has been identified, but the title alone does not prove the provider call is active.
- `joining`: visible title evidence suggests a waiting room or joining flow.
- `background`: the meeting-like window is not foreground. This is a focus observation, **not** proof that the meeting is still live.
- `ended`: the title explicitly contains a leave/end phrase. Provider adapters in Phase 2.2 will strengthen this signal.
- `active`, `left`, and `unknown` are reserved contract states for later provider call-state sources; this phase does not infer them from a window title.

### Confidence interpretation

- `high`: a stable provider meeting ID is present (for example, a Google Meet call code or explicitly labelled numeric meeting ID).
- `medium`: provider-specific native process or meeting-title evidence exists, but no durable meeting ID is exposed.
- `low`: reserved for weak or indirect provider evidence. Current supported-window filters reject most weak cases before observation creation.

### Compatibility with Phase 1

The observation also retains `pid`, `title`, and `foreground` aliases. The existing `meetingKey`, `classifyWindowTransition`, `SessionContinuity`, `selectStartCandidate`, and capture lifecycle continue to consume those aliases. This avoids changing session identity or capture behavior while the common contract is introduced.

The Windows enumerator now includes the HWND (`windowId`) in addition to PID, process name, title, and foreground status. Ordinary non-meeting window titles are not logged. Detector logs use provider, normalized identity, confidence, focus, PID and HWND.

## Current limitations — intentionally deferred to Phase 2.2/2.3

- Provider identification still relies on current process/title heuristics. Fixture-backed provider adapters are the next implementation step.
- A title-derived `candidate` or `background` observation cannot authoritatively prove a live call, leave, or end event.
- Numeric Zoom/Teams/Webex IDs are considered durable only when explicitly labelled in the title. No undocumented window-title numbers are treated as IDs.
- The desktop still has one `currentCapture`. Multiple simultaneous candidate observations can be represented and reported, but isolated simultaneous capture is not implemented here; that requires Phase 3 audio streams.
- Browser-process continuity remains a lower-confidence Phase 1 fallback until Phase 3 browser-extension/native-messaging integration supplies tab-level evidence.

## Tests

`desktop/test/meeting-observation.test.mjs` covers all four provider mappings, browser/native source classification, explicit and provisional identities, conservative state inference, confidence, HWND propagation, and compatibility aliases.
