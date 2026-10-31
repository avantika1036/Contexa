# Contexa UI refresh

This patch replaces only:
- `frontend/src/App.tsx`
- `frontend/src/App.css`

It also adds `Apply-Contexa-UI-Refresh.ps1` to build the updated interface.

## What changed
- Meeting history is selectable directly in the sidebar.
- The main view keeps only the meeting title/status, a compact new-meeting form, and collapsed audio diagnostics (desktop mode).
- Removed the large blue decorative hero, repeated privacy/features panels, placeholder Q&A panel, and duplicated explanatory copy.
- Removed the decorative dot on the C brand mark.
- The top status now checks FastAPI `/health` independently of whether the selected meeting is active; a completed meeting is labeled `Saved` rather than `Offline`.
- Kept the existing transcript, memory tabs, meeting creation, session selection, and Auto Capture controls.

## Apply
Extract the ZIP into `C:\Work\Contexa` with overwrite enabled, then run:
```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\Apply-Contexa-UI-Refresh.ps1
```
After a successful build, quit Contexa fully (including the tray icon) and reopen it. No database migration is needed.
