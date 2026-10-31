# Contexa — Architecture

## Objective

Build a real-time AI meeting copilot that maintains structured, time-aware meeting memory for context recovery and grounded Q&A.

## Current session lifecycle

See `docs/session-lifecycle.md` for how one real meeting maps to one session (deferred end, resume, cleanup).

1. Manual sessions use `POST /api/meetings`. Automatic capture uses `POST /api/meetings/auto`
   when the detector has an explicit stable meeting ID; otherwise it uses the best-effort local
   continuity path.
2. Store a unique meeting ID, title, status, optional audio source and (when available) stable
   external capture key in PostgreSQL. A partial unique index prevents duplicate active sessions
   for the same stable key.
3. Connect the client to `/ws/meeting/{meeting_id}` for an active session.
4. Capture only after explicit user consent. Electron detects supported Windows meeting windows and streams process-loopback audio plus the microphone on separate stereo channels. The current native path is process-scoped, not yet browser-tab-specific; see the session lifecycle and audio troubleshooting docs for limitations.
5. Stream audio chunks to the selected meeting's WebSocket.
6. Stop capture and end the session through `POST /api/meetings/{meeting_id}/end`.
7. Retrieve prior session records from `GET /api/meetings`.

## End-to-end workflow

1. After the user grants consent and enables Auto Capture, Electron detects supported meeting windows. The current Windows desktop path captures process-loopback meeting audio and the physical microphone on separate stereo channels. The optional browser fallback still depends on browser sharing permissions and is not the meeting-specific extension path planned for a later phase.
2. Stream captured audio to Deepgram for real-time speech-to-text. Multilingual mode uses Deepgram Nova-3 Multi (`DEEPGRAM_LANGUAGE=multi`) and optional language hints.
3. Persist finalized transcript segments with timestamps, confidence, word timing, and available speaker IDs.
4. At present, structured-memory extraction runs after a meeting ends through the Groq-compatible
   API when `GROQ_API_KEY` is configured and the `memory_items` table exists. Live incremental
   extraction with durable jobs and cost budgets is a later milestone.
5. Persist memory items with evidence quotes, source segment IDs, timestamps, related entities, and deduplication metadata.
6. Ask Contexa retrieves relevant transcript segments (keyword match plus recent context) and saved memory, and returns a grounded answer with validated evidence quotes (`docs/meeting-qa.md`).
7. Next: live incremental memory, a time-range catch-up narrative, "I'm lost", semantic retrieval and contradiction handling.

## Technology stack

- Frontend: React + TypeScript
- Backend: Python + FastAPI
- Live communication: WebSockets
- Database: PostgreSQL + pgvector
- Schema migrations: Alembic
- Speech-to-text: Deepgram streaming Listen API
- Structured extraction: Groq OpenAI-compatible API using a configured model such as `openai/gpt-oss-120b`
- Transcription continues without Groq; structured-memory extraction requires Groq API configuration and a migrated database schema

## MVP priorities

- Timestamped, traceable meeting context
- Grounded answers with supporting evidence
- Transparent handling of missing information
- Recording consent and secure data handling
- Separate session IDs so meeting data does not get mixed across meetings

## Current limitations

Raw audio is not stored by Contexa. Interim transcript results are transient; finalized transcript segments are persisted. Structured-memory items may be incomplete or incorrect, so they retain source quotes and timestamps for review. Grounded Q&A is implemented, but retrieval is keyword-based (pgvector is installed but not yet used), and generated catch-up summaries and live memory are not implemented yet. Authentication and authorization are not implemented; keep the development server local. Browser per-window audio support varies; when the browser cannot expose the Zoom window output, a native helper using process-specific capture is needed for reliable meeting-only desktop audio.

Platform-specific meeting integrations and advanced multi-agent workflows are deferred until the core MVP works.

## Streaming transcription

The browser sends MediaRecorder WebM/Opus chunks to the Contexa WebSocket. FastAPI relays them to Deepgram's streaming Listen API. Interim results are sent to the UI but not persisted. Final segments are stored with start/end timestamps, confidence, word timestamps and speaker IDs when provided. Audio payloads are not persisted. The Deepgram API key is loaded from the repository-root `.env` and must never be sent to the browser or committed.

For multilingual speech, set `DEEPGRAM_LANGUAGE=multi`. Optional `DEEPGRAM_LANGUAGE_HINTS=en,hi` values bias detection toward those languages but do not restrict recognition to them. See [Deepgram's language prompting docs](https://developers.deepgram.com/docs/nova-3-language-prompting).

## Structured meeting memory

After the meeting ends, finalized transcript segments are processed in bounded overlapping batches when `GROQ_API_KEY` is configured and the `memory_items` table is available. This is batch processing over a saved transcript, not live mid-meeting extraction. The default compatible API endpoint is `https://api.groq.com/openai/v1`, and the recommended model configuration for this project is `openai/gpt-oss-120b`.

The extractor returns schema-constrained candidates in these categories:

- Topics and facts
- Proposals
- Supporting or opposing arguments
- Decisions
- Open questions
- Action items
- People and entities

Each persisted item includes a meeting ID, source transcript segment IDs, start/end timestamps, an evidence quote, related entities, and extraction metadata. The persistence layer verifies that the evidence quote occurs in the referenced transcript context and deduplicates items by meeting, category, and normalized title. The model is instructed to preserve the language(s) used in the transcript evidence rather than translating all items into English.

`GET /api/memory/status` separately reports whether the provider is configured and whether the `memory_items` schema exists. If migrations are missing, automatic extraction stays disabled and the UI displays migration guidance. The API key stays on the backend. Transcript text is sent to Groq for extraction when this feature is configured; raw audio is not stored.

Structured memory is not the same as a verified decision record: model-generated items must remain traceable to transcript evidence and should be reviewed when appropriate. Grounded question answering is implemented; live catch-up generation and live incremental memory are separate follow-up milestones.
