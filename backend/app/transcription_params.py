"""Deepgram request options derived from settings (kept separate so they can be unit tested)."""
from __future__ import annotations

# Deepgram allows 500 tokens of keyterms per stream; Deepgram recommends staying well under it
# and focusing on the most important 20-50 terms.
MAX_KEYTERMS = 50
MAX_KEYTERM_LENGTH = 60


def parse_keyterms(raw: str | None) -> list[str]:
    """Split a comma-separated setting into clean, de-duplicated terms (order preserved)."""
    if not raw:
        return []
    seen: set[str] = set()
    terms: list[str] = []
    for part in raw.split(","):
        term = " ".join(part.split())[:MAX_KEYTERM_LENGTH]
        if term and term.lower() not in seen:
            seen.add(term.lower())
            terms.append(term)
    return terms[:MAX_KEYTERMS]


def keyterm_params(model: str, keyterms: list[str]) -> list[tuple[str, str]]:
    """Keyterm prompting is a Nova-3 feature; other models would reject the parameter."""
    if not keyterms or not model.strip().lower().startswith("nova-3"):
        return []
    return [("keyterm", term) for term in keyterms]


def language_warning(language: str, hints: list[str]) -> str | None:
    if language.strip().lower() == "multi" and not hints:
        return (
            "DEEPGRAM_LANGUAGE=multi without DEEPGRAM_LANGUAGE_HINTS lets Deepgram auto-detect the "
            "language from the audio. Accented English can then be transcribed in another language or "
            "script. Set DEEPGRAM_LANGUAGE_HINTS (for example 'en' or 'en,hi'), or use DEEPGRAM_LANGUAGE=en "
            "for English-only meetings."
        )
    return None
