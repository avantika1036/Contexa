# Contexa Meeting Overview UI Patch

This is an incremental frontend-only patch for the cleaned Contexa Desktop project.

## Changes
- Adds a compact data-backed Meeting at a glance dashboard.
- Shows real transcript duration, identifiable speaker count, saved transcript segment count, and memory item count.
- Adds meeting highlights plus decisions, action items, topics and open questions.
- Lets a user jump from a highlight/list item to its supporting transcript segment.
- Makes the New meeting form appear only when requested from the sidebar (or when there are no saved meetings).
- Keeps advanced audio diagnostics collapsed below the overview.
- Uses already-saved transcript and memory data only; it does not add any Groq/API calls.

## Apply
Close Contexa completely. Extract the ZIP over the project root `C:\Work\Contexa` and allow these two files to be overwritten:
- `frontend/src/App.tsx`
- `frontend/src/App.css`

Then from PowerShell:

```powershell
Set-Location C:\Work\Contexa\frontend
npm run build
npm run lint
```

Restart Contexa after the build completes. No backend, `.env`, migration, or database changes are required.

## Validation notes
- TypeScript/JSX syntax transpilation: passed.
- CSS stylesheet parsing: passed if reported by the build log accompanying this patch.
- Full Vite production build and ESLint could not be run in the packaging environment because the source workspace's `node_modules` was incomplete (`vite/client`, Node types and ESLint were missing). Run the commands above on the Windows development machine before committing.
