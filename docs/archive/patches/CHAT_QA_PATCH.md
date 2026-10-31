# Contexa Ask & UI Icon Patch

This is an overlay patch for the existing cleaned Contexa project. It adds the **Ask Contexa** tab and the Groq-powered meeting Q&A endpoint, enlarges glyphs inside existing icon tiles, and retains the current workspace/tab/diagnostics layout.

## Apply

1. Quit Contexa from the tray and stop the backend process.
2. Extract this ZIP directly over `C:\Work\Contexa`, allowing changed files to be replaced.
3. In PowerShell, run:

```powershell
Set-Location C:\Work\Contexa\backend
.\.venv\Scripts\Activate.ps1
python -m pytest tests -q

Set-Location C:\Work\Contexa\frontend
npm run build
npm run lint
```

4. Relaunch `C:\Work\Contexa\Start-Contexa.ps1`.

No database migration is needed for Q&A. The API key remains in the repository-root `.env`; frontend code never receives it.

## Q&A behavior

- `Ask Contexa` is the first/default Meeting context tab.
- **Meeting only** answers from transcript and saved structured memory, with exact source quotes that can be clicked to open the transcript segment.
- **Meeting + general context** returns meeting-grounded findings first and labels general model knowledge separately. It does not perform live web search.
- No API call occurs while typing. A submitted question makes at most one Groq request. Meeting-only questions with no transcript/memory return a local message without a provider request.
- The transcript context is bounded to 36 selected segments; broad questions sample across the meeting. Up to 50 memory records and the latest six chat turns are included.
- Chat history is kept in the current UI session, not stored as a separate database log.
