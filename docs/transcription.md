# Transcription: configuration, accuracy and provider choice

## Language settings (Deepgram)

Contexa streams to Deepgram Nova-3. Set these in the repository-root `.env`, then restart Contexa.

| Your meetings | Use |
|---|---|
| English only (any accent) | `DEEPGRAM_LANGUAGE=en` |
| English mixed with Hindi (Hinglish) | `DEEPGRAM_LANGUAGE=multi` and `DEEPGRAM_LANGUAGE_HINTS=en,hi` |
| English plus another language you actually speak | `DEEPGRAM_LANGUAGE=multi` and hint only those languages |

**Why this matters.** `DEEPGRAM_LANGUAGE=multi` transcribes 55 languages, including Telugu, and
when no hints are given it auto-detects the language. Accented English can then be detected as
another language and written in that language's script (English words in Telugu script, for
example). Hints bias detection toward the languages you expect. Contexa logs a warning when
`multi` is used without hints. (A Windows terminal showing text like `α░╣α░╛α░»α▒ì` is Telugu
displayed with the wrong console encoding; the stored text is fine.)

## Names and terms

`DEEPGRAM_KEYTERMS=Avanti Kapadia,Contexa,Kubernetes` boosts recognition of names and jargon
(Nova-3 keyterm prompting). Use correct capitalization for proper nouns, keep to the 20-50 terms
that matter (Contexa caps the list at 50), and do not add very common words. Spellings must match
what you want to see in the transcript.

## Latency and audio loss

Delayed and incomplete transcripts had a cause inside Contexa: audio was pulled one 100 ms frame
per `setInterval` tick, and on Windows that tick really fires about every 109 ms. The microphone
backlog therefore grew about 9% faster than it was consumed, until the 3-second cap was hit,
after which audio was dropped. Capture now paces frames against a monotonic clock
(`desktop/frame-pacer.mjs`) and logs `mic_backlog_ms` and `mic_dropped_ms` in the
"Audio channel activity" line. Healthy values: backlog under about 300 ms and dropped 0 ms.

## Deepgram or Sarvam?

Checked against the providers' documentation in October 2026; these change, so recheck before
committing to a switch.

| Contexa needs | Deepgram Nova-3 | Sarvam Saaras |
|---|---|---|
| Streaming with speaker labels (diarization) | Yes (used today) | No. Diarization is batch-only; the streaming API returns none |
| Two-channel input (meeting audio + you) | Yes, multichannel | Realtime API is mono only (beta access required) |
| Word-level timestamps | Yes | Not supported (chunk-level only) |
| Streaming audio format | linear16 at the capture rate | PCM/WAV at 16 kHz or 8 kHz only |
| Indian languages | Hindi and Telugu among 55 via `multi`; `hi` as a monolingual model | 22 Indian languages plus English, with code-mixed output modes |
| Price | See Deepgram plan | Published at ₹30 per hour of audio (₹45 with diarization, batch) |

**Recommendation:** keep Deepgram as the main provider. Contexa's features (who proposed what,
separate "you" and remote channels, word-level evidence) depend on diarization and two channels,
which Sarvam's streaming API does not offer. Fix the language configuration first; that is the
cause of the wrong-script output. If, after that, transcription of Indian languages or heavy
code-mixing is still not good enough, add Sarvam as an optional provider for the **microphone
channel only** (you are one speaker, so diarization is not needed) and keep Deepgram for the
meeting-audio channel. Measure first: record the same 3-5 minute meeting segments and compare
word accuracy and delay for both before building a provider switch.
