# Phase 2.1 runtime import fix

The Phase 2.1 patch exported `normalizeMeetingWindows` from `desktop/capture-policy.mjs` and called it from `desktop/main.mjs`, but omitted it from the named import list. Node's syntax check and the isolated module tests did not catch this unresolved runtime binding, so the periodic monitor produced repeated `ReferenceError: normalizeMeetingWindows is not defined` unhandled promise rejections.

This correction:

- Adds `normalizeMeetingWindows` to the existing named import from `capture-policy.mjs`.
- Adds a catch around the periodic monitor cycle so future monitor errors are logged (deduplicated) instead of becoming unhandled promise rejections. The `finally` block still releases `monitorInFlight` and refreshes the tray menu.

Apply this patch before committing Phase 2.1. Then run `npm run check`, `npm test`, launch Contexa, and confirm the detector log appears without the ReferenceError.
