# Contexa — Architecture

## Objective

Build a real-time AI meeting copilot that maintains structured, time-aware meeting memory for context recovery and grounded Q&A.

## Current session lifecycle

1. Create a meeting session through `POST /api/meetings`.
2. Store a unique meeting ID, title, status, creation time, and optional audio source in PostgreSQL.
3. Connect the client to `/ws/meeting/{meeting_id}` for an active session.
4. Capture browser-tab audio or microphone audio after explicit user consent.
5. Stream binary audio chunks to the selected meeting's WebSocket.
6. Stop capture and end the session through `POST /api/meetings/{meeting_id}/end`.
7. Retrieve prior session records from `GET /api/meetings`.

## Planned end-to-end workflow

1. Capture audio in the browser.
2. Stream audio to a transcription service.
3. Maintain timestamped transcript segments.
4. Incrementally extract facts, proposals, arguments, decisions, questions, action items, people, and entities.
5. Persist structured memory and embeddings.
6. Retrieve relevant evidence for meeting questions.
7. Generate answers grounded in the meeting record.

## Technology stack

- Frontend: React + TypeScript
- Backend: Python + FastAPI
- Live communication: WebSockets
- Database: PostgreSQL + pgvector
- Schema migrations: Alembic
- Speech-to-text: Streaming transcription provider (not integrated yet)
- AI: LLM provider integration (not integrated yet)

## MVP priorities

- Timestamped, traceable meeting context
- Grounded answers with supporting evidence
- Transparent handling of missing information
- Recording consent and secure data handling
- Separate session IDs so meeting data does not get mixed across meetings

## Current limitations

Audio chunks are currently received and acknowledged by the WebSocket only; they are not transcribed or stored. Transcript, catch-up, current-topic, decisions, and question answering are not yet backed by AI output. Authentication and authorization are not implemented; keep the development server local.

Platform-specific meeting integrations and advanced multi-agent workflows are deferred until the core MVP works.


## Streaming transcription

The browser sends MediaRecorder WebM/Opus chunks to the Contexa WebSocket. FastAPI relays them to Deepgram's streaming Listen API. Interim results are sent to the UI but not persisted. Final segments are stored with start/end timestamps, confidence, word timestamps and speaker IDs when provided. Audio payloads are not persisted. The provider API key is loaded from the repository-root `.env` and must never be sent to the browser or committed.
