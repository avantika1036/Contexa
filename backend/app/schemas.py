from datetime import datetime
from typing import Any, Literal

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
    suspended_at: datetime | None = None


class AutoMeetingCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    capture_key: str = Field(min_length=1, max_length=255)
    process_name: str | None = Field(default=None, max_length=100)

    @field_validator("title")
    @classmethod
    def title_must_not_be_blank(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Meeting title cannot be blank.")
        return cleaned

    @field_validator("capture_key")
    @classmethod
    def capture_key_must_not_be_blank(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Capture identity cannot be blank.")
        return cleaned


class AutoMeetingResponse(BaseModel):
    meeting: MeetingRead
    reused: bool


class TranscriptSegmentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    meeting_id: str
    text: str
    start_seconds: float
    end_seconds: float
    speaker_id: int | None
    audio_channel: int | None = None
    confidence: float | None
    words: list[dict[str, Any]] | None
    created_at: datetime
    is_final: bool = True


MemoryItemType = Literal[
    "topic",
    "fact",
    "entity",
    "proposal",
    "argument",
    "question",
    "open_question",
    "decision",
    "action_item",
    "event",
    "person",
]


class MemoryItemRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    meeting_id: str
    item_type: MemoryItemType
    title: str
    content: str
    status: str
    decision_state: str | None
    owner: str | None
    speaker_id: int | None
    evidence_quote: str
    source_segment_ids: list[str]
    related_entities: list[str]
    start_seconds: float
    end_seconds: float
    confidence: float
    source: str
    model_name: str | None
    created_at: datetime
    updated_at: datetime


class MemoryExtractionResponse(BaseModel):
    meeting_id: str
    processed_segments: int
    item_count: int
    items: list[MemoryItemRead]


class MeetingChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class MeetingQuestionRequest(BaseModel):
    question: str = Field(min_length=1, max_length=1200)
    scope: Literal["meeting", "broader"] = "meeting"
    history: list[MeetingChatTurn] = Field(default_factory=list, max_length=8)

    @field_validator("question")
    @classmethod
    def question_must_not_be_blank(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Question cannot be blank.")
        return cleaned


class MeetingQuestionEvidence(BaseModel):
    segment_id: str
    start_seconds: float
    quote: str


class MeetingQuestionResponse(BaseModel):
    meeting_id: str
    meeting_answer: str
    broader_context: str | None = None
    evidence: list[MeetingQuestionEvidence] = Field(default_factory=list)
    scope: Literal["meeting", "broader"]
    model: str
    context_segments_used: int
