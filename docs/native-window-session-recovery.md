# Native window session recovery

Native Zoom, Teams, and Webex windows may not expose a permanent provider meeting ID in their title. Contexa therefore maintains a semantic `sessionKey` for in-process lifecycle transitions and a separate durable `captureKey` for backend recovery. When a native meeting window has no explicit provider ID, the capture key is `provider:window:<pid>:<hwnd>`.

The backend reuses a suspended session only while it is inside the configured recovery grace. For a key already owned by an open session, a different descriptive title is not silently merged. Generic provider titles (for example `Zoom Meeting`) can match a previously descriptive title during a normal Contexa restart because the application may briefly replace its title while the call remains open.

This native window key assumes the provider process and HWND remain open while Contexa restarts. It is not a provider-level call ID and does not promise recovery if the meeting application itself exits and creates a new process/window.
