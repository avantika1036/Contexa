# Repository cleanup report

This source bundle has been consolidated around one Windows desktop application.

## Removed from the source tree

- Nested `others.zip`, `frontend/frontend.zip`, and `backend/backend.zip` archives that duplicated source, held stale build outputs/backups, and made the repository harder to navigate.
- Stale patch/install note files left by the incremental patch process.
- The unused generated Vite/React logos and unused hero image from the starter frontend.
- Empty `.gitkeep` placeholders, which are not needed for tracked source files.
- Local caches, bytecode, test databases, `node_modules`, build output, `.env`, and Git metadata from the delivered source archive.

## Kept

- FastAPI backend, transcription WebSocket, structured-memory pipeline, ORM models, Alembic migrations, and backend tests.
- React/TypeScript UI and its Vite build setup, redesigned into the primary Contexa workspace.
- Electron main process, a constrained preload bridge, a loopback-only UI server, and system-tray controls.
- Docker Compose database configuration and the non-secret `.env.example`.

## Application launch

- First setup: `Start-Contexa.ps1` installs missing dependencies, builds the UI and launches Electron.
- Normal launch after setup: `Open-Contexa.vbs` starts the already-installed Electron app without a visible console.
- The React UI loads inside Electron's `BrowserWindow`; it does not open an external browser window by default.

## Verification boundary

Backend tests and desktop UI-server tests pass in the build environment. Windows process-loopback capture, actual Electron rendering, and the full Vite production build still need verification on a Windows machine because native audio and Electron dependencies are platform-specific and package-registry access was unavailable during this cleanup.
