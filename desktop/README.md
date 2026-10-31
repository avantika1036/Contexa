# Contexa Desktop

This folder contains the Electron main process and Windows setup script for the Contexa desktop application. The React UI runs **inside the Electron window**, not in an external browser.

## Launch

From the repository root, run `Start-Contexa.ps1`. The setup checks local prerequisites, installs missing dependencies, builds the React UI, verifies Electron's Windows binary, creates a `Contexa` desktop shortcut when possible, and launches the desktop window. After setup, open Contexa from the shortcut or `Open-Contexa.vbs`.

The window can be hidden to the system tray by closing it. Use the in-window Auto Capture control or tray menu to pause/resume capture; the tray can also reopen Contexa or quit completely. Auto Capture remains off unless the user opts in through the consent prompt.

## Desktop UI architecture

By default Electron serves `frontend/dist/` on `127.0.0.1:4173` from a loopback-only server in the main process and loads it in a `BrowserWindow`. `?desktop=1` lets the React UI adapt its guidance for desktop operation. Set `CONTEXA_DEV_UI=true` only when intentionally loading the Vite development server inside Electron.

## Audio

While consented Auto Capture is enabled, the desktop app detects supported meeting-window titles, captures the matching process's loopback audio and the local microphone, and places them on separate stereo channels before streaming to FastAPI/Deepgram. Raw audio is not saved. Process capture may include other browser tabs from the same browser process. The two channels separate local microphone from application playback, but remote participants remain mixed together and speaker diarization is approximate.

Stable external call IDs (such as a Google Meet code visible in the title) use the database-backed `POST /api/meetings/auto` endpoint and a partial unique index. Process IDs alone are not treated as meeting identities. Generic native titles still have a best-effort continuity fallback; see `docs/session-lifecycle.md`.

## Prerequisites

- Windows 10/11
- Python 3.11+
- Node.js/npm
- Docker Desktop / Docker Compose for local PostgreSQL
- Repository-root `.env` with database and provider credentials

The desktop app runs `alembic upgrade head` when it starts its local services (additive migrations only). Back up important data before upgrading; `backend/run_migrations.ps1` can be used to check or apply migrations manually.
