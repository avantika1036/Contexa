
## Native process/window recovery key

For native Zoom, Teams and Webex windows without an explicit provider meeting ID, desktop capture supplies a separate backend `captureKey` in the form `provider:window:<pid>:<hwnd>`. This key is stable across a Contexa-only restart while the provider process/window remains open, even if the visible title changes from a descriptive value to a generic provider title. The semantic `sessionKey` remains separate for live lifecycle comparisons.


### Webex desktop HWND recreation

For verified CiscoCollabHost Webex sessions, the first active HWND is retained as the canonical identity anchor while meeting-only UI Automation controls continue to be observed in the same host process. A replacement HWND therefore continues the current Contexa session instead of creating a duplicate. Two successful scans without the End meeting control mark the call terminal; the next positive call creates a new lifecycle epoch and unique recovery identity. PID changes are never merged.


## Webex desktop call identity across HWND replacement

Verified active Webex calls retain the first HWND as their canonical identity while the same CiscoCollabHost PID continues to expose meeting controls. A replacement HWND remains the same Contexa session. Two successful UIA scans without meeting controls end that call; the next positive call begins a new epoch and gets a distinct `-callN` identity. Missing window snapshots and UIA failures do not count as successful absence scans.
