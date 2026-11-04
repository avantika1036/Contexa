import asyncio
import json
import logging
import re
import time
from urllib.parse import urlencode
from datetime import datetime, timezone

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import delete, func, inspect as sqlalchemy_inspect, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.database import engine, get_db, get_session_factory
from app.models import Meeting, MemoryItem, TranscriptSegment
from app.schemas import (
    MeetingCreate, MeetingRead, MemoryExtractionResponse, MemoryItemRead, TranscriptSegmentRead,
    MeetingQuestionRequest, MeetingQuestionResponse, AutoMeetingCreate, AutoMeetingResponse, MeetingIdentityUpgrade,
)
from app.memory_service import process_meeting_transcript_memory
from app.qa_service import answer_meeting_question as generate_meeting_answer
from starlette.websockets import WebSocketState
from app.speaker_segments import split_words_by_speaker
from app.transcription_params import keyterm_params, language_warning
from websockets.asyncio.client import ClientConnection, connect as upstream_connect
from websockets.exceptions import ConnectionClosed


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
MAX_AUDIO_CHUNK_BYTES = 2_000_000
MEMORY_EXTRACTION_JOBS: dict[str, dict[str, object]] = {}
# Number of live WebSocket connections per meeting; cleanup never touches a connected meeting.
ACTIVE_MEETING_CONNECTIONS: dict[str, int] = {}
# Number of active upstream audio/transcription streams per meeting. A WebSocket can
# remain open for UI/control traffic after audio.stop, so suspension must guard this
# counter rather than ACTIVE_MEETING_CONNECTIONS.
ACTIVE_MEETING_STREAMS: dict[str, int] = {}


def _mark_audio_stream_started(meeting_id: str) -> None:
    ACTIVE_MEETING_STREAMS[meeting_id] = ACTIVE_MEETING_STREAMS.get(meeting_id, 0) + 1


def _mark_audio_stream_stopped(meeting_id: str) -> None:
    remaining = ACTIVE_MEETING_STREAMS.get(meeting_id, 1) - 1
    if remaining > 0:
        ACTIVE_MEETING_STREAMS[meeting_id] = remaining
    else:
        ACTIVE_MEETING_STREAMS.pop(meeting_id, None)


class AudioTimeline:
    """Map compressed raw-audio stream time back to elapsed meeting time after VAD gaps."""

    def __init__(self) -> None:
        # Seconds already elapsed in the meeting before this audio stream began. Non-zero
        # when capture resumes in an existing session, so timestamps never restart at 0.
        self.base_offset = 0.0
        self.reset(False, 48000, 1)

    def reset(self, raw_pcm: bool, sample_rate: int = 48000, channels: int = 1) -> None:
        self.raw_pcm = raw_pcm
        self.sample_rate = sample_rate
        self.channels = channels
        self.started_at = time.monotonic()
        self.last_chunk_at: float | None = None
        self.last_chunk_duration = 0.0
        self.stream_seconds = 0.0
        # Each tuple is (compressed stream second at which the gap begins, omitted wall seconds).
        self.gaps: list[tuple[float, float]] = []

    def record_chunk(self, byte_length: int) -> None:
        if not self.raw_pcm or byte_length <= 0:
            return
        now = time.monotonic()
        duration = byte_length / (2 * self.channels * self.sample_rate)
        if self.last_chunk_at is None:
            initial_wait = max(0.0, now - self.started_at)
            if initial_wait > 0.12:
                self.gaps.append((0.0, initial_wait))
        else:
            elapsed = max(0.0, now - self.last_chunk_at)
            omitted = elapsed - self.last_chunk_duration
            # Ignore ordinary scheduling jitter; VAD pauses are generally far longer.
            if omitted > 0.20:
                self.gaps.append((self.stream_seconds, omitted))
        self.last_chunk_at = now
        self.last_chunk_duration = duration
        self.stream_seconds += duration

    def map_time(self, stream_seconds: float) -> float:
        if not self.raw_pcm:
            return max(0.0, stream_seconds) + self.base_offset
        offset = sum(gap for stream_anchor, gap in self.gaps if stream_anchor <= stream_seconds)
        return max(0.0, stream_seconds + offset) + self.base_offset


async def _keep_deepgram_alive(
    connection: ClientConnection,
    send_lock: asyncio.Lock,
    meeting_id: str,
) -> None:
    """Keep a live transcription WebSocket open while VAD suppresses silent audio frames."""
    while True:
        await asyncio.sleep(5.0)
        try:
            async with send_lock:
                await connection.send(json.dumps({"type": "KeepAlive"}))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("Deepgram keepalive stopped for meeting %s", meeting_id, exc_info=True)
            return


def _memory_schema_ready(bind=engine) -> bool:
    """Check that the table and all columns expected by the current ORM model exist."""
    try:
        inspector = sqlalchemy_inspect(bind)
        if not inspector.has_table("memory_items"):
            return False
        actual_columns = {column["name"] for column in inspector.get_columns("memory_items")}
        expected_columns = {column.name for column in MemoryItem.__table__.columns}
        return expected_columns.issubset(actual_columns)
    except SQLAlchemyError:
        logger.exception("Could not inspect the structured-memory database schema")
        return False


def _memory_migration_message() -> str:
    return (
        "The structured-memory database schema is missing or outdated (the memory_items "
        "table or one of its columns, such as decision_state, is unavailable). From "
        "C:/Work/Contexa/backend run `python -m alembic upgrade head`, then restart FastAPI. "
        "Existing meetings and transcripts are preserved; do not reset the database volume."
    )


_NATIVE_WINDOW_CAPTURE_KEY = re.compile(
    r"^(?P<provider>zoom|teams|webex):window:(?P<pid>\d+):(?P<window>[A-Za-z0-9_-]{1,80})$",
    re.IGNORECASE,
)


def _normalize_auto_meeting_title(value: str | None) -> str:
    title = str(value or "").strip()
    title = re.sub(r"^auto\s*·\s*", "", title, flags=re.IGNORECASE)
    title = re.sub(r"\s+", " ", title)
    return title.strip(" \t-–—|·").lower()


def _is_generic_native_meeting_title(provider: str, title: str) -> bool:
    normalized = _normalize_auto_meeting_title(title)
    generic = {
        "zoom": {
            "zoom", "zoom meeting", "zoom workplace", "meeting", "call", "meeting in progress",
        },
        "teams": {
            "teams", "microsoft teams", "teams meeting", "microsoft teams meeting",
            "meeting", "meeting join | microsoft teams meeting", "join meeting | microsoft teams",
        },
        "webex": {
            "webex", "cisco webex", "cisco webex meetings", "webex meeting", "meeting",
            "get ready to join · meeting · webex", "in meeting · meeting · webex",
        },
    }
    if normalized in generic.get(provider, set()):
        return True
    if provider == "webex" and ("get ready to join" in normalized or "in meeting" in normalized):
        return True
    return False


def _native_window_titles_compatible(provider: str, existing_title: str, incoming_title: str) -> bool:
    existing = _normalize_auto_meeting_title(existing_title)
    incoming = _normalize_auto_meeting_title(incoming_title)
    if not existing or not incoming or existing == incoming:
        return True
    # On restart, Zoom/Teams/Webex can temporarily replace a descriptive title with
    # a generic provider title while preserving the same process/HWND capture key.
    return (
        _is_generic_native_meeting_title(provider, existing)
        or _is_generic_native_meeting_title(provider, incoming)
    )


def _legacy_native_auto_candidates(db: Session, provider: str, incoming_title: str) -> list[Meeting]:
    """Find one recent unkeyed native auto session left by a pre-window-key desktop build."""
    rows = list(db.scalars(
        select(Meeting)
        .where(
            Meeting.capture_key.is_(None),
            Meeting.status.in_(["active", "suspended"]),
            Meeting.title.ilike("Auto · %"),
        )
        .order_by(Meeting.created_at.desc())
        .limit(20)
    ).all())
    grace_seconds = max(0, int(settings.suspended_session_resume_grace_seconds))
    now = datetime.now(timezone.utc)
    marker = {"zoom": "zoom", "teams": "teams", "webex": "webex"}[provider]
    candidates: list[Meeting] = []
    for row in rows:
        if ACTIVE_MEETING_CONNECTIONS.get(row.id, 0) > 0 or ACTIVE_MEETING_STREAMS.get(row.id, 0) > 0:
            continue
        if marker not in _normalize_auto_meeting_title(row.title):
            continue
        if not _native_window_titles_compatible(provider, row.title, incoming_title):
            continue
        last_activity = _aware(row.suspended_at or row.created_at)
        latest_segment = db.scalar(
            select(func.max(TranscriptSegment.created_at)).where(TranscriptSegment.meeting_id == row.id)
        )
        if latest_segment is not None:
            last_activity = max(last_activity, _aware(latest_segment))
        if max(0.0, (now - last_activity).total_seconds()) <= grace_seconds:
            candidates.append(row)
    return candidates

app = FastAPI(
    title=settings.app_name,
    version="0.3.0",
    description="Real-time meeting context and memory API.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", tags=["health"])
def health_check() -> dict[str, str]:
    return {"status": "ok", "service": "contexa-api"}


@app.get("/health/db", tags=["health"])
def database_health_check() -> dict[str, str]:
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except SQLAlchemyError as exc:
        logger.exception("Database health check failed")
        raise HTTPException(status_code=503, detail="Database connection failed") from exc

    return {"status": "ok", "database": "connected"}


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _segment_count(db: Session, meeting_id: str) -> int:
    return int(db.scalar(select(func.count()).select_from(TranscriptSegment).where(TranscriptSegment.meeting_id == meeting_id)) or 0)


def _resume_offset_seconds(session_factory: sessionmaker[Session], meeting_id: str) -> float:
    """Elapsed meeting time when a new audio stream starts in a session that already has transcript."""
    with session_factory() as session:
        meeting = session.get(Meeting, meeting_id)
        if meeting is None or _segment_count(session, meeting_id) == 0:
            return 0.0
        last_end = float(session.scalar(select(func.max(TranscriptSegment.end_seconds)).where(TranscriptSegment.meeting_id == meeting_id)) or 0.0)
        elapsed = (datetime.now(timezone.utc) - _aware(meeting.created_at)).total_seconds()
        return max(0.0, last_end, elapsed)


def _delete_meeting_records(db: Session, meeting_id: str) -> None:
    """Delete a meeting and its dependent rows explicitly (does not rely on FK cascade support)."""
    db.execute(delete(MemoryItem).where(MemoryItem.meeting_id == meeting_id))
    db.execute(delete(TranscriptSegment).where(TranscriptSegment.meeting_id == meeting_id))
    db.execute(delete(Meeting).where(Meeting.id == meeting_id))
    db.commit()
    MEMORY_EXTRACTION_JOBS.pop(meeting_id, None)


def _legacy_auto_meet_candidates(db: Session) -> list[Meeting]:
    """Find recent pre-identity automatic Google Meet rows created by older desktop builds."""
    rows = list(db.scalars(
        select(Meeting)
        .where(
            Meeting.capture_key.is_(None),
            Meeting.status.in_(["active", "suspended"]),
            Meeting.title.in_(["Auto · Meet", "Auto · Google Meet"]),
        )
        .order_by(Meeting.created_at.desc())
        .limit(3)
    ).all())

    grace_seconds = max(0, int(settings.suspended_session_resume_grace_seconds))
    now = datetime.now(timezone.utc)
    candidates: list[Meeting] = []
    for row in rows:
        if ACTIVE_MEETING_CONNECTIONS.get(row.id, 0) > 0:
            continue
        latest_segment = db.scalar(
            select(func.max(TranscriptSegment.created_at)).where(TranscriptSegment.meeting_id == row.id)
        )
        last_activity = _aware(row.suspended_at or row.created_at)
        if latest_segment is not None:
            last_activity = max(last_activity, _aware(latest_segment))
        age_seconds = max(0.0, (now - last_activity).total_seconds())
        if age_seconds <= grace_seconds:
            candidates.append(row)
    return candidates


def _shift_transcript_segment(segment: TranscriptSegment, offset_seconds: float) -> None:
    segment.start_seconds = float(segment.start_seconds) + offset_seconds
    segment.end_seconds = float(segment.end_seconds) + offset_seconds
    if isinstance(segment.words, list):
        shifted_words = []
        for word in segment.words:
            if not isinstance(word, dict):
                shifted_words.append(word)
                continue
            shifted = dict(word)
            for key in ("start", "end", "start_seconds", "end_seconds"):
                value = shifted.get(key)
                if isinstance(value, (int, float)):
                    shifted[key] = float(value) + offset_seconds
            shifted_words.append(shifted)
        segment.words = shifted_words


def _merge_legacy_auto_meet_into(legacy: Meeting, canonical: Meeting, db: Session) -> None:
    """Merge one old provisional Google Meet row into its stable-ID row before a new stream opens.

    The stable row is canonical. Transcript timestamps are shifted only when the rows overlap
    in separate stream-relative timelines; the earlier row remains first in the combined history.
    This function is called only when neither row has an active WebSocket connection.
    """
    if legacy.id == canonical.id:
        return

    legacy_segments = list(db.scalars(
        select(TranscriptSegment).where(TranscriptSegment.meeting_id == legacy.id)
    ).all())
    canonical_segments = list(db.scalars(
        select(TranscriptSegment).where(TranscriptSegment.meeting_id == canonical.id)
    ).all())

    legacy_first_segment_at = min((_aware(item.created_at) for item in legacy_segments), default=_aware(legacy.created_at))
    canonical_first_segment_at = min((_aware(item.created_at) for item in canonical_segments), default=_aware(canonical.created_at))
    legacy_is_earlier = legacy_first_segment_at <= canonical_first_segment_at
    legacy_max_end = max((float(item.end_seconds) for item in legacy_segments), default=0.0)
    canonical_max_end = max((float(item.end_seconds) for item in canonical_segments), default=0.0)

    legacy_offset = 0.0
    canonical_offset = 0.0
    if legacy_segments and canonical_segments:
        if legacy_is_earlier:
            canonical_offset = legacy_max_end
            for segment in canonical_segments:
                _shift_transcript_segment(segment, canonical_offset)
        else:
            legacy_offset = canonical_max_end
            for segment in legacy_segments:
                _shift_transcript_segment(segment, legacy_offset)
    elif not legacy_is_earlier and canonical_max_end > 0:
        legacy_offset = canonical_max_end
        for segment in legacy_segments:
            _shift_transcript_segment(segment, legacy_offset)

    for segment in legacy_segments:
        segment.meeting_id = canonical.id

    legacy_items = list(db.scalars(select(MemoryItem).where(MemoryItem.meeting_id == legacy.id)).all())
    canonical_items = list(db.scalars(select(MemoryItem).where(MemoryItem.meeting_id == canonical.id)).all())
    for item in canonical_items:
        if canonical_offset:
            item.start_seconds = float(item.start_seconds) + canonical_offset
            item.end_seconds = float(item.end_seconds) + canonical_offset
    canonical_keys = {(item.item_type, item.dedupe_key) for item in canonical_items}
    for item in legacy_items:
        if legacy_offset:
            item.start_seconds = float(item.start_seconds) + legacy_offset
            item.end_seconds = float(item.end_seconds) + legacy_offset
        if (item.item_type, item.dedupe_key) in canonical_keys:
            item.dedupe_key = f"{item.dedupe_key}:merged:{legacy.id[:8]}"[:255]
        item.meeting_id = canonical.id

    canonical.created_at = min(_aware(canonical.created_at), _aware(legacy.created_at))
    canonical.title = canonical.title or legacy.title
    db.delete(legacy)
    logger.info(
        "Merged legacy provisional Meet session %s into stable session %s (transcript_segments=%d memory_items=%d)",
        legacy.id, canonical.id, len(legacy_segments), len(legacy_items),
    )


def _finish_active_meeting(
    meeting: Meeting,
    db: Session,
    background_tasks: BackgroundTasks,
    session_factory: sessionmaker[Session],
) -> None:
    """Mark an open meeting ended and queue the one end-of-meeting memory extraction."""
    meeting.status = "ended"
    meeting.ended_at = datetime.now(timezone.utc)
    meeting.suspended_at = None
    db.commit()
    db.refresh(meeting)
    # BackgroundTasks starts only after the ended state is committed. No Groq calls happen
    # while the meeting is live; one short meeting is usually one provider request.
    if settings.memory_auto_extract_on_end:
        MEMORY_EXTRACTION_JOBS[meeting.id] = {
            "meeting_id": meeting.id, "status": "queued", "item_count": 0,
            "message": "Meeting ended. Structured memory extraction is queued.",
        }
        background_tasks.add_task(_extract_memory_after_meeting_end, meeting.id, session_factory)


@app.post("/api/meetings", response_model=MeetingRead, status_code=201, tags=["meetings"])
def create_meeting(payload: MeetingCreate, db: Session = Depends(get_db)) -> Meeting:
    is_automatic = payload.title.strip().lower().startswith("auto · ")
    meeting = Meeting(title=payload.title, audio_source=("desktop_auto" if is_automatic else None))
    db.add(meeting)
    db.commit()
    db.refresh(meeting)
    return meeting


@app.post(
    "/api/meetings/auto",
    response_model=AutoMeetingResponse,
    status_code=200,
    tags=["meetings"],
)
def create_or_reuse_auto_meeting(
    payload: AutoMeetingCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    session_factory: sessionmaker[Session] = Depends(get_session_factory),
) -> dict[str, object]:
    """Return the active or recently suspended session for a stable provider meeting ID.

    A suspended session is reusable only within the configured grace period. Expired
    suspended sessions are finalized (or discarded if empty) before a fresh row is made.
    Ended sessions are never resumed.
    """
    existing = db.scalar(
        select(Meeting).where(
            Meeting.capture_key == payload.capture_key,
            Meeting.status.in_(["active", "suspended"]),
        )
    )
    if existing is not None:
        native_key_match = _NATIVE_WINDOW_CAPTURE_KEY.fullmatch(payload.capture_key)
        if native_key_match and not _native_window_titles_compatible(
            native_key_match.group("provider").lower(), existing.title, payload.title
        ):
            if ACTIVE_MEETING_CONNECTIONS.get(existing.id, 0) > 0 or ACTIVE_MEETING_STREAMS.get(existing.id, 0) > 0:
                raise HTTPException(
                    status_code=409,
                    detail="This native window recovery key is still connected to a different meeting title.",
                )
            memory_count = int(db.scalar(
                select(func.count()).select_from(MemoryItem).where(MemoryItem.meeting_id == existing.id)
            ) or 0)
            if _segment_count(db, existing.id) == 0 and memory_count == 0:
                stale_id = existing.id
                _delete_meeting_records(db, stale_id)
                logger.info("Discarded empty suspended native session %s because the same window now reports a different meeting title", stale_id)
            else:
                _finish_active_meeting(existing, db, background_tasks, session_factory)
                logger.info("Finalized prior native meeting %s because the same window now reports a different meeting title", existing.id)
            existing = None

    if existing is not None:
        # Older desktop builds created "Auto · Meet" before Google exposed its call code,
        # then upgraded only an in-memory key. Reconcile the single recent unkeyed row here
        # before opening a new WebSocket so restart recovery does not create another history item.
        legacy_candidates = (
            [row for row in _legacy_auto_meet_candidates(db) if row.id != existing.id]
            if payload.capture_key.lower().startswith("meet:") else []
        )
        if len(legacy_candidates) == 1 and ACTIVE_MEETING_CONNECTIONS.get(existing.id, 0) == 0:
            _merge_legacy_auto_meet_into(legacy_candidates[0], existing, db)
        elif legacy_candidates:
            # Empty legacy rows are safe to discard; rows with transcripts are deliberately
            # preserved when the identity is ambiguous rather than risking a wrong merge.
            for legacy in legacy_candidates:
                if _segment_count(db, legacy.id) == 0 and db.scalar(
                    select(func.count()).select_from(MemoryItem).where(MemoryItem.meeting_id == legacy.id)
                ) == 0:
                    _delete_meeting_records(db, legacy.id)
                    logger.info("Discarded empty legacy provisional Meet session %s", legacy.id)
        if existing.status == "suspended":
            suspended_at = _aware(existing.suspended_at or existing.created_at)
            age_seconds = max(0.0, (datetime.now(timezone.utc) - suspended_at).total_seconds())
            if age_seconds > max(0, settings.suspended_session_resume_grace_seconds):
                if _segment_count(db, existing.id) == 0:
                    expired_id = existing.id
                    _delete_meeting_records(db, expired_id)
                    logger.info("Discarded expired empty suspended session %s", expired_id)
                else:
                    _finish_active_meeting(existing, db, background_tasks, session_factory)
                    logger.info("Finalized expired suspended session %s after %.1fs", existing.id, age_seconds)
                existing = None
            else:
                existing.status = "active"
                existing.suspended_at = None
                existing.ended_at = None
                if payload.title:
                    existing.title = payload.title[:200]
                if payload.process_name:
                    existing.capture_process_name = payload.process_name[:100]
                db.commit()
                db.refresh(existing)
                logger.info("Resumed suspended session %s for capture key %s", existing.id, payload.capture_key)
                return {"meeting": existing, "reused": True}
        else:
            if payload.process_name:
                existing.capture_process_name = payload.process_name[:100]
            db.commit()
            db.refresh(existing)
            return {"meeting": existing, "reused": True}

    # Native desktop sessions created by earlier builds may have no capture_key. If exactly
    # one recent, disconnected unkeyed Auto row matches this provider and the incoming/generic
    # title pair, adopt it so the first restart after installing durable window keys does not
    # create a duplicate history entry.
    native_key_match = _NATIVE_WINDOW_CAPTURE_KEY.fullmatch(payload.capture_key)
    if native_key_match:
        provider = native_key_match.group("provider").lower()
        native_legacy_candidates = _legacy_native_auto_candidates(db, provider, payload.title)
        if len(native_legacy_candidates) == 1:
            legacy = native_legacy_candidates[0]
            legacy.capture_key = payload.capture_key
            legacy.title = payload.title[:200]
            legacy.capture_process_name = payload.process_name or legacy.capture_process_name
            legacy.audio_source = "desktop_auto"
            if legacy.status == "suspended":
                legacy.status = "active"
                legacy.suspended_at = None
                legacy.ended_at = None
            try:
                db.commit()
                db.refresh(legacy)
                logger.info("Adopted prior unkeyed %s session %s with native window recovery key %s", provider, legacy.id, payload.capture_key)
                return {"meeting": legacy, "reused": True}
            except IntegrityError:
                db.rollback()
                logger.exception("Could not adopt prior native session for recovery key %s", payload.capture_key)
                raise HTTPException(status_code=409, detail="Could not safely adopt the previous native meeting session.")

    # No stable row exists. If exactly one recent legacy provisional Auto · Meet row exists,
    # upgrade it in place instead of creating a duplicate session after an Electron restart.
    legacy_candidates = _legacy_auto_meet_candidates(db) if payload.capture_key.lower().startswith("meet:") else []
    if len(legacy_candidates) == 1:
        legacy = legacy_candidates[0]
        legacy.capture_key = payload.capture_key
        legacy.title = payload.title[:200]
        legacy.capture_process_name = (payload.process_name or None)
        legacy.audio_source = "desktop_auto"
        if legacy.status == "suspended":
            legacy.status = "active"
            legacy.suspended_at = None
            legacy.ended_at = None
        try:
            db.commit()
            db.refresh(legacy)
            logger.info("Adopted legacy provisional Meet session %s for stable capture key %s", legacy.id, payload.capture_key)
            return {"meeting": legacy, "reused": True}
        except IntegrityError:
            db.rollback()
            logger.exception("Could not adopt legacy provisional Meet session for %s", payload.capture_key)
            raise HTTPException(status_code=409, detail="Could not safely adopt the previous provisional meeting session.")

    meeting = Meeting(
        title=payload.title,
        status="active",
        audio_source="desktop_auto",
        capture_key=payload.capture_key,
        capture_process_name=(payload.process_name or None),
    )
    db.add(meeting)
    try:
        db.commit()
        db.refresh(meeting)
        return {"meeting": meeting, "reused": False}
    except IntegrityError:
        # Two detector events can race. The partial unique index is the source of truth:
        # after rolling back, load the row inserted by the competing request.
        db.rollback()
        existing = db.scalar(
            select(Meeting).where(
                Meeting.capture_key == payload.capture_key,
                Meeting.status.in_(["active", "suspended"]),
            )
        )
        if existing is None:
            raise HTTPException(status_code=409, detail="Could not claim this meeting identity. Retry detection.")
        if existing.status == "suspended":
            existing.status = "active"
            existing.suspended_at = None
            existing.ended_at = None
            db.commit()
            db.refresh(existing)
        return {"meeting": existing, "reused": True}


@app.patch("/api/meetings/{meeting_id}/identity", response_model=MeetingRead, tags=["meetings"])
def upgrade_meeting_identity(
    meeting_id: str,
    payload: MeetingIdentityUpgrade,
    db: Session = Depends(get_db),
) -> Meeting:
    """Persist a provider call ID discovered after an automatic capture has already started."""
    if not re.fullmatch(r"(?:meet:[a-z]{3}-[a-z]{4}-[a-z]{3}|(?:zoom|teams|webex):id:\d{8,13})", payload.capture_key, re.IGNORECASE):
        raise HTTPException(status_code=422, detail="Only a stable provider meeting identity can be persisted.")

    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting session not found.")
    if meeting.status == "ended":
        raise HTTPException(status_code=409, detail="An ended meeting cannot receive a new capture identity.")

    existing = db.scalar(
        select(Meeting).where(
            Meeting.capture_key == payload.capture_key,
            Meeting.status.in_(["active", "suspended"]),
            Meeting.id != meeting_id,
        )
    )
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=f"Another open session already owns this meeting identity ({existing.id}). Retry using the stable automatic-session endpoint.",
        )

    meeting.capture_key = payload.capture_key
    meeting.title = payload.title[:200]
    meeting.capture_process_name = (payload.process_name or None)
    meeting.audio_source = "desktop_auto"
    try:
        db.commit()
        db.refresh(meeting)
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="This meeting identity was claimed by another capture at the same time.") from exc
    logger.info("Persisted stable capture identity %s on existing session %s", payload.capture_key, meeting.id)
    return meeting


@app.post("/api/meetings/{meeting_id}/suspend", response_model=MeetingRead, tags=["meetings"])
def suspend_meeting(meeting_id: str, db: Session = Depends(get_db)) -> Meeting:
    """Persist a recoverable capture interruption without declaring the meeting ended."""
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting session not found.")
    if meeting.status == "ended":
        raise HTTPException(status_code=409, detail="This meeting session has ended and cannot be suspended.")
    if meeting.status == "active":
        # A websocket may remain connected for UI/control traffic after its audio
        # stream has been finalized. Only an active upstream transcription stream
        # should prevent suspension. The audio.stop acknowledgement is sent only
        # after this counter is decremented, avoiding a shutdown race.
        if ACTIVE_MEETING_STREAMS.get(meeting_id, 0) > 0:
            raise HTTPException(status_code=409, detail="Stop the active audio stream before suspending this meeting.")
        meeting.status = "suspended"
        meeting.suspended_at = datetime.now(timezone.utc)
        meeting.ended_at = None
        db.commit()
        db.refresh(meeting)
    return meeting


@app.post("/api/meetings/{meeting_id}/resume", response_model=MeetingRead, tags=["meetings"])
def resume_meeting(meeting_id: str, db: Session = Depends(get_db)) -> Meeting:
    """Resume a suspended session; never revive a permanently ended session."""
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting session not found.")
    if meeting.status == "ended":
        raise HTTPException(status_code=409, detail="This meeting session has ended and cannot be resumed.")
    if meeting.status == "suspended":
        suspended_at = _aware(meeting.suspended_at or meeting.created_at)
        age_seconds = max(0.0, (datetime.now(timezone.utc) - suspended_at).total_seconds())
        if age_seconds > max(0, settings.suspended_session_resume_grace_seconds):
            raise HTTPException(status_code=409, detail="The meeting resume window has expired. Create a fresh session.")
        meeting.status = "active"
        meeting.suspended_at = None
        meeting.ended_at = None
        db.commit()
        db.refresh(meeting)
    return meeting


@app.get("/api/meetings", response_model=list[MeetingRead], tags=["meetings"])
def list_meetings(
    limit: int = Query(default=50, ge=1, le=100),
    db: Session = Depends(get_db),
) -> list[Meeting]:
    statement = select(Meeting).order_by(Meeting.created_at.desc()).limit(limit)
    return list(db.scalars(statement).all())


@app.get("/api/meetings/{meeting_id}", response_model=MeetingRead, tags=["meetings"])
def get_meeting(meeting_id: str, db: Session = Depends(get_db)) -> Meeting:
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting session not found.")
    return meeting


async def _extract_memory_after_meeting_end(
    meeting_id: str,
    session_factory: sessionmaker[Session],
) -> None:
    """Run one batched extraction after capture stops and the transcript is flushed."""
    job: dict[str, object] = {"meeting_id": meeting_id, "status": "processing", "message": "Extracting structured memory from the completed transcript."}
    MEMORY_EXTRACTION_JOBS[meeting_id] = job

    if not settings.memory_auto_extract_on_end:
        MEMORY_EXTRACTION_JOBS[meeting_id] = {
            "meeting_id": meeting_id, "status": "skipped", "item_count": 0,
            "message": "Automatic extraction is disabled. Use the Memory panel's extract action if needed.",
        }
        return
    api_key = settings.memory_api_key
    if not api_key:
        MEMORY_EXTRACTION_JOBS[meeting_id] = {
            "meeting_id": meeting_id, "status": "failed", "item_count": 0,
            "message": "Add GROQ_API_KEY to the repository-root .env file and restart FastAPI.",
        }
        logger.warning("Skipping end-of-meeting memory extraction for %s: Groq API key is not configured", meeting_id)
        return
    if not _memory_schema_ready():
        MEMORY_EXTRACTION_JOBS[meeting_id] = {
            "meeting_id": meeting_id, "status": "failed", "item_count": 0,
            "message": _memory_migration_message(),
        }
        logger.error("Skipping end-of-meeting memory extraction for %s: %s", meeting_id, _memory_migration_message())
        return

    try:
        result = await process_meeting_transcript_memory(
            session_factory,
            meeting_id,
            api_key=api_key,
            model=settings.memory_model,
            base_url=settings.memory_base_url,
        )
        items = result.get("items", [])
        processed_segments = int(result.get("processed_segments", 0))
        message = (
            f"Memory extraction complete: {len(items)} item(s) from {processed_segments} transcript segment(s)."
            if processed_segments else "No transcript segments were saved for this meeting, so no Groq request was made."
        )
        MEMORY_EXTRACTION_JOBS[meeting_id] = {
            "meeting_id": meeting_id,
            "status": "succeeded" if processed_segments else "skipped",
            "processed_segments": processed_segments,
            "item_count": len(items),
            "message": message,
        }
        logger.info(
            "End-of-meeting memory extraction finished: meeting_id=%s processed_segments=%s saved_items=%s",
            meeting_id, processed_segments, len(items),
        )
    except Exception:
        logger.exception("End-of-meeting memory extraction failed for %s", meeting_id)
        MEMORY_EXTRACTION_JOBS[meeting_id] = {
            "meeting_id": meeting_id, "status": "failed", "item_count": 0,
            "message": "Automatic memory extraction failed. Check the Groq API key, model, account limits, database schema, and backend log.",
        }


@app.post(
    "/api/meetings/{meeting_id}/end",
    response_model=MeetingRead,
    tags=["meetings"],
)
def end_meeting(
    meeting_id: str,
    background_tasks: BackgroundTasks,
    discard_if_empty: bool = Query(
        default=False,
        description="Delete the session instead of ending it when it has no transcript (auto-capture uses this).",
    ),
    db: Session = Depends(get_db),
    session_factory: sessionmaker[Session] = Depends(get_session_factory),
) -> Meeting | MeetingRead:
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting session not found.")

    if meeting.status in {"active", "suspended"}:
        if discard_if_empty and _segment_count(db, meeting_id) == 0:
            snapshot = MeetingRead.model_validate(meeting).model_copy(
                update={"status": "discarded", "ended_at": datetime.now(timezone.utc)}
            )
            _delete_meeting_records(db, meeting_id)
            logger.info("Discarded empty meeting session %s", meeting_id)
            return snapshot
        _finish_active_meeting(meeting, db, background_tasks, session_factory)

    return meeting


@app.delete("/api/meetings/{meeting_id}", status_code=204, tags=["meetings"])
def delete_meeting(meeting_id: str, db: Session = Depends(get_db)) -> None:
    """Permanently delete a meeting, its transcript and its structured memory."""
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting session not found.")
    if ACTIVE_MEETING_CONNECTIONS.get(meeting_id, 0) > 0:
        raise HTTPException(status_code=409, detail="This meeting is currently being captured. Stop capture first.")
    _delete_meeting_records(db, meeting_id)


@app.post("/api/meetings/cleanup", tags=["meetings"])
def cleanup_meetings(
    background_tasks: BackgroundTasks,
    purge_empty: bool = Query(default=False, description="Also delete ended sessions that have no transcript."),
    idle_minutes: int | None = Query(default=None, ge=1, le=1440),
    auto_idle_minutes: int | None = Query(default=None, ge=1, le=1440, description="Optional shorter stale timeout for disconnected desktop-auto sessions only. Live connections are always protected."),
    db: Session = Depends(get_db),
    session_factory: sessionmaker[Session] = Depends(get_session_factory),
) -> dict[str, int]:
    """Close abandoned sessions and optionally remove empty duplicates left by earlier versions."""
    threshold_minutes = idle_minutes or settings.stale_active_meeting_minutes
    now = datetime.now(timezone.utc)
    counts = {"ended": 0, "discarded": 0, "purged": 0}

    for meeting in list(db.scalars(select(Meeting).where(Meeting.status.in_(["active", "suspended"]))).all()):
        if ACTIVE_MEETING_CONNECTIONS.get(meeting.id, 0) > 0:
            continue
        latest_segment = db.scalar(
            select(func.max(TranscriptSegment.created_at)).where(TranscriptSegment.meeting_id == meeting.id)
        )
        if meeting.status == "suspended":
            # Suspension is persisted only after the audio stream has been stopped and
            # its final transcript segments flushed, so suspended_at is the recovery clock.
            last_activity = _aware(meeting.suspended_at or meeting.created_at)
            # Suspended sessions have their own short, persisted recovery window. Do not
            # leave them yellow for the much longer generic stale-active-session timeout.
            recovery_grace_seconds = max(0, int(settings.suspended_session_resume_grace_seconds))
            if (now - last_activity).total_seconds() < recovery_grace_seconds:
                continue
        else:
            last_activity = _aware(latest_segment or meeting.created_at)
            is_desktop_auto = meeting.audio_source == "desktop_auto" or meeting.title.strip().lower().startswith("auto · ")
            effective_threshold_minutes = auto_idle_minutes if is_desktop_auto and auto_idle_minutes is not None else threshold_minutes
            if (now - last_activity).total_seconds() < effective_threshold_minutes * 60:
                continue
        if _segment_count(db, meeting.id) == 0:
            _delete_meeting_records(db, meeting.id)
            counts["discarded"] += 1
        else:
            _finish_active_meeting(meeting, db, background_tasks, session_factory)
            counts["ended"] += 1

    if purge_empty:
        for meeting in list(db.scalars(select(Meeting).where(Meeting.status.in_(["ended", "discarded"]))).all()):
            if _segment_count(db, meeting.id) == 0:
                _delete_meeting_records(db, meeting.id)
                counts["purged"] += 1
    return counts


@app.get("/api/transcription/status", tags=["transcription"])
def transcription_status() -> dict[str, object]:
    return {
        "provider": "deepgram",
        "configured": bool(settings.deepgram_api_key and settings.deepgram_api_key.strip()),
        "model": settings.deepgram_model,
        "language": settings.deepgram_language,
        "language_hints": settings.language_hints,
        "multilingual": settings.deepgram_language.strip().lower() == "multi",
    }


@app.get(
    "/api/meetings/{meeting_id}/transcript",
    response_model=list[TranscriptSegmentRead],
    tags=["transcription"],
)
def list_transcript_segments(
    meeting_id: str,
    db: Session = Depends(get_db),
) -> list[TranscriptSegment]:
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting session not found.")
    statement = (
        select(TranscriptSegment)
        .where(TranscriptSegment.meeting_id == meeting_id)
        .order_by(TranscriptSegment.start_seconds, TranscriptSegment.created_at)
    )
    return list(db.scalars(statement).all())


@app.get("/api/memory/status", tags=["memory"])
def memory_status() -> dict[str, object]:
    provider_configured = bool(settings.memory_api_key)
    schema_ready = _memory_schema_ready()
    configured = provider_configured and schema_ready
    if not provider_configured:
        message = "Add GROQ_API_KEY to the repository-root .env file and restart FastAPI."
    elif not schema_ready:
        message = _memory_migration_message()
    elif not settings.memory_auto_extract_on_end:
        message = (
            "Structured memory is configured in manual mode. No Groq requests are made during live capture. "
            "Use 'Extract saved transcript' only when you explicitly need an early extraction."
        )
    else:
        message = (
            "Structured memory is ready. Extraction runs automatically after the meeting ends; "
            "no Groq requests are made while the meeting is live. Short meetings usually need one request."
        )
    return {
        "provider": settings.memory_provider,
        "configured": configured,
        "provider_configured": provider_configured,
        "schema_ready": schema_ready,
        "model": settings.memory_model,
        "base_url": settings.memory_base_url,
        "automatic_extraction": bool(configured and settings.memory_auto_extract_on_end),
        "extraction_timing": "meeting_end" if settings.memory_auto_extract_on_end else "manual",
        "message": message,
    }


@app.post(
    "/api/meetings/{meeting_id}/ask",
    response_model=MeetingQuestionResponse,
    tags=["meeting Q&A"],
)
async def ask_meeting_question(
    meeting_id: str,
    request: MeetingQuestionRequest,
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """Answer explicit user questions from a selected meeting, optionally adding general context."""
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting session not found.")
    if not settings.memory_api_key:
        raise HTTPException(
            status_code=503,
            detail="Meeting Q&A is not configured. Add GROQ_API_KEY to the repository-root .env file and restart Contexa.",
        )

    transcript_statement = (
        select(TranscriptSegment)
        .where(TranscriptSegment.meeting_id == meeting_id)
        .order_by(TranscriptSegment.start_seconds, TranscriptSegment.created_at)
    )
    transcript_rows = list(db.scalars(transcript_statement).all())
    memory_statement = (
        select(MemoryItem)
        .where(MemoryItem.meeting_id == meeting_id)
        .order_by(MemoryItem.start_seconds, MemoryItem.created_at)
    )
    memory_rows: list[MemoryItem] = []
    if _memory_schema_ready(db.get_bind()):
        memory_rows = list(db.scalars(memory_statement).all())

    transcript_context = [
        {
            "id": segment.id,
            "start_seconds": segment.start_seconds,
            "end_seconds": segment.end_seconds,
            "speaker_id": segment.speaker_id,
            "audio_channel": segment.audio_channel,
            "text": segment.text,
        }
        for segment in transcript_rows
    ]
    memory_context = [
        {
            "id": item.id, "item_type": item.item_type, "title": item.title,
            "content": item.content, "status": item.status,
            "decision_state": item.decision_state, "owner": item.owner,
            "evidence_quote": item.evidence_quote,
            "source_segment_ids": item.source_segment_ids,
            "start_seconds": item.start_seconds, "end_seconds": item.end_seconds,
        }
        for item in memory_rows
    ]
    turns = [turn.model_dump() for turn in request.history[-6:]]
    # Release the request DB connection during the provider call. No provider request is
    # made while typing; this route runs only when the user submits an explicit question.
    db.close()
    try:
        answer = await generate_meeting_answer(
            question=request.question,
            scope=request.scope,
            transcript_segments=transcript_context,
            memory_items=memory_context,
            history=turns,
            api_key=settings.memory_api_key,
            model=settings.memory_model,
            base_url=settings.memory_base_url,
        )
    except Exception as exc:
        logger.exception("Meeting Q&A request failed for meeting %s", meeting_id)
        raise HTTPException(
            status_code=502,
            detail="Contexa could not generate an answer. Check the Groq model, account limits, and backend log.",
        ) from exc

    return {"meeting_id": meeting_id, **answer}


@app.get("/api/meetings/{meeting_id}/memory/status", tags=["memory"])
def meeting_memory_extraction_status(
    meeting_id: str,
    db: Session = Depends(get_db),
) -> dict[str, object]:
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting session not found.")
    existing = MEMORY_EXTRACTION_JOBS.get(meeting_id)
    if existing is not None:
        return dict(existing)
    return {
        "meeting_id": meeting_id,
        "status": "not_started",
        "item_count": 0,
        "automatic_extraction": bool(settings.memory_auto_extract_on_end),
        "message": (
            "Memory extraction will start automatically when the meeting ends."
            if meeting.status == "active" and settings.memory_auto_extract_on_end
            else "No automatic memory extraction job has run for this meeting yet."
        ),
    }


@app.get(
    "/api/meetings/{meeting_id}/memory",
    response_model=list[MemoryItemRead],
    tags=["memory"],
)
def list_meeting_memory(
    meeting_id: str,
    item_type: str | None = Query(default=None),
    db: Session = Depends(get_db),
) -> list[MemoryItem]:
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting session not found.")
    if not _memory_schema_ready(db.get_bind()):
        raise HTTPException(status_code=503, detail=_memory_migration_message())

    valid_types = {
        "topic", "fact", "entity", "proposal", "argument", "question",
        "open_question", "decision", "action_item", "event", "person",
    }
    if item_type is not None and item_type not in valid_types:
        raise HTTPException(status_code=422, detail="Unsupported memory item type.")

    statement = select(MemoryItem).where(MemoryItem.meeting_id == meeting_id)
    if item_type is not None:
        statement = statement.where(MemoryItem.item_type == item_type)
    statement = statement.order_by(MemoryItem.start_seconds, MemoryItem.item_type, MemoryItem.created_at)
    return list(db.scalars(statement).all())


@app.post(
    "/api/meetings/{meeting_id}/memory/extract",
    response_model=MemoryExtractionResponse,
    tags=["memory"],
)
async def extract_meeting_memory(
    meeting_id: str,
    db: Session = Depends(get_db),
    session_factory: sessionmaker[Session] = Depends(get_session_factory),
) -> dict[str, object]:
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting session not found.")
    if not _memory_schema_ready(db.get_bind()):
        raise HTTPException(status_code=503, detail=_memory_migration_message())
    # Do not hold the request's database connection open while the LLM provider runs.
    db.close()
    api_key = settings.memory_api_key
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="Structured memory extraction is not configured. Add GROQ_API_KEY to the repository-root .env file and restart FastAPI.",
        )

    try:
        result = await process_meeting_transcript_memory(
            session_factory,
            meeting_id,
            api_key=api_key,
            model=settings.memory_model,
            base_url=settings.memory_base_url,
        )
    except Exception as exc:
        logger.exception("Manual memory extraction failed for meeting %s", meeting_id)
        raise HTTPException(
            status_code=502,
            detail="The structured-memory provider failed. Check the server log and API configuration.",
        ) from exc

    return {
        "meeting_id": meeting_id,
        "processed_segments": int(result["processed_segments"]),
        "item_count": len(result["items"]),
        "items": result["items"],
    }


def _persist_final_segment(
    session_factory: sessionmaker[Session],
    meeting_id: str,
    *,
    text_value: str,
    start_seconds: float,
    end_seconds: float,
    speaker_id: int | None,
    audio_channel: int | None,
    confidence: float | None,
    words: list[dict[str, object]],
) -> dict[str, object]:
    with session_factory() as session:
        meeting = session.get(Meeting, meeting_id)
        if meeting is None:
            raise RuntimeError("Meeting session no longer exists.")
        # A stop request can race with the HTTP end-session request. Final
        # provider results from audio already captured must still be preserved.
        segment = TranscriptSegment(
            meeting_id=meeting_id,
            text=text_value,
            start_seconds=max(0.0, start_seconds),
            end_seconds=max(start_seconds, end_seconds),
            speaker_id=speaker_id,
            audio_channel=audio_channel,
            confidence=confidence,
            words=words or None,
        )
        session.add(segment)
        session.commit()
        session.refresh(segment)
        return {
            "id": segment.id,
            "meeting_id": segment.meeting_id,
            "text": segment.text,
            "start_seconds": segment.start_seconds,
            "end_seconds": segment.end_seconds,
            "speaker_id": segment.speaker_id,
            "audio_channel": segment.audio_channel,
            "confidence": segment.confidence,
            "words": segment.words,
            "created_at": segment.created_at.isoformat(),
            "is_final": True,
        }


async def _read_deepgram_results(
    upstream: ClientConnection,
    websocket: WebSocket,
    meeting_id: str,
    session_factory: sessionmaker[Session],
    send_lock: asyncio.Lock,
    audio_timeline: AudioTimeline,
) -> None:
    async def send_to_browser(payload: dict[str, object]) -> None:
        async with send_lock:
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.send_json(payload)

    last_interim_log_at = 0.0
    try:
        async for raw in upstream:
            try:
                result = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                logger.warning("Ignoring invalid Deepgram response for meeting %s", meeting_id)
                continue

            if result.get("type") == "Error":
                detail = str(result.get("description") or result.get("message") or "Transcription provider error.")
                logger.error("Deepgram error for meeting %s: %s", meeting_id, detail)
                await send_to_browser({"type": "transcription.error", "message": detail})
                continue

            if result.get("type") != "Results":
                if result.get("type") in {"Metadata", "SpeechStarted", "UtteranceEnd", "CloseStream"}:
                    logger.debug("Deepgram event for meeting %s: %s", meeting_id, result.get("type"))
                continue

            channel_payload = result.get("channel") or {}
            channels = channel_payload.get("alternatives", [])
            if not channels:
                continue
            alternative = channels[0]
            transcript = str(alternative.get("transcript") or "").strip()
            if not transcript:
                logger.debug(
                    "Deepgram returned an empty transcript result: meeting_id=%s final=%s speech_final=%s",
                    meeting_id, result.get("is_final"), result.get("speech_final"),
                )
                continue

            try:
                stream_start_seconds = float(result.get("start") or 0.0)
                duration = max(0.0, float(result.get("duration") or 0.0))
            except (TypeError, ValueError):
                stream_start_seconds, duration = 0.0, 0.0
            # The desktop app suppresses long silent stretches before they reach Deepgram
            # to avoid paying for silence. Restore those gaps so transcript timestamps
            # still line up with the real meeting elapsed time.
            start_seconds = audio_timeline.map_time(stream_start_seconds)
            end_seconds = max(start_seconds, audio_timeline.map_time(stream_start_seconds + duration))
            is_final = bool(result.get("is_final"))
            speech_final = bool(result.get("speech_final"))
            raw_words = alternative.get("words") or []
            words = [word for word in raw_words if isinstance(word, dict)]
            speaker_values = [word.get("speaker") for word in words if word.get("speaker") is not None]
            speaker_id = int(speaker_values[0]) if speaker_values else None
            # Deepgram returns [channel_number, total_channels]. Persist the channel only
            # for split-channel audio, where channel 0 is meeting playback and channel 1
            # is the local microphone. A mono mixed stream has no trustworthy source label.
            channel_index = result.get("channel_index")
            audio_channel: int | None = None
            if audio_timeline.channels > 1 and isinstance(channel_index, list) and channel_index:
                try:
                    candidate_channel = int(channel_index[0])
                    if 0 <= candidate_channel < audio_timeline.channels:
                        audio_channel = candidate_channel
                except (TypeError, ValueError):
                    audio_channel = None
            confidence_value = alternative.get("confidence")
            confidence = float(confidence_value) if isinstance(confidence_value, (int, float)) else None

            if is_final:
                logger.info(
                    "Deepgram final transcript received: meeting_id=%s speech_final=%s chars=%d languages=%s",
                    meeting_id, speech_final, len(transcript), alternative.get("languages") or [],
                )
            else:
                # Interim hypotheses are sent about once per second. Log only a
                # rate-limited, text-free heartbeat so latency can be diagnosed
                # without copying private meeting content into backend logs.
                now = time.monotonic()
                if now - last_interim_log_at >= 2.0:
                    logger.info(
                        "Deepgram interim transcript update: meeting_id=%s chars=%d languages=%s",
                        meeting_id, len(transcript), alternative.get("languages") or [],
                    )
                    last_interim_log_at = now

            if is_final:
                # A result can contain several people. Split it at speaker changes so each
                # persisted segment has exactly one speaker label.
                runs = split_words_by_speaker(words)
                if len(runs) > 1:
                    pieces = []
                    for run in runs:
                        piece_start = audio_timeline.map_time(run.start) if run.start is not None else start_seconds
                        piece_end = audio_timeline.map_time(run.end) if run.end is not None else end_seconds
                        pieces.append({
                            "text": run.text,
                            "start": max(start_seconds, piece_start),
                            "end": max(piece_start, piece_end),
                            "speaker_id": run.speaker_id,
                            "words": run.words,
                        })
                else:
                    pieces = [{
                        "text": transcript, "start": start_seconds, "end": end_seconds,
                        "speaker_id": speaker_id, "words": words,
                    }]
                for piece in pieces:
                    try:
                        segment = _persist_final_segment(
                            session_factory,
                            meeting_id,
                            text_value=piece["text"],
                            start_seconds=piece["start"],
                            end_seconds=piece["end"],
                            speaker_id=piece["speaker_id"],
                            audio_channel=audio_channel,
                            confidence=confidence,
                            words=piece["words"],
                        )
                    except Exception:
                        logger.exception("Could not persist transcript segment for meeting %s", meeting_id)
                        await send_to_browser({"type": "transcription.error", "message": "A finalized transcript segment could not be saved."})
                        continue
                    await send_to_browser({
                        "type": "transcript.segment",
                        "meeting_id": meeting_id,
                        "segment": segment,
                        "is_final": True,
                        "speech_final": speech_final,
                    })
                continue

            # Interim results are transient; label them with the most recent speaker.
            interim_speaker = int(speaker_values[-1]) if speaker_values else None
            segment = {
                "id": f"interim-{start_seconds:.3f}",
                "meeting_id": meeting_id,
                "text": transcript,
                "start_seconds": start_seconds,
                "end_seconds": end_seconds,
                "speaker_id": interim_speaker,
                "audio_channel": audio_channel,
                "confidence": confidence,
                "words": words or None,
                "is_final": False,
            }
            await send_to_browser({
                "type": "transcript.segment",
                "meeting_id": meeting_id,
                "segment": segment,
                "is_final": False,
                "speech_final": speech_final,
            })

    except ConnectionClosed as exc:
        logger.warning(
            "Deepgram streaming WebSocket closed: meeting_id=%s close_code=%s close_reason=%s",
            meeting_id, getattr(exc, "code", None), getattr(exc, "reason", None),
        )
        if getattr(exc, "code", None) not in {1000, 1001}:
            try:
                await send_to_browser({
                    "type": "transcription.error",
                    "code": "deepgram_stream_closed",
                    "message": "Deepgram closed the transcription stream before more transcript results arrived. Check the selected audio source and restart capture.",
                })
            except Exception:
                pass
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.exception("Deepgram receiver failed for meeting %s", meeting_id)
        try:
            await send_to_browser({"type": "transcription.error", "message": "The transcription stream disconnected. Stop and restart capture."})
        except Exception:
            pass


@app.websocket("/ws/meeting/{meeting_id}")
async def meeting_websocket(
    websocket: WebSocket,
    meeting_id: str,
    session_factory: sessionmaker[Session] = Depends(get_session_factory),
) -> None:
    await websocket.accept()
    with session_factory() as session:
        memory_schema_ready = _memory_schema_ready(session.get_bind())
        meeting = session.get(Meeting, meeting_id)
        if meeting is None:
            await websocket.send_json({"type": "error", "message": "Meeting session not found."})
            await websocket.close(code=4404, reason="Meeting session not found")
            return
        if meeting.status != "active":
            await websocket.send_json({"type": "error", "message": "This meeting session has ended."})
            await websocket.close(code=4409, reason="Meeting session has ended")
            return
        meeting_title = meeting.title

    await websocket.send_json({"type": "connection.established", "meeting_id": meeting_id, "title": meeting_title})
    logger.info("WebSocket connected: meeting_id=%s title=%r", meeting_id, meeting_title)

    upstream: ClientConnection | None = None
    stream_counted = False
    transcription_task: asyncio.Task[None] | None = None
    keepalive_task: asyncio.Task[None] | None = None
    upstream_send_lock = asyncio.Lock()
    audio_timeline = AudioTimeline()
    send_lock = asyncio.Lock()
    audio_chunk_count = 0
    # Cost control: Groq is never called from this WebSocket. Extraction runs once
    # after the meeting is ended and the final transcript has been flushed.

    async def send_to_browser(payload: dict[str, object]) -> None:
        async with send_lock:
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.send_json(payload)

    async def finish_transcription_stream() -> None:
        nonlocal upstream, stream_counted, transcription_task, keepalive_task
        current_upstream = upstream
        current_task = transcription_task
        current_keepalive = keepalive_task
        current_stream_counted = stream_counted
        upstream = None
        stream_counted = False
        transcription_task = None
        keepalive_task = None
        try:
            if current_keepalive is not None:
                current_keepalive.cancel()
                try:
                    await current_keepalive
                except asyncio.CancelledError:
                    pass
            if current_upstream is not None:
                try:
                    async with upstream_send_lock:
                        await current_upstream.send(json.dumps({"type": "Finalize"}))
                        await current_upstream.send(json.dumps({"type": "CloseStream"}))
                except Exception:
                    logger.info("Could not gracefully finalize Deepgram stream for %s", meeting_id)
                try:
                    if current_task is not None:
                        await asyncio.wait_for(current_task, timeout=5.0)
                except asyncio.TimeoutError:
                    if current_task is not None:
                        current_task.cancel()
                except asyncio.CancelledError:
                    pass
                except Exception:
                    logger.exception("Error finalizing transcription task for %s", meeting_id)
                try:
                    await current_upstream.close()
                except Exception:
                    pass
        finally:
            # Keep the stream marked active until Deepgram finalization/close has
            # completed. audio.stop is acknowledged only after this decrement.
            if current_stream_counted:
                _mark_audio_stream_stopped(meeting_id)

    ACTIVE_MEETING_CONNECTIONS[meeting_id] = ACTIVE_MEETING_CONNECTIONS.get(meeting_id, 0) + 1
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break

            text_data = message.get("text")
            if text_data is not None:
                try:
                    payload = json.loads(text_data)
                except json.JSONDecodeError:
                    await send_to_browser({"type": "error", "message": "Send a valid JSON message."})
                    continue
                if not isinstance(payload, dict):
                    await send_to_browser({"type": "error", "message": "The JSON message must be an object."})
                    continue

                message_type = payload.get("type", "unknown")
                if message_type == "ping":
                    await send_to_browser({"type": "pong", "meeting_id": meeting_id})
                    continue

                if message_type == "audio.start":
                    if upstream is not None:
                        await send_to_browser({"type": "error", "message": "Transcription is already running for this meeting connection."})
                        continue
                    api_key = (settings.deepgram_api_key or "").strip()
                    if not api_key:
                        await send_to_browser({
                            "type": "transcription.error",
                            "code": "transcription_not_configured",
                            "message": "Real-time transcription is not configured. Add DEEPGRAM_API_KEY to the repository root .env and restart FastAPI.",
                        })
                        continue

                    query_params: list[tuple[str, str]] = [
                        ("model", settings.deepgram_model),
                        ("language", settings.deepgram_language),
                        ("interim_results", "true"),
                        ("punctuate", "true"),
                        ("smart_format", "true"),
                        ("diarize_model", "latest"),
                        ("endpointing", "300"),
                        ("utterance_end_ms", "1000"),
                        ("vad_events", "true"),
                    ]
                    query_params.extend(keyterm_params(settings.deepgram_model, settings.keyterms))
                    language_note = language_warning(settings.deepgram_language, settings.language_hints)
                    if language_note:
                        logger.warning(language_note)
                    logger.info(
                        "Opening Deepgram stream: model=%s language=%s hints=%s keyterms=%d",
                        settings.deepgram_model, settings.deepgram_language,
                        ",".join(settings.language_hints) or "none", len(settings.keyterms),
                    )
                    # Desktop sends split-source stereo PCM; browser capture can send a
                    # stereo WebM/Opus container when meeting audio and mic are separate.
                    audio_format = str(payload.get("audio_format") or "container").lower()
                    sample_rate = 48000
                    channels = 1
                    wants_multichannel = str(payload.get("multichannel", "false")).lower() in {"true", "1", "yes"}
                    if audio_format == "linear16":
                        try:
                            sample_rate = int(payload.get("sample_rate") or 48000)
                            channels = int(payload.get("channels") or 1)
                        except (TypeError, ValueError):
                            await send_to_browser({
                                "type": "transcription.error",
                                "code": "invalid_audio_format",
                                "message": "PCM audio sample_rate and channels must be integers.",
                            })
                            continue
                        if sample_rate < 8000 or sample_rate > 96000 or channels not in {1, 2}:
                            await send_to_browser({
                                "type": "transcription.error",
                                "code": "invalid_audio_format",
                                "message": "PCM audio must use a sample rate from 8000 to 96000 Hz and 1 or 2 channels.",
                            })
                            continue
                        query_params.extend([
                            ("encoding", "linear16"),
                            ("sample_rate", str(sample_rate)),
                            ("channels", str(channels)),
                        ])
                    elif audio_format == "container":
                        try:
                            declared_channels = int(payload.get("channels") or 1)
                        except (TypeError, ValueError):
                            await send_to_browser({
                                "type": "transcription.error",
                                "code": "invalid_audio_format",
                                "message": "Container audio channels must be an integer.",
                            })
                            continue
                        if declared_channels not in {1, 2} or (wants_multichannel and declared_channels != 2):
                            await send_to_browser({
                                "type": "transcription.error",
                                "code": "invalid_audio_format",
                                "message": "Container audio must declare one channel, or two channels when multichannel is enabled.",
                            })
                            continue
                        channels = declared_channels
                    else:
                        await send_to_browser({
                            "type": "transcription.error",
                            "code": "unsupported_audio_format",
                            "message": "Unsupported audio_format. Use 'container' for browser audio or 'linear16' for signed PCM.",
                        })
                        continue

                    if wants_multichannel:
                        if channels != 2:
                            await send_to_browser({
                                "type": "transcription.error",
                                "code": "invalid_audio_format",
                                "message": "Multichannel transcription requires a two-channel audio stream.",
                            })
                            continue
                        if audio_format == "container":
                            # Container formats still need the declared channel count for
                            # Deepgram to decode and transcribe each audio track separately.
                            query_params.append(("channels", "2"))
                        query_params.append(("multichannel", "true"))
                    if settings.deepgram_language.strip().lower() == "multi":
                        query_params.extend(("language_hint", hint) for hint in settings.language_hints)
                    query = urlencode(query_params)
                    url = f"wss://api.deepgram.com/v1/listen?{query}"
                    try:
                        upstream = await upstream_connect(
                            url,
                            additional_headers={"Authorization": f"Token {api_key}"},
                            open_timeout=15,
                            ping_interval=20,
                            ping_timeout=20,
                            max_size=10_000_000,
                        )
                    except Exception as exc:
                        upstream = None
                        logger.exception("Could not open Deepgram stream for meeting %s", meeting_id)
                        status_code = getattr(getattr(exc, "response", None), "status_code", None)
                        if status_code in {401, 403}:
                            detail = "Deepgram rejected the API key. Check DEEPGRAM_API_KEY in .env."
                        else:
                            detail = "Could not connect to Deepgram. Check the API key, internet connection, and provider service."
                        await send_to_browser({"type": "transcription.error", "code": "transcription_connection_failed", "message": detail})
                        continue

                    with session_factory() as session:
                        current_meeting = session.get(Meeting, meeting_id)
                        if current_meeting is None or current_meeting.status != "active":
                            await upstream.close()
                            upstream = None
                            await send_to_browser({"type": "error", "message": "This meeting session is no longer active."})
                            await websocket.close(code=4409, reason="Meeting session has ended")
                            return
                        source = payload.get("source")
                        if source in {"tab", "desktop", "microphone", "desktop_auto", "web_auto"}:
                            current_meeting.audio_source = source
                            session.commit()

                    audio_timeline.reset(
                        raw_pcm=audio_format == "linear16",
                        sample_rate=sample_rate,
                        channels=channels,
                    )
                    # Resuming capture in an existing session must continue the meeting clock
                    # instead of restarting timestamps at zero.
                    audio_timeline.base_offset = _resume_offset_seconds(session_factory, meeting_id)
                    transcription_task = asyncio.create_task(
                        _read_deepgram_results(
                            upstream,
                            websocket,
                            meeting_id,
                            session_factory,
                            send_lock,
                            audio_timeline,
                        )
                    )
                    _mark_audio_stream_started(meeting_id)
                    stream_counted = True
                    keepalive_task = asyncio.create_task(
                        _keep_deepgram_alive(upstream, upstream_send_lock, meeting_id)
                    )
                    await send_to_browser({"type": "transcription.ready", "meeting_id": meeting_id, "provider": "deepgram", "model": settings.deepgram_model})
                    logger.info(
                        "Deepgram streaming WebSocket connected: meeting_id=%s source=%s mime_type=%s model=%s language=%s channels=%s multichannel=%s; one streaming session, not one REST request per audio chunk",
                        meeting_id, payload.get("source"), payload.get("mime_type", "unknown"),
                        settings.deepgram_model, settings.deepgram_language, channels, wants_multichannel,
                    )
                    if str(payload.get("audio_format") or "container").lower() == "linear16":
                        logger.info(
                            "Raw PCM stream configured: meeting_id=%s sample_rate=%s channels=%s multichannel=%s encoding=linear16",
                            meeting_id, payload.get("sample_rate", 48000), payload.get("channels", 1), wants_multichannel,
                        )
                    await send_to_browser({"type": "message.received", "meeting_id": meeting_id, "message_type": "audio.start"})
                    continue

                if message_type == "audio.stop":
                    await finish_transcription_stream()
                    await send_to_browser({"type": "message.received", "meeting_id": meeting_id, "message_type": "audio.stop"})
                    continue

                await send_to_browser({"type": "message.received", "meeting_id": meeting_id, "message_type": message_type})
                continue

            audio_chunk = message.get("bytes")
            if audio_chunk is not None:
                if len(audio_chunk) > MAX_AUDIO_CHUNK_BYTES:
                    await send_to_browser({"type": "error", "message": f"Audio chunk exceeds {MAX_AUDIO_CHUNK_BYTES} bytes."})
                    continue
                if upstream is None:
                    await send_to_browser({"type": "error", "code": "transcription_stream_not_started", "message": "Start audio capture after transcription is ready. Check that DEEPGRAM_API_KEY is configured."})
                    continue
                try:
                    async with upstream_send_lock:
                        await upstream.send(audio_chunk)
                    audio_timeline.record_chunk(len(audio_chunk))
                except Exception:
                    logger.exception("Could not forward audio chunk to Deepgram for meeting %s", meeting_id)
                    await send_to_browser({"type": "transcription.error", "message": "Could not forward audio to the transcription provider. Stop and restart capture."})
                    continue

                audio_chunk_count += 1
                if audio_chunk_count == 1 or audio_chunk_count % 10 == 0 or len(audio_chunk) > 1000:
                    logger.info(
                        "Audio forwarded to Deepgram: meeting_id=%s chunks=%d latest_byte_length=%d",
                        meeting_id, audio_chunk_count, len(audio_chunk),
                    )
                else:
                    logger.debug(
                        "Small audio chunk forwarded: meeting_id=%s chunk_number=%d byte_length=%d",
                        meeting_id, audio_chunk_count, len(audio_chunk),
                    )
                await send_to_browser({
                    "type": "audio.chunk.received",
                    "meeting_id": meeting_id,
                    "byte_length": len(audio_chunk),
                    "transcription_status": "streaming",
                })
    except WebSocketDisconnect:
        logger.info("Meeting WebSocket disconnected: %s", meeting_id)
    finally:
        remaining = ACTIVE_MEETING_CONNECTIONS.get(meeting_id, 1) - 1
        if remaining > 0:
            ACTIVE_MEETING_CONNECTIONS[meeting_id] = remaining
        else:
            ACTIVE_MEETING_CONNECTIONS.pop(meeting_id, None)
        await finish_transcription_stream()
