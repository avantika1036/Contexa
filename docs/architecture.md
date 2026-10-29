# Contexa — Architecture

## Objective

Build a real-time AI meeting copilot that maintains structured,
time-aware meeting memory for context recovery and grounded Q&A.

## Planned workflow

1. Capture audio in the browser.
2. Stream audio to a transcription service.
3. Maintain timestamped transcript segments.
4. Extract facts, proposals, arguments, decisions, questions,
   action items, people, and entities incrementally.
5. Persist structured memory and embeddings.
6. Retrieve relevant evidence for meeting questions.
7. Generate answers grounded in the meeting record.

## Technology stack

- Frontend: React + TypeScript
- Backend: Python + FastAPI
- Live communication: WebSockets
- Database: PostgreSQL + pgvector
- Speech-to-text: Streaming transcription provider
- AI: LLM provider integration

## MVP priorities

- Timestamped, traceable meeting context
- Grounded answers with supporting evidence
- Transparent handling of missing information
- Recording consent and secure data handling

Platform-specific meeting integrations and advanced
multi-agent workflows are deferred until the core MVP works.
