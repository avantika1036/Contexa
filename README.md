# Webex idle-window false-positive correction

Apply this small prerequisite before the Phase 2.3 lifecycle patch unless your current checkout already contains this exact change.

The user's Webex desktop keeps a generic `Webex` title while idle and during a meeting. The native adapter must not fall back to title-only detection when UI Automation is unavailable. Active native meeting detection continues to use the verified Webex desktop UI Automation controls; explicit native meeting-title and browser rules remain in place.

Run `npm run check` and `npm test` from `desktop` after applying this file.
