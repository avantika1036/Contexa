"""Split one finalized Deepgram result into continuous single-speaker runs.

Deepgram returns one transcript string per result, with a ``speaker`` label on every
word. If two people alternate inside the same result, labelling the whole result with
the first word's speaker misattributes the second person's words. This module splits
such results at speaker changes.

Diarization is noisy, especially on very short interjections, so a run shorter than
``min_run_words`` is merged into its neighbour instead of becoming its own segment.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

MIN_RUN_WORDS = 2


@dataclass
class SpeakerRun:
    speaker_id: int | None
    words: list[dict[str, Any]] = field(default_factory=list)

    @property
    def text(self) -> str:
        return " ".join(_word_text(word) for word in self.words).strip()

    @property
    def start(self) -> float | None:
        return _number(self.words[0].get("start")) if self.words else None

    @property
    def end(self) -> float | None:
        return _number(self.words[-1].get("end")) if self.words else None


def _word_text(word: dict[str, Any]) -> str:
    return str(word.get("punctuated_word") or word.get("word") or "").strip()


def _number(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _speaker(word: dict[str, Any]) -> int | None:
    value = word.get("speaker")
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def split_words_by_speaker(
    words: list[dict[str, Any]], *, min_run_words: int = MIN_RUN_WORDS
) -> list[SpeakerRun]:
    """Return ordered speaker runs. A result with one speaker returns one run."""
    usable = [word for word in words if isinstance(word, dict) and _word_text(word)]
    if not usable:
        return []

    runs: list[SpeakerRun] = []
    for word in usable:
        speaker = _speaker(word)
        if not runs:
            runs.append(SpeakerRun(speaker_id=speaker, words=[word]))
            continue
        current = runs[-1]
        if speaker is None:
            # An unlabelled word belongs to whoever was speaking.
            current.words.append(word)
        elif current.speaker_id is None:
            # The run started with unlabelled words; adopt the first real label.
            current.speaker_id = speaker
            current.words.append(word)
        elif speaker == current.speaker_id:
            current.words.append(word)
        else:
            runs.append(SpeakerRun(speaker_id=speaker, words=[word]))

    runs = _merge_short_runs(runs, min_run_words)
    return runs


def _merge_short_runs(runs: list[SpeakerRun], min_run_words: int) -> list[SpeakerRun]:
    changed = True
    while changed and len(runs) > 1:
        changed = False
        for index, run in enumerate(runs):
            if len(run.words) >= min_run_words:
                continue
            if index > 0:
                runs[index - 1].words.extend(run.words)
                del runs[index]
            else:
                runs[1].words = run.words + runs[1].words
                del runs[0]
            changed = True
            break
        runs = _coalesce_adjacent(runs)
    return runs


def _coalesce_adjacent(runs: list[SpeakerRun]) -> list[SpeakerRun]:
    merged: list[SpeakerRun] = []
    for run in runs:
        if merged and merged[-1].speaker_id == run.speaker_id:
            merged[-1].words.extend(run.words)
        else:
            merged.append(run)
    return merged
