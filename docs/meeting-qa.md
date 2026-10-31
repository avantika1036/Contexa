# Ask Contexa

The Meeting context panel includes **Ask Contexa**, the primary Q&A surface. It is available for active and saved meetings.

## Answer scopes

- **Meeting only**: answer using saved transcript segments and structured memory. If the record does not support an answer, say so. Evidence quotes are validated against the original transcript segment before being returned to the UI.
- **Meeting + general context**: provide the meeting-grounded answer first, then a separate general-knowledge explanation. The second section is explicitly labelled as model knowledge and is not a live web search.

## Usage and privacy

No provider request occurs while the user types. Each submitted question triggers at most one Groq request; conversational context is bounded to the latest six turns, and transcript context is selected from at most 36 relevant or evenly sampled segments. Up to 50 saved memory records are added as concise context. Meeting-only questions on meetings with no transcript or memory return a local explanation without calling Groq.

Answers can include source references. Only exact quotes found in the referenced transcript segment are returned as evidence; invalid source quotes are dropped. Click a source reference in the desktop UI to jump to its transcript segment.

The Q&A history currently lives in the active UI session, not as a separate persisted chat log. Transcript and structured-memory records remain the saved source of truth.

## API

`POST /api/meetings/{meeting_id}/ask`

Example body:

```json
{
  "question": "What did we decide about the database?",
  "scope": "meeting",
  "history": []
}
```

Use `scope: "broader"` to request a separate general-context explanation. Supported keys and provider configuration remain on the backend; never expose the Groq key in frontend code.
