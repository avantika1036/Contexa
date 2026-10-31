import asyncio
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db, get_session_factory
from app.main import app
from app.models import Meeting, MemoryItem, TranscriptSegment  # noqa: F401 - register mapped models for test schema
from app.config import settings


@pytest.fixture
def client(monkeypatch):
    from app import main as main_module
    main_module.MEMORY_EXTRACTION_JOBS.clear()
    # Automated tests must never call a billable external LLM, even if a real key
    # is present in the developer's local .env file.
    monkeypatch.setattr(settings, "groq_api_key", None)
    monkeypatch.setattr(settings, "xai_api_key", None)
    test_engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=test_engine)
    testing_session_local = sessionmaker(
        bind=test_engine,
        autoflush=False,
        autocommit=False,
    )

    def override_get_db():
        with testing_session_local() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_session_factory] = lambda: testing_session_local
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(bind=test_engine)
        test_engine.dispose()


def create_session(client: TestClient, title: str = "Test meeting") -> dict:
    response = client.post("/api/meetings", json={"title": title})
    assert response.status_code == 201, response.text
    return response.json()


def test_health_endpoint(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "contexa-api"}


def test_create_and_list_meetings(client: TestClient) -> None:
    created = create_session(client, "Design review")
    assert created["title"] == "Design review"
    assert created["status"] == "active"
    assert created["id"]
    assert created["ended_at"] is None

    response = client.get("/api/meetings")
    assert response.status_code == 200
    assert len(response.json()) == 1
    assert response.json()[0]["id"] == created["id"]


def test_blank_meeting_title_is_rejected(client: TestClient) -> None:
    response = client.post("/api/meetings", json={"title": "   "})
    assert response.status_code == 422


def test_end_meeting_is_idempotent(client: TestClient) -> None:
    created = create_session(client)
    first = client.post(f"/api/meetings/{created['id']}/end")
    second = client.post(f"/api/meetings/{created['id']}/end")

    assert first.status_code == 200
    assert first.json()["status"] == "ended"
    assert first.json()["ended_at"] is not None
    assert second.status_code == 200
    assert second.json()["status"] == "ended"


def test_ending_meeting_schedules_one_batched_memory_extraction(client: TestClient, monkeypatch) -> None:
    from app import main as main_module

    meeting = create_session(client, "Auto extraction at end")
    monkeypatch.setattr(settings, "memory_auto_extract_on_end", True)
    monkeypatch.setattr(settings, "groq_api_key", "test-groq-key")
    monkeypatch.setattr(settings, "xai_api_key", None)
    monkeypatch.setattr(main_module, "_memory_schema_ready", lambda bind=main_module.engine: True)
    calls: list[str] = []

    async def fake_process_meeting(factory, meeting_id, **kwargs):
        calls.append(meeting_id)
        return {"processed_segments": 0, "items": []}

    monkeypatch.setattr(main_module, "process_meeting_transcript_memory", fake_process_meeting)

    first = client.post(f"/api/meetings/{meeting['id']}/end")
    second = client.post(f"/api/meetings/{meeting['id']}/end")

    assert first.status_code == 200
    assert first.json()["status"] == "ended"
    assert second.status_code == 200
    assert calls == [meeting["id"]]
    job_status = client.get(f"/api/meetings/{meeting['id']}/memory/status").json()
    assert job_status["status"] == "skipped"
    assert "No transcript segments" in job_status["message"]


def test_ending_unknown_meeting_returns_404(client: TestClient) -> None:
    response = client.post("/api/meetings/not-a-real-session/end")
    assert response.status_code == 404


def test_websocket_ping_pong(client: TestClient) -> None:
    meeting = create_session(client, "WebSocket test")
    with client.websocket_connect(f"/ws/meeting/{meeting['id']}") as websocket:
        connected = websocket.receive_json()
        assert connected["type"] == "connection.established"
        assert connected["meeting_id"] == meeting["id"]
        websocket.send_json({"type": "ping"})
        assert websocket.receive_json()["type"] == "pong"


def test_websocket_rejects_audio_without_transcription_stream(client: TestClient) -> None:
    meeting = create_session(client, "Audio test")
    with client.websocket_connect(f"/ws/meeting/{meeting['id']}") as websocket:
        websocket.receive_json()
        websocket.send_bytes(b"test-audio")
        response = websocket.receive_json()
        assert response["type"] == "error"
        assert response["code"] == "transcription_stream_not_started"


class FakeDeepgramConnection:
    def __init__(self, emit_transcript: bool = False, channel_index: list[int] | None = None) -> None:
        self.sent: list[bytes | str] = []
        self.closed = False
        self.emit_transcript = emit_transcript
        self.channel_index = channel_index
        self.queue: asyncio.Queue[str | None] = asyncio.Queue()

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.queue.get()
        if item is None:
            raise StopAsyncIteration
        return item

    async def send(self, data):
        self.sent.append(data)
        if isinstance(data, bytes) and self.emit_transcript:
            import json
            interim_result = {
                "type": "Results", "start": 1.25, "duration": 0.8,
                "is_final": False, "speech_final": False,
                "channel": {"alternatives": [{
                    "transcript": "Hello everyone", "confidence": 0.88,
                    "words": [],
                }]},
            }
            final_result = {
                "type": "Results", "start": 1.25, "duration": 0.8,
                "is_final": True, "speech_final": True,
                "channel": {"alternatives": [{
                    "transcript": "Hello everyone.", "confidence": 0.97,
                    "words": [
                        {"word": "Hello", "start": 1.25, "end": 1.55, "confidence": 0.98, "speaker": 0},
                        {"word": "everyone.", "start": 1.56, "end": 2.05, "confidence": 0.95, "speaker": 0},
                    ],
                }]},
            }
            if self.channel_index is not None:
                interim_result["channel_index"] = self.channel_index
                final_result["channel_index"] = self.channel_index
            await self.queue.put(json.dumps(interim_result))
            await self.queue.put(json.dumps(final_result))
        if isinstance(data, str) and '"type": "CloseStream"' in data:
            await self.queue.put(None)

    async def close(self):
        self.closed = True
        await self.queue.put(None)


def test_websocket_forwards_audio_to_configured_provider(client: TestClient, monkeypatch) -> None:
    from app import main as main_module

    fake_provider = FakeDeepgramConnection()

    async def fake_connect(*args, **kwargs):
        return fake_provider

    monkeypatch.setattr(main_module.settings, "deepgram_api_key", "test-key")
    monkeypatch.setattr(main_module, "upstream_connect", fake_connect)

    meeting = create_session(client, "Audio relay test")
    with client.websocket_connect(f"/ws/meeting/{meeting['id']}") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "audio.start", "source": "microphone", "mime_type": "audio/webm;codecs=opus"})
        assert websocket.receive_json()["type"] == "transcription.ready"
        ack = websocket.receive_json()
        assert ack["message_type"] == "audio.start"
        websocket.send_bytes(b"test-audio")
        response = websocket.receive_json()
        assert response["type"] == "audio.chunk.received"
        assert response["meeting_id"] == meeting["id"]
        assert response["byte_length"] == len(b"test-audio")
        assert response["transcription_status"] == "streaming"
        assert b"test-audio" in fake_provider.sent


def test_final_streamed_transcript_is_persisted(client: TestClient, monkeypatch) -> None:
    from app import main as main_module

    fake_provider = FakeDeepgramConnection(emit_transcript=True)

    async def fake_connect(*args, **kwargs):
        return fake_provider

    monkeypatch.setattr(main_module.settings, "deepgram_api_key", "test-key")
    monkeypatch.setattr(main_module, "upstream_connect", fake_connect)
    meeting = create_session(client, "Transcript persistence test")

    with client.websocket_connect(f"/ws/meeting/{meeting['id']}") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "audio.start", "source": "microphone"})
        assert websocket.receive_json()["type"] == "transcription.ready"
        assert websocket.receive_json()["message_type"] == "audio.start"
        websocket.send_bytes(b"test-audio")
        
        received_events = []
        for _ in range(3):
            received_events.append(websocket.receive_json())
        transcript_events = [event for event in received_events if event["type"] == "transcript.segment"]
        assert any(event["type"] == "audio.chunk.received" for event in received_events)
        assert len(transcript_events) == 2
        interim = next(event for event in transcript_events if not event["is_final"])
        final = next(event for event in transcript_events if event["is_final"])
        assert interim["segment"]["text"] == "Hello everyone"
        assert interim["segment"]["is_final"] is False
        assert final["segment"]["text"] == "Hello everyone."
        assert final["segment"]["speaker_id"] == 0

    response = client.get(f"/api/meetings/{meeting['id']}/transcript")
    assert response.status_code == 200
    segments = response.json()
    assert len(segments) == 1
    assert segments[0]["text"] == "Hello everyone."
    assert segments[0]["start_seconds"] == 1.25
    assert segments[0]["speaker_id"] == 0
    assert segments[0]["is_final"] is True


def test_websocket_rejects_non_object_json(client: TestClient) -> None:
    meeting = create_session(client, "JSON test")
    with client.websocket_connect(f"/ws/meeting/{meeting['id']}") as websocket:
        websocket.receive_json()
        websocket.send_text('"hello"')
        assert websocket.receive_json()["type"] == "error"


def test_ended_meeting_rejects_websocket(client: TestClient) -> None:
    meeting = create_session(client, "Ended session")
    client.post(f"/api/meetings/{meeting['id']}/end")
    with client.websocket_connect(f"/ws/meeting/{meeting['id']}") as websocket:
        response = websocket.receive_json()
        assert response["type"] == "error"
        assert "ended" in response["message"].lower()


@pytest.mark.parametrize("audio_source", ["microphone", "desktop"])
def test_audio_source_is_saved_to_selected_session(client: TestClient, monkeypatch, audio_source: str) -> None:
    from app import main as main_module

    fake_provider = FakeDeepgramConnection()

    async def fake_connect(*args, **kwargs):
        return fake_provider

    monkeypatch.setattr(main_module.settings, "deepgram_api_key", "test-key")
    monkeypatch.setattr(main_module, "upstream_connect", fake_connect)
    meeting = create_session(client, f"Audio source test: {audio_source}")

    with client.websocket_connect(f"/ws/meeting/{meeting['id']}") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "audio.start", "source": audio_source})
        assert websocket.receive_json()["type"] == "transcription.ready"
        acknowledgement = websocket.receive_json()
        assert acknowledgement["message_type"] == "audio.start"

    result = client.get(f"/api/meetings/{meeting['id']}")
    assert result.status_code == 200
    assert result.json()["audio_source"] == audio_source


def test_desktop_auto_pcm_audio_uses_deepgram_raw_audio_parameters(client: TestClient, monkeypatch) -> None:
    from app import main as main_module

    fake_provider = FakeDeepgramConnection()
    observed: dict[str, object] = {}

    async def fake_connect(url, **kwargs):
        observed["url"] = url
        observed["headers"] = kwargs.get("additional_headers")
        return fake_provider

    monkeypatch.setattr(main_module.settings, "deepgram_api_key", "test-key")
    monkeypatch.setattr(main_module.settings, "deepgram_language", "multi")
    monkeypatch.setattr(main_module.settings, "deepgram_language_hints", "en,hi")
    monkeypatch.setattr(main_module, "upstream_connect", fake_connect)
    meeting = create_session(client, "Desktop Auto PCM test")

    with client.websocket_connect(f"/ws/meeting/{meeting['id']}") as websocket:
        websocket.receive_json()
        websocket.send_json({
            "type": "audio.start",
            "source": "desktop_auto",
            "audio_format": "linear16",
            "sample_rate": 48000,
            "channels": 2,
            "multichannel": True,
        })
        assert websocket.receive_json()["type"] == "transcription.ready"
        assert websocket.receive_json()["message_type"] == "audio.start"
        websocket.send_bytes(b"\x00\x00\x00\x00" * 4800)
        assert websocket.receive_json()["type"] == "audio.chunk.received"

    query = parse_qs(urlparse(str(observed["url"])).query)
    assert query["encoding"] == ["linear16"]
    assert query["sample_rate"] == ["48000"]
    assert query["channels"] == ["2"]
    assert query["multichannel"] == ["true"]
    assert query["language"] == ["multi"]
    assert query["language_hint"] == ["en", "hi"]
    assert query["diarize_model"] == ["latest"]
    assert "diarize" not in query
    assert observed["headers"] == {"Authorization": "Token test-key"}
    meeting_result = client.get(f"/api/meetings/{meeting['id']}").json()
    assert meeting_result["audio_source"] == "desktop_auto"


def test_browser_container_multichannel_declares_two_channels(client: TestClient, monkeypatch) -> None:
    from app import main as main_module

    fake_provider = FakeDeepgramConnection()
    observed: dict[str, object] = {}

    async def fake_connect(url, **kwargs):
        observed["url"] = url
        return fake_provider

    monkeypatch.setattr(main_module.settings, "deepgram_api_key", "test-key")
    monkeypatch.setattr(main_module.settings, "deepgram_language", "multi")
    monkeypatch.setattr(main_module, "upstream_connect", fake_connect)
    meeting = create_session(client, "Browser split-channel test")

    with client.websocket_connect(f"/ws/meeting/{meeting['id']}") as websocket:
        websocket.receive_json()
        websocket.send_json({
            "type": "audio.start", "source": "tab",
            "audio_format": "container", "mime_type": "audio/webm;codecs=opus",
            "channels": 2, "multichannel": True,
        })
        assert websocket.receive_json()["type"] == "transcription.ready"
        assert websocket.receive_json()["message_type"] == "audio.start"

    query = parse_qs(urlparse(str(observed["url"])).query)
    assert query["channels"] == ["2"]
    assert query["multichannel"] == ["true"]
    assert query["language"] == ["multi"]
    assert query["diarize_model"] == ["latest"]
    assert "encoding" not in query  # Container codecs are self-describing.


def test_split_audio_channel_is_persisted_for_local_microphone(client: TestClient, monkeypatch) -> None:
    from app import main as main_module

    fake_provider = FakeDeepgramConnection(emit_transcript=True, channel_index=[1, 2])

    async def fake_connect(*args, **kwargs):
        return fake_provider

    monkeypatch.setattr(main_module.settings, "deepgram_api_key", "test-key")
    monkeypatch.setattr(main_module, "upstream_connect", fake_connect)
    meeting = create_session(client, "Split-channel transcript test")

    with client.websocket_connect(f"/ws/meeting/{meeting['id']}") as websocket:
        websocket.receive_json()
        websocket.send_json({
            "type": "audio.start", "source": "desktop_auto",
            "audio_format": "linear16", "sample_rate": 48000,
            "channels": 2, "multichannel": True,
        })
        assert websocket.receive_json()["type"] == "transcription.ready"
        assert websocket.receive_json()["message_type"] == "audio.start"
        websocket.send_bytes(b"\x00\x00\x00\x00" * 4800)
        received_segment = None
        for _ in range(3):
            event = websocket.receive_json()
            if event.get("type") == "transcript.segment":
                received_segment = event["segment"]
                break
        assert received_segment is not None
        assert received_segment["audio_channel"] == 1

    persisted = client.get(f"/api/meetings/{meeting['id']}/transcript").json()
    assert len(persisted) == 1
    assert persisted[0]["audio_channel"] == 1


def test_transcription_status_reports_provider_configuration(client: TestClient) -> None:
    response = client.get("/api/transcription/status")
    assert response.status_code == 200
    assert response.json()["provider"] == "deepgram"
    assert isinstance(response.json()["configured"], bool)


def test_audio_start_reports_missing_transcription_key(client: TestClient, monkeypatch) -> None:
    from app import main as main_module

    monkeypatch.setattr(main_module.settings, "deepgram_api_key", None)
    meeting = create_session(client, "Missing STT key test")
    with client.websocket_connect(f"/ws/meeting/{meeting['id']}") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "audio.start", "source": "microphone"})
        response = websocket.receive_json()
        assert response["type"] == "transcription.error"
        assert response["code"] == "transcription_not_configured"
        assert "DEEPGRAM_API_KEY" in response["message"]


def test_transcript_endpoint_returns_empty_list_for_new_meeting(client: TestClient) -> None:
    meeting = create_session(client, "Transcript API test")
    response = client.get(f"/api/meetings/{meeting['id']}/transcript")
    assert response.status_code == 200
    assert response.json() == []


def test_transcript_endpoint_rejects_unknown_meeting(client: TestClient) -> None:
    response = client.get("/api/meetings/not-a-real-session/transcript")
    assert response.status_code == 404



def test_memory_status_reports_unconfigured_provider(client) -> None:
    response = client.get("/api/memory/status")

    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "groq"
    assert body["configured"] is False
    assert body["automatic_extraction"] is False
    assert "GROQ_API_KEY" in body["message"]


def test_memory_status_uses_manual_mode_when_provider_is_configured(client, monkeypatch) -> None:
    from app import main as main_module

    monkeypatch.setattr(settings, "groq_api_key", "test-groq-key")
    monkeypatch.setattr(settings, "xai_api_key", None)
    monkeypatch.setattr(settings, "memory_auto_extract_on_end", False)
    monkeypatch.setattr(main_module, "_memory_schema_ready", lambda bind=main_module.engine: True)

    response = client.get("/api/memory/status")

    assert response.status_code == 200
    body = response.json()
    assert body["configured"] is True
    assert body["provider"] == "groq"
    assert body["automatic_extraction"] is False
    assert body["extraction_timing"] == "manual"
    assert "manual mode" in body["message"]
    assert "No Groq requests are made during live capture" in body["message"]


def test_manual_memory_extraction_batches_more_segments_per_provider_call(client, monkeypatch) -> None:
    from app import memory_service

    meeting = create_session(client, "Large transcript batch test")
    factory = app.dependency_overrides[get_session_factory]()
    with factory() as session:
        for index in range(31):
            session.add(TranscriptSegment(
                meeting_id=meeting["id"],
                text=f"Meeting segment number {index} discusses the project plan.",
                start_seconds=float(index * 3),
                end_seconds=float(index * 3 + 2),
                speaker_id=0,
                confidence=0.95,
                words=None,
            ))
        session.commit()

    observed_batch_sizes: list[int] = []

    async def fake_extract(context_segments, **kwargs):
        observed_batch_sizes.append(len(context_segments))
        return []

    monkeypatch.setattr(memory_service, "extract_candidates", fake_extract)
    result = asyncio.run(memory_service.process_meeting_transcript_memory(
        factory, meeting["id"], api_key="test-key", model="test-model"
    ))

    assert result["processed_segments"] == 31
    assert observed_batch_sizes == [30, 5]


def test_memory_job_status_starts_automatically_and_reports_missing_meeting(client) -> None:
    meeting = create_session(client, "Memory job status")
    response = client.get(f"/api/meetings/{meeting['id']}/memory/status")
    assert response.status_code == 200
    assert response.json()["status"] == "not_started"
    assert "when the meeting ends" in response.json()["message"]

    missing = client.get("/api/meetings/not-a-real-session/memory/status")
    assert missing.status_code == 404


def test_memory_endpoint_returns_empty_list_for_new_meeting(client) -> None:
    meeting = create_session(client, "Memory empty test")
    response = client.get(f"/api/meetings/{meeting['id']}/memory")

    assert response.status_code == 200
    assert response.json() == []


def test_memory_endpoint_rejects_unknown_meeting(client) -> None:
    response = client.get("/api/meetings/not-a-real-session/memory")
    assert response.status_code == 404


def test_manual_memory_extraction_requires_groq_key(client) -> None:
    meeting = create_session(client, "Memory key check")
    response = client.post(f"/api/meetings/{meeting['id']}/memory/extract")

    assert response.status_code == 503
    assert "GROQ_API_KEY" in response.json()["detail"]


def test_save_memory_candidates_preserves_evidence_and_deduplicates(client) -> None:
    from app.memory_service import MemoryCandidate, save_memory_candidates

    meeting = create_session(client, "Memory persistence test")
    factory = app.dependency_overrides[get_session_factory]()
    with factory() as session:
        first = TranscriptSegment(
            meeting_id=meeting["id"],
            text="We should use Redis to reduce database load.",
            start_seconds=10.0,
            end_seconds=12.0,
            speaker_id=0,
            confidence=0.97,
            words=None,
        )
        second = TranscriptSegment(
            meeting_id=meeting["id"],
            text="We should benchmark Redis first.",
            start_seconds=18.0,
            end_seconds=20.0,
            speaker_id=0,
            confidence=0.96,
            words=None,
        )
        session.add_all([first, second])
        session.commit()
        session.refresh(first)
        session.refresh(second)
        first_id, second_id = first.id, second.id

    first_context = [
        {
            "id": first_id,
            "start_seconds": 10.0,
            "end_seconds": 12.0,
            "speaker_id": 0,
            "text": "We should use Redis to reduce database load.",
        }
    ]
    candidate_one = MemoryCandidate(
        item_type="proposal",
        title="Use Redis to reduce database load",
        content="Use Redis as a possible way to reduce database load.",
        status="proposed",
        owner=None,
        evidence_quote="We should use Redis to reduce database load.",
        source_segment_ids=[first_id],
        related_entities=["Redis"],
        confidence=0.91,
    )
    created = save_memory_candidates(
        factory, meeting["id"], first_context, [candidate_one], model_name="test-model"
    )
    assert len(created) == 1

    second_context = [
        {
            "id": second_id,
            "start_seconds": 18.0,
            "end_seconds": 20.0,
            "speaker_id": 0,
            "text": "We should benchmark Redis first.",
        }
    ]
    candidate_two = MemoryCandidate(
        item_type="proposal",
        title="Use Redis to reduce database load",
        content="Use Redis as a possible way to reduce database load, after benchmarking it.",
        status="proposed",
        owner=None,
        evidence_quote="We should benchmark Redis first.",
        source_segment_ids=[second_id],
        related_entities=["Redis"],
        confidence=0.92,
    )
    updated = save_memory_candidates(
        factory, meeting["id"], second_context, [candidate_two], model_name="test-model"
    )
    assert len(updated) == 1
    assert updated[0]["id"] == created[0]["id"]
    assert set(updated[0]["source_segment_ids"]) == {first_id, second_id}
    assert updated[0]["start_seconds"] == 10.0
    assert updated[0]["end_seconds"] == 20.0

    response = client.get(f"/api/meetings/{meeting['id']}/memory")
    assert response.status_code == 200
    items = response.json()
    assert len(items) == 1
    assert items[0]["item_type"] == "proposal"
    assert items[0]["source_segment_ids"] == [first_id, second_id]


def test_memory_extractor_does_not_persist_unsupported_evidence(client) -> None:
    from app.memory_service import MemoryCandidate, save_memory_candidates

    meeting = create_session(client, "Evidence guard test")
    factory = app.dependency_overrides[get_session_factory]()
    with factory() as session:
        segment = TranscriptSegment(
            meeting_id=meeting["id"],
            text="The team will review the results next week.",
            start_seconds=4.0,
            end_seconds=7.0,
            speaker_id=None,
            confidence=0.9,
            words=None,
        )
        session.add(segment)
        session.commit()
        session.refresh(segment)
        segment_id = segment.id

    context = [{
        "id": segment_id,
        "start_seconds": 4.0,
        "end_seconds": 7.0,
        "speaker_id": None,
        "text": "The team will review the results next week.",
    }]
    unsupported = MemoryCandidate(
        item_type="decision",
        title="Deploy the system on Friday",
        content="The team decided to deploy on Friday.",
        status="accepted",
        owner=None,
        evidence_quote="We approved the Friday deployment.",
        source_segment_ids=[segment_id],
        related_entities=[],
        confidence=0.99,
    )
    saved = save_memory_candidates(
        factory, meeting["id"], context, [unsupported], model_name="test-model"
    )
    assert saved == []
    assert client.get(f"/api/meetings/{meeting['id']}/memory").json() == []



def test_manual_memory_extraction_calls_service_when_configured(client, monkeypatch) -> None:
    from app import main as main_module

    monkeypatch.setattr(settings, "xai_api_key", "unit-test-key")

    async def fake_process(session_factory, meeting_id, *, api_key, model, base_url):
        assert api_key == "unit-test-key"
        assert meeting_id
        assert model == settings.memory_model
        assert base_url == settings.memory_base_url
        return {"processed_segments": 2, "items": []}

    monkeypatch.setattr(main_module, "process_meeting_transcript_memory", fake_process)
    meeting = create_session(client, "Manual memory extraction test")

    response = client.post(f"/api/meetings/{meeting['id']}/memory/extract")

    assert response.status_code == 200, response.text
    assert response.json() == {
        "meeting_id": meeting["id"],
        "processed_segments": 2,
        "item_count": 0,
        "items": [],
    }


def test_question_and_event_memory_types_can_be_saved_and_filtered(client: TestClient) -> None:
    from app.memory_service import MemoryCandidate, save_memory_candidates

    meeting = create_session(client, "Question and event memory test")
    factory = app.dependency_overrides[get_session_factory]()
    with factory() as session:
        segments = [
            TranscriptSegment(
                meeting_id=meeting["id"], text="When is the launch event?",
                start_seconds=2.0, end_seconds=3.2, speaker_id=1, confidence=0.9, words=None,
            ),
            TranscriptSegment(
                meeting_id=meeting["id"], text="The launch event is planned for Friday.",
                start_seconds=4.0, end_seconds=5.4, speaker_id=2, confidence=0.95, words=None,
            ),
        ]
        session.add_all(segments)
        session.commit()
        for segment in segments:
            session.refresh(segment)

    context = [
        {"id": seg.id, "start_seconds": seg.start_seconds, "end_seconds": seg.end_seconds,
         "speaker_id": seg.speaker_id, "text": seg.text}
        for seg in segments
    ]
    candidates = [
        MemoryCandidate(
            item_type="question", title="Launch date question",
            content="A participant asked when the launch event will occur.", status="open",
            owner=None, evidence_quote="When is the launch event?",
            source_segment_ids=[segments[0].id], related_entities=["launch event"], confidence=0.9,
        ),
        MemoryCandidate(
            item_type="event", title="Launch event planned for Friday",
            content="The launch event is planned for Friday.", status="active",
            owner=None, evidence_quote="The launch event is planned for Friday.",
            source_segment_ids=[segments[1].id], related_entities=["launch event"], confidence=0.95,
        ),
    ]
    saved = save_memory_candidates(factory, meeting["id"], context, candidates, model_name="test-model")
    assert {item["item_type"] for item in saved} == {"question", "event"}
    assert all(item["source_segment_ids"] for item in saved)

    questions = client.get(f"/api/meetings/{meeting['id']}/memory?item_type=question")
    events = client.get(f"/api/meetings/{meeting['id']}/memory?item_type=event")
    assert questions.status_code == 200 and len(questions.json()) == 1
    assert events.status_code == 200 and len(events.json()) == 1


def test_decision_state_advances_but_never_regresses(client: TestClient) -> None:
    from app.memory_service import MemoryCandidate, save_memory_candidates

    meeting = create_session(client, "Decision state progression test")
    factory = app.dependency_overrides[get_session_factory]()
    source_texts = [
        ("We are discussing whether to use PostgreSQL.", 1.0, 2.0),
        ("We tentatively agree to use PostgreSQL.", 3.0, 4.0),
        ("We have decided to use PostgreSQL.", 5.0, 6.0),
    ]
    segments = []
    with factory() as session:
        for text_value, start_seconds, end_seconds in source_texts:
            segment = TranscriptSegment(
                meeting_id=meeting["id"], text=text_value, start_seconds=start_seconds,
                end_seconds=end_seconds, speaker_id=1, confidence=0.9, words=None,
            )
            session.add(segment)
            session.flush()
            segments.append(segment)
        session.commit()
        for segment in segments:
            session.refresh(segment)

    def candidate(segment, state: str) -> MemoryCandidate:
        return MemoryCandidate(
            item_type="decision", title="Database selection",
            content="Track the team's database selection and its current state.",
            status="active", decision_state=state, owner=None,
            evidence_quote=segment.text, source_segment_ids=[segment.id],
            related_entities=["PostgreSQL"], confidence=0.9,
        )

    for segment, state in [(segments[0], "discussing"), (segments[1], "tentative"), (segments[2], "decided")]:
        save_memory_candidates(
            factory, meeting["id"],
            [{"id": segment.id, "start_seconds": segment.start_seconds,
              "end_seconds": segment.end_seconds, "speaker_id": segment.speaker_id, "text": segment.text}],
            [candidate(segment, state)], model_name="test-model",
        )
    # A stale extraction from an earlier segment must not move state backwards.
    stale_segment = segments[0]
    stale_saved = save_memory_candidates(
        factory, meeting["id"],
        [{"id": stale_segment.id, "start_seconds": stale_segment.start_seconds,
          "end_seconds": stale_segment.end_seconds, "speaker_id": stale_segment.speaker_id, "text": stale_segment.text}],
        [candidate(stale_segment, "proposed")], model_name="test-model",
    )
    assert stale_saved[0]["decision_state"] == "decided"
    items = client.get(f"/api/meetings/{meeting['id']}/memory?item_type=decision").json()
    assert len(items) == 1
    assert items[0]["decision_state"] == "decided"
    assert set(items[0]["source_segment_ids"]) == {seg.id for seg in segments}


def test_decision_record_without_lifecycle_state_is_not_persisted(client: TestClient) -> None:
    from app.memory_service import MemoryCandidate, save_memory_candidates

    meeting = create_session(client, "Missing decision state test")
    factory = app.dependency_overrides[get_session_factory]()
    with factory() as session:
        segment = TranscriptSegment(
            meeting_id=meeting["id"], text="We should choose PostgreSQL.",
            start_seconds=1.0, end_seconds=2.0, speaker_id=None, confidence=0.9, words=None,
        )
        session.add(segment)
        session.commit()
        session.refresh(segment)
    saved = save_memory_candidates(
        factory, meeting["id"],
        [{"id": segment.id, "start_seconds": segment.start_seconds, "end_seconds": segment.end_seconds,
          "speaker_id": None, "text": segment.text}],
        [MemoryCandidate(
            item_type="decision", title="Database choice", content="Database selection remains open.",
            status="proposed", decision_state=None, owner=None, evidence_quote=segment.text,
            source_segment_ids=[segment.id], related_entities=["PostgreSQL"], confidence=0.7,
        )], model_name="test-model",
    )
    assert saved == []
    assert client.get(f"/api/meetings/{meeting['id']}/memory").json() == []



def test_memory_status_disables_extraction_when_table_is_missing(client, monkeypatch) -> None:
    from app import main as main_module

    monkeypatch.setattr(settings, "xai_api_key", "test-groq-key")
    monkeypatch.setattr(main_module, "_memory_schema_ready", lambda bind=main_module.engine: False)
    response = client.get("/api/memory/status")
    assert response.status_code == 200
    payload = response.json()
    assert payload["provider_configured"] is True
    assert payload["schema_ready"] is False
    assert payload["configured"] is False
    assert "python -m alembic upgrade head" in payload["message"]


def test_memory_list_returns_migration_help_when_table_missing(client, monkeypatch) -> None:
    from app import main as main_module

    meeting = create_session(client, "Missing memory table test")
    monkeypatch.setattr(main_module, "_memory_schema_ready", lambda bind=main_module.engine: False)
    response = client.get(f"/api/meetings/{meeting['id']}/memory")
    assert response.status_code == 503
    assert "alembic upgrade head" in response.json()["detail"]


def test_deepgram_multilingual_mode_sends_language_hints(client, monkeypatch) -> None:
    from urllib.parse import parse_qs, urlparse
    from app import main as main_module

    captured = {}
    fake_provider = FakeDeepgramConnection()

    async def fake_connect(uri, **kwargs):
        captured["uri"] = uri
        return fake_provider

    monkeypatch.setattr(settings, "deepgram_api_key", "test-key")
    monkeypatch.setattr(settings, "deepgram_language", "multi")
    monkeypatch.setattr(settings, "deepgram_language_hints", "en,hi")
    monkeypatch.setattr(main_module, "upstream_connect", fake_connect)
    meeting = create_session(client, "Multilingual meeting test")

    with client.websocket_connect(f"/ws/meeting/{meeting['id']}") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "audio.start", "source": "desktop"})
        assert websocket.receive_json()["type"] == "transcription.ready"
        websocket.receive_json()

    query = parse_qs(urlparse(captured["uri"]).query)
    assert query["language"] == ["multi"]
    assert query["language_hint"] == ["en", "hi"]


def test_meeting_qna_requires_configured_groq_without_calling_provider(client) -> None:
    meeting = create_session(client, "Q&A without provider")
    response = client.post(
        f"/api/meetings/{meeting['id']}/ask",
        json={"question": "What was decided?", "scope": "meeting"},
    )
    assert response.status_code == 503
    assert "GROQ_API_KEY" in response.json()["detail"]


def test_meeting_qna_calls_provider_only_on_explicit_submit(client, monkeypatch) -> None:
    from app import main as main_module

    meeting = create_session(client, "Explicit Q&A")
    monkeypatch.setattr(settings, "groq_api_key", "test-groq-key")
    monkeypatch.setattr(settings, "xai_api_key", None)
    calls = []

    async def fake_answer(**kwargs):
        calls.append(kwargs)
        return {
            "meeting_answer": "The meeting record does not mention a final decision.",
            "broader_context": "A decision record typically identifies the chosen option and rationale.",
            "evidence": [],
            "scope": "broader",
            "model": "test-model",
            "context_segments_used": 0,
        }

    monkeypatch.setattr(main_module, "generate_meeting_answer", fake_answer)
    response = client.post(
        f"/api/meetings/{meeting['id']}/ask",
        json={"question": "What is a decision record?", "scope": "broader"},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["meeting_id"] == meeting["id"]
    assert payload["scope"] == "broader"
    assert "does not mention" in payload["meeting_answer"]
    assert payload["broader_context"]
    assert len(calls) == 1
    assert calls[0]["question"] == "What is a decision record?"


def test_meeting_qna_rejects_blank_question(client) -> None:
    meeting = create_session(client, "Blank question")
    response = client.post(f"/api/meetings/{meeting['id']}/ask", json={"question": "   "})
    assert response.status_code == 422
