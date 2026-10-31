# Structured meeting memory

## How it works

1. Deepgram Nova-3 Multi streams interim and finalized transcript segments to the browser and backend.
2. Final transcript segments are saved to PostgreSQL before memory processing.
3. Live recording/transcription never triggers Groq calls per segment. By default, Contexa extracts structured memory once after the meeting ends, using the saved transcript in chunks of up to 30 segments with a 4-segment overlap. The Memory panel can still trigger an early manual extraction; the provider key is never placed in frontend code. Set `MEMORY_AUTO_EXTRACT_ON_END=false` for manual-only mode. The legacy `MEMORY_AUTO_EXTRACT` flag no longer enables live extraction.
4. A schema-constrained model extracts topics, facts, entities, proposals, arguments, questions, open questions, decisions, action items, events, and explicitly named people.
5. Each candidate must cite supplied transcript segment IDs and a verbatim evidence quote. Candidates whose provenance is invalid are not persisted.
6. Candidates are upserted by meeting, category, and normalized title. Repeated items merge their source segment IDs and time ranges.
7. Saved items are sent to the frontend and are also available through REST.

## Configuration

Preferred configuration for Groq is in the repository-root `.env` file:

```dotenv
GROQ_API_KEY=your_groq_api_key
GROQ_BASE_URL=https://api.groq.com/openai/v1
MEMORY_MODEL=openai/gpt-oss-120b
MEMORY_AUTO_EXTRACT_ON_END=true
MEMORY_AUTO_EXTRACT=false  # legacy: no live extraction
```

The previous patch's `XAI_API_KEY` and `XAI_BASE_URL` names remain supported for compatibility. If you keep using those names with a Groq key, set `XAI_BASE_URL=https://api.groq.com/openai/v1` and choose a Groq model such as `openai/gpt-oss-120b`. Groq's OpenAI-compatible endpoint has been confirmed to return HTTP 200 in the user's supplied log; the reported failure happened afterward during database persistence, not at API authentication.

This is separate from `DEEPGRAM_API_KEY`, which is used for speech-to-text. The Groq API is usage-based and a key does not imply unlimited free API calls; check your Groq account's current free/developer tier and rate limits before processing long meetings.

For multilingual transcription, set:

```dotenv
DEEPGRAM_MODEL=nova-3
DEEPGRAM_LANGUAGE=multi
# Optional hints; blank means no language bias
DEEPGRAM_LANGUAGE_HINTS=en,hi
```

The hints only bias language detection and do not restrict the model to those languages. Leave the hint blank for unattended multi-language auto-detection.

## Database schema readiness

Automatic extraction is disabled if `memory_items` is missing. This prevents Contexa from sending transcript batches to Groq that it cannot save. The memory status endpoint reports this separately from provider configuration and gives a migration instruction.

From `backend/`, first inspect the current revision:

```powershell
python -m alembic current
```

If the database is already at `20261029_0002` or `20261029_0003`, apply pending migrations:

```powershell
python -m alembic upgrade head
```

If no revision is shown but `meetings` and `transcript_segments` already exist, follow the **Existing local database migration note** in the repository-root README. Do not stamp a fresh database, and do not drop your Postgres volume or delete meeting data. The current table-missing error is fixed by applying the existing `20261029_0003_create_memory_items` and `20261029_0004_add_decision_state` migrations to the correct database.

## API endpoints

- `GET /api/memory/status` reports provider configuration and whether the schema is ready.
- `GET /api/meetings/{meeting_id}/memory` returns saved items for one meeting.
- `GET /api/meetings/{meeting_id}/memory?item_type=decision` filters by category.
- `POST /api/meetings/{meeting_id}/memory/extract` explicitly extracts memory from an existing saved transcript, in bounded overlapping chunks.

## Memory types and decision progression

The project specification includes `TRANSCRIPT`, `FACT`, `TOPIC`, `ENTITY`, `PROPOSAL`, `ARGUMENT`, `QUESTION`, `OPEN_QUESTION`, `DECISION`, `ACTION_ITEM`, and `EVENT`. Literal transcript stays in `transcript_segments`; derived memory item types are `fact`, `topic`, `entity`, `proposal`, `argument`, `question`, `open_question`, `decision`, `action_item`, `event`, and `person`.

Decision records have a separate `decision_state`: `proposed` → `discussing` → `tentative` → `decided`. State only advances when supported by evidence and never regresses because a stale extraction is processed. The model is instructed to preserve the original language of transcript evidence in memory titles/content rather than translating everything to English.

## Limitations

- Extracted candidates can be wrong or incomplete; source quotes and timestamps make them auditable but do not guarantee correctness.
- Memory extraction runs after the meeting ends by default. There are no per-segment Groq calls while the meeting is live. A short meeting typically needs one request; very long meetings are processed in bounded overlapping chunks.
- Grounded Q&A, vector-similarity retrieval, and generated catch-up narratives are not implemented by this milestone.
