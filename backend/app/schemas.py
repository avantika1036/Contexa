from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class MeetingCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)

    @field_validator("title")
    @classmethod
    def title_must_not_be_blank(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Meeting title cannot be blank.")
        return cleaned


class MeetingRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    status: str
    audio_source: str | None
    created_at: datetime
    ended_at: datetime | None


class TranscriptSegmentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    meeting_id: str
    text: str
    start_seconds: float
    end_seconds: float
    speaker_id: int | None
    confidence: float | None
    words: list[dict[str, Any]] | None
    created_at: datetime
    is_final: bool = True
