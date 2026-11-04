
## Windows focus resolution and Webex snapshot isolation

The Windows snapshot records the foreground root HWND and foreground process ID. The meeting selector uses an exact root-HWND match where possible; it falls back to the foreground PID only when there is exactly one top-level window and one supported meeting candidate for that process. Multiple browser windows that share a process must be resolved by HWND, not PID alone.

Basic window enumeration is independent from Webex UI Automation. A failure to inspect Webex accessibility controls must not make Google Meet, Zoom, Teams or browser windows disappear from the current detector poll.

### Webex same-process call transitions

If the verified Webex top-level window disappears completely, Contexa waits for a 20-second configurable grace before marking the current Webex call epoch ended. A brief HWND recreation gap keeps the original call identity. After sustained absence, the next verified meeting-control observation receives a new `-callN` identity and is captured as a separate meeting, even when CiscoCollabHost keeps the same PID.

