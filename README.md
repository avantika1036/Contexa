# Contexa

Contexa is a real-time meeting context copilot. It listens to a meeting you are in, keeps a
structured, timestamped memory of what was said, and lets you ask questions grounded in that
record, so you can recover context when your attention drifts.

> **Status: working MVP foundation (Windows only).** Capture, transcription, structured memory
> and grounded Q&A work. Live (mid-meeting) memory, time-range *Catch me up*, *I'm lost*,
> semantic search and contradiction handling are in progress. See [Roadmap](#roadmap).

## What works today

| Area | Status |
|---|---|
| Meeting detection (Zoom, Teams, Webex, browser meetings) | Best-effort process/window heuristics; platform-specific call-state integrations remain future work |
| Audio: meeting app audio + your microphone on separate channels | Implemented; verify against actual Windows meeting devices |
| Streaming transcription (Deepgram Nova-3, multilingual) | Implemented; real-device latency/accuracy validation ongoing |
| Speaker labels per transcript segment | Working (`Speaker N`; no real names yet) |
| Session deduplication | Database-backed for explicit stable IDs; heuristic/best-effort for generic native titles (see [session lifecycle](docs/session-lifecycle.md)) |
| Structured memory (facts, proposals, arguments, decisions, questions, action items) | Working, **runs after the meeting ends** |
| Decision lifecycle (proposed → discussing → tentative → decided) | Working; never regresses |
| Ask Contexa (meeting-only or meeting + general context, with validated evidence quotes) | Working |
| Live memory, Catch me up (time range), I'm lost, "already discussed?" | Not yet |
| Embedding / semantic search (pgvector is installed but unused) | Not yet |
| Authentication, retention settings | Not yet (run locally only) |

## Architecture

Electron desktop app (system tray, local React UI) → FastAPI backend (WebSocket for audio and
live transcript) → PostgreSQL + pgvector. Deepgram handles speech-to-text; Groq's
OpenAI-compatible API handles memory extraction and Q&A. Raw audio is streamed for
transcription and is **never stored**.

See [docs/architecture.md](docs/architecture.md) for details.

## Setup (Windows 10/11)

Prerequisites: Python 3.11+, Node.js LTS, Docker Desktop.

1. Copy `.env.example` to `.env` and fill in `POSTGRES_PASSWORD`, `DATABASE_URL`,
   `DEEPGRAM_API_KEY` and `GROQ_API_KEY`. Never commit `.env`.
2. Run `Start-Contexa.ps1` once. It creates the Python virtual environment, installs
   dependencies, builds the UI and launches the desktop app.
3. Database migrations are applied automatically when the desktop app starts its local
   services. To check or apply them manually (for example after a failure), run:

   ```powershell
   Set-Location .\backend
   .\run_migrations.ps1
   ```

4. Afterwards, start Contexa with `Open-Contexa.vbs` or the desktop shortcut.

## Everyday use

On first launch Contexa asks for recording consent once. After you accept, **Auto Capture is on
by default at every launch**. You can pause it from the tray menu or the sidebar; a pause is
remembered across restarts until you turn it back on. When a supported
meeting window is detected, Contexa captures that application's audio plus your microphone
and shows the live transcript. Open a meeting in the sidebar to see its memory, decisions and
the **Ask** tab.

## Development

```powershell
# Backend tests (uses an in-memory SQLite database; never calls Groq or Deepgram)
Set-Location .\backend
$env:DATABASE_URL = "sqlite+pysqlite:///:memory:"
python -m pytest -q

# Desktop tests and syntax check
Set-Location ..\desktop
npm run check
npm test

# Frontend
Set-Location ..\frontend
npm run build
npm run lint
```

## Privacy

- Capture starts only after explicit consent in the app, and only while a recognized meeting
  window is open.
- Raw audio is not saved. Finalized transcript text and extracted memory are stored in your
  local PostgreSQL database.
- Transcript text is sent to Groq when memory extraction or Ask Contexa runs, and audio is
  sent to Deepgram for transcription.
- Browser meetings are captured by browser process, so other audible tabs in the same browser
  may be included. Prefer the native Zoom/Teams apps, or close other audio tabs, when this
  matters.
- Delete a meeting with `DELETE /api/meetings/{id}`. There is no authentication yet, so keep
  the backend on localhost.

## Known limitations

- Detection relies on window titles and process names, so unusual or localized titles can be
  missed or misdetected. Explicit meeting IDs receive database-backed deduplication; generic
  native meeting titles remain best-effort until client-specific meeting-state integration exists.
- Speaker labels come from Deepgram diarization and are approximate on mixed audio. Names are
  not inferred.
- Memory extraction can be wrong or incomplete; every item keeps its evidence quote and
  timestamp so it can be checked.

## Roadmap

1. Session identity and duplicate prevention (implemented for stable IDs; Windows validation outstanding)
2. Meeting-aware detection and meeting-specific browser audio
3. Reliable audio capture and speaker attribution under real Windows meeting conditions
4. Live incremental memory with a durable job queue and per-meeting request/token budgets
5. Catch me up (time range), I'm lost, "was this already discussed?"
6. Semantic search (pgvector), contradiction handling, speaker names
7. Evaluation set, delete/retention controls, authentication, installer

## Documentation

- [Architecture](docs/architecture.md)
- [Session lifecycle](docs/session-lifecycle.md)
- [Transcription settings and provider choice](docs/transcription.md)
- [Structured memory](docs/structured-memory.md)
- [Ask Contexa](docs/meeting-qa.md)
- [Audio capture troubleshooting](docs/audio-capture-troubleshooting.md)
- Older patch notes: `docs/archive/patches/` (historical, not current instructions)
