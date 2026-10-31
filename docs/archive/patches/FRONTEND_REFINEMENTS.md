# Contexa dashboard & Meeting Context refinement

This is a small frontend-only overlay patch. It changes:

- Restores the Speakers metric alongside Duration, Transcript and Memory. Speaker counts use source channels where present and otherwise diarized speaker IDs; unknown IDs are not counted.
- Removes repeated helper copy from the Meeting context header and Ask Contexa heading. The actionable prompt suggestions remain inside Ask Contexa.
- Hides the horizontal tab-strip scrollbar while preserving horizontal navigation if the window becomes too narrow.
- Adds very light green and warm amber fills to Decisions and Action items cards, without colored left borders.

## Apply

Close Contexa first. Extract this ZIP over the project root `C:\Work\Contexa`, preserving paths. Then run from PowerShell:

```powershell
Set-Location C:\Work\Contexa\frontend
npm run build
npm run lint
```

Only `frontend/src/App.tsx` and `frontend/src/App.css` are included. No API keys, backend files, database schema or migrations are changed.
