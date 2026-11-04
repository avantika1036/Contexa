
## Native process/window recovery key

For native Zoom, Teams and Webex windows without an explicit provider meeting ID, desktop capture supplies a separate backend `captureKey` in the form `provider:window:<pid>:<hwnd>`. This key is stable across a Contexa-only restart while the provider process/window remains open, even if the visible title changes from a descriptive value to a generic provider title. The semantic `sessionKey` remains separate for live lifecycle comparisons.
