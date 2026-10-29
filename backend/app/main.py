import asyncio
import json
import logging
from urllib.parse import urlencode
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.database import engine, get_db, get_session_factory
from app.models import Meeting, TranscriptSegment
from app.schemas import MeetingCreate, MeetingRead, TranscriptSegmentRead
from starlette.websockets import WebSocketState
from websockets.asyncio.client import ClientConnection, connect as upstream_connect
from websockets.exceptions import ConnectionClosed


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
MAX_AUDIO_CHUNK_BYTES = 2_000_000

app = FastAPI(
    title=settings.app_name,
    version="0.2.0",
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


@app.post("/api/meetings", response_model=MeetingRead, status_code=201, tags=["meetings"])
def create_meeting(payload: MeetingCreate, db: Session = Depends(get_db)) -> Meeting:
    meeting = Meeting(title=payload.title)
    db.add(meeting)
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


@app.post(
    "/api/meetings/{meeting_id}/end",
    response_model=MeetingRead,
    tags=["meetings"],
)
def end_meeting(meeting_id: str, db: Session = Depends(get_db)) -> Meeting:
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting session not found.")

    if meeting.status == "active":
        meeting.status = "ended"
        meeting.ended_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(meeting)

    return meeting


@app.get("/api/transcription/status", tags=["transcription"])
def transcription_status() -> dict[str, object]:
    return {
        "provider": "deepgram",
        "configured": bool(settings.deepgram_api_key and settings.deepgram_api_key.strip()),
        "model": settings.deepgram_model,
        "language": settings.deepgram_language,
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


def _persist_final_segment(
    session_factory: sessionmaker[Session],
    meeting_id: str,
    *,
    text_value: str,
    start_seconds: float,
    end_seconds: float,
    speaker_id: int | None,
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
) -> None:
    async def send_to_browser(payload: dict[str, object]) -> None:
        async with send_lock:
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.send_json(payload)

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
                continue

            channel_payload = result.get("channel") or {}
            channels = channel_payload.get("alternatives", [])
            if not channels:
                continue
            alternative = channels[0]
            transcript = str(alternative.get("transcript") or "").strip()
            if not transcript:
                continue

            try:
                start_seconds = float(result.get("start") or 0.0)
                duration = float(result.get("duration") or 0.0)
            except (TypeError, ValueError):
                start_seconds, duration = 0.0, 0.0
            end_seconds = start_seconds + max(0.0, duration)
            is_final = bool(result.get("is_final"))
            speech_final = bool(result.get("speech_final"))
            raw_words = alternative.get("words") or []
            words = [word for word in raw_words if isinstance(word, dict)]
            speaker_values = [word.get("speaker") for word in words if word.get("speaker") is not None]
            speaker_id = int(speaker_values[0]) if speaker_values else None
            confidence_value = alternative.get("confidence")
            confidence = float(confidence_value) if isinstance(confidence_value, (int, float)) else None

            if is_final:
                try:
                    segment = _persist_final_segment(
                        session_factory,
                        meeting_id,
                        text_value=transcript,
                        start_seconds=start_seconds,
                        end_seconds=end_seconds,
                        speaker_id=speaker_id,
                        confidence=confidence,
                        words=words,
                    )
                except Exception:
                    logger.exception("Could not persist transcript segment for meeting %s", meeting_id)
                    await send_to_browser({"type": "transcription.error", "message": "A finalized transcript segment could not be saved."})
                    continue
            else:
                segment = {
                    "id": f"interim-{start_seconds:.3f}",
                    "meeting_id": meeting_id,
                    "text": transcript,
                    "start_seconds": start_seconds,
                    "end_seconds": end_seconds,
                    "speaker_id": speaker_id,
                    "confidence": confidence,
                    "words": words or None,
                    "is_final": False,
                }

            await send_to_browser({
                "type": "transcript.segment",
                "meeting_id": meeting_id,
                "segment": segment,
                "is_final": is_final,
                "speech_final": speech_final,
            })
    except ConnectionClosed:
        logger.info("Deepgram stream closed for meeting %s", meeting_id)
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
    transcription_task: asyncio.Task[None] | None = None
    send_lock = asyncio.Lock()
    audio_chunk_count = 0

    async def send_to_browser(payload: dict[str, object]) -> None:
        async with send_lock:
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.send_json(payload)

    async def finish_transcription_stream() -> None:
        nonlocal upstream, transcription_task
        current_upstream = upstream
        current_task = transcription_task
        upstream = None
        transcription_task = None
        if current_upstream is not None:
            try:
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
            except Exception:
                logger.exception("Error finalizing transcription task for %s", meeting_id)
            try:
                await current_upstream.close()
            except Exception:
                pass

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

                    query = urlencode({
                        "model": settings.deepgram_model,
                        "language": settings.deepgram_language,
                        "interim_results": "true",
                        "punctuate": "true",
                        "smart_format": "true",
                        "diarize_model": "latest",
                        "endpointing": "300",
                        "utterance_end_ms": "1000",
                        "vad_events": "true",
                    })
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
                        if source in {"tab", "microphone"}:
                            current_meeting.audio_source = source
                            session.commit()

                    transcription_task = asyncio.create_task(
                        _read_deepgram_results(upstream, websocket, meeting_id, session_factory, send_lock)
                    )
                    await send_to_browser({"type": "transcription.ready", "meeting_id": meeting_id, "provider": "deepgram", "model": settings.deepgram_model})
                    logger.info("Deepgram stream started: meeting_id=%s source=%s mime_type=%s", meeting_id, payload.get("source"), payload.get("mime_type", "unknown"))
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
                    await upstream.send(audio_chunk)
                except Exception:
                    logger.exception("Could not forward audio chunk to Deepgram for meeting %s", meeting_id)
                    await send_to_browser({"type": "transcription.error", "message": "Could not forward audio to the transcription provider. Stop and restart capture."})
                    continue

                audio_chunk_count += 1
                logger.info("Audio chunk forwarded: meeting_id=%s chunk_number=%d byte_length=%d", meeting_id, audio_chunk_count, len(audio_chunk))
                await send_to_browser({
                    "type": "audio.chunk.received",
                    "meeting_id": meeting_id,
                    "byte_length": len(audio_chunk),
                    "transcription_status": "streaming",
                })
    except WebSocketDisconnect:
        logger.info("Meeting WebSocket disconnected: %s", meeting_id)
    finally:
        await finish_transcription_stream()
