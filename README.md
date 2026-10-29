# Contexa

A real-time AI copilot that builds structured meeting memory to help participants recover context, track decisions, and get grounded answers during live discussions.

## Current development status

- React + TypeScript meeting workspace
- FastAPI backend with WebSocket support
- PostgreSQL + pgvector configured through Docker Compose
- Persisted meeting sessions with unique IDs, statuses, and start/end timestamps
- Browser audio capture streamed to the selected session's WebSocket
- Streaming transcription, structured meeting memory, and grounded answers are upcoming milestones

## Local development

Run commands from the repository root unless a section says otherwise.

### 1. Start PostgreSQL

```powershell
docker compose up -d postgres
```

### 2. Install backend dependencies and apply database migrations

```powershell
Set-Location backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
alembic upgrade head
```

If the virtual environment already exists, activate it instead of creating it again.

### 3. Run the backend

From `backend/` with its virtual environment active:

```powershell
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

API docs: http://127.0.0.1:8000/docs

### 4. Run the frontend

In a separate terminal:

```powershell
Set-Location frontend
npm install
npm run dev -- --host 127.0.0.1
```

Open http://127.0.0.1:5173/.

### 5. Run backend tests

From `backend/` with the virtual environment active:

```powershell
python -m pytest tests -q
```

Tests use an isolated in-memory SQLite database; they do not write test meeting records to your development PostgreSQL database.

## Audio capture behavior

Audio capture requires explicit user confirmation and browser permission. Browser-tab audio depends on browser/source support and the audio-sharing option selected in the browser picker. Microphone-only capture is available as a fallback. Audio chunks are currently acknowledged by the backend but are not transcribed or persisted yet.

## Security

- Keep `.env` and all credentials out of Git.
- Do not expose the development backend publicly; authentication and authorization are not implemented yet.
- Only capture a meeting when you have appropriate consent and permission.


## Audio Capture Troubleshooting

See [docs/audio-capture-troubleshooting.md](docs/audio-capture-troubleshooting.md) for microphone permissions, browser tab audio, and server-side diagnostics.


## Real-time transcription (Deepgram)

Contexa supports streaming speech-to-text through Deepgram. Copy `.env.example` to the repository-root `.env` only if you do not already have a `.env` file, then set `DEEPGRAM_API_KEY` to a valid key from the [Deepgram Console](https://console.deepgram.com/). Preserve your existing database settings. A provider account/key may be subject to the provider’s current usage limits and pricing. Never commit `.env` or share the key. Restart FastAPI after changing it.

Apply database changes from `backend/` with `python -m alembic upgrade head`. The live transcript endpoint persists finalized transcript segments and exposes them at `/api/meetings/{meeting_id}/transcript`. Interim results are transient. Audio chunks themselves are not stored by Contexa.
