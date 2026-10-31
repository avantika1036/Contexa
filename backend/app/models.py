from datetime import datetime, timezone
from uuid import uuid4

from typing import Any

from sqlalchemy import DateTime, Float, ForeignKey, Integer, JSON, String, Text, UniqueConstraint, Index, text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class Meeting(Base):
    __tablename__ = "meetings"
    __table_args__ = (
        # A stable provider meeting ID may have at most one active Contexa session.
        # Ended meetings may reuse the same external ID for a later occurrence.
        Index(
            "uq_meetings_open_capture_key",
            "capture_key",
            unique=True,
            postgresql_where=text("status IN ('active', 'suspended') AND capture_key IS NOT NULL"),
            sqlite_where=text("status IN ('active', 'suspended') AND capture_key IS NOT NULL"),
        ),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid4())
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="active", index=True
    )
    audio_source: Mapped[str | None] = mapped_column(String(30), nullable=True)
    # Only populated when the detector can extract a stable external meeting ID
    # (for example, a Google Meet code). Process IDs and generic titles are not keys.
    capture_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    capture_process_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    ended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Set when desktop capture is intentionally interrupted but the real meeting
    # may still be running. Unlike ended_at, this state can be resumed.
    suspended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class TranscriptSegment(Base):
    """A finalized, timestamped transcript segment associated with a meeting."""

    __tablename__ = "transcript_segments"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid4())
    )
    meeting_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    text: Mapped[str] = mapped_column(Text, nullable=False)
    start_seconds: Mapped[float] = mapped_column(Float, nullable=False)
    end_seconds: Mapped[float] = mapped_column(Float, nullable=False)
    speaker_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    audio_channel: Mapped[int | None] = mapped_column(Integer, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    words: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )


class MemoryItem(Base):
    """A structured meeting-memory record with transcript provenance."""

    __tablename__ = "memory_items"
    __table_args__ = (
        UniqueConstraint(
            "meeting_id", "item_type", "dedupe_key", name="uq_memory_items_meeting_type_key"
        ),
        Index("ix_memory_items_meeting_start", "meeting_id", "start_seconds"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid4())
    )
    meeting_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    item_type: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="active")
    decision_state: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)
    owner: Mapped[str | None] = mapped_column(String(200), nullable=True)
    speaker_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    evidence_quote: Mapped[str] = mapped_column(Text, nullable=False)
    source_segment_ids: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    related_entities: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    start_seconds: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    end_seconds: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.5)
    source: Mapped[str] = mapped_column(String(30), nullable=False, default="transcript")
    model_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    dedupe_key: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
