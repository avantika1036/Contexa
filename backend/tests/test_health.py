import asyncio

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db, get_session_factory
from app.main import app
from app.models import Meeting, TranscriptSegment  # noqa: F401 - register mapped models for test schema


@pytest.fixture
def client():
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
    def __init__(self, emit_transcript: bool = False) -> None:
        self.sent: list[bytes | str] = []
        self.closed = False
        self.emit_transcript = emit_transcript
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
            await self.queue.put(
                '{"type":"Results","start":1.25,"duration":0.8,"is_final":true,"speech_final":true,"channel":{"alternatives":[{"transcript":"Hello everyone.","confidence":0.97,"words":[{"word":"Hello","start":1.25,"end":1.55,"confidence":0.98,"speaker":0},{"word":"everyone.","start":1.56,"end":2.05,"confidence":0.95,"speaker":0}]}]}}'
            )
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
        
        received_types = set()
        for _ in range(2):
            event = websocket.receive_json()
            received_types.add(event["type"])
            if event["type"] == "transcript.segment":
                assert event["is_final"] is True
                assert event["segment"]["text"] == "Hello everyone."
                assert event["segment"]["speaker_id"] == 0
        assert "audio.chunk.received" in received_types
        assert "transcript.segment" in received_types

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


def test_audio_source_is_saved_to_selected_session(client: TestClient, monkeypatch) -> None:
    from app import main as main_module

    fake_provider = FakeDeepgramConnection()

    async def fake_connect(*args, **kwargs):
        return fake_provider

    monkeypatch.setattr(main_module.settings, "deepgram_api_key", "test-key")
    monkeypatch.setattr(main_module, "upstream_connect", fake_connect)
    meeting = create_session(client, "Audio source test")

    with client.websocket_connect(f"/ws/meeting/{meeting['id']}") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "audio.start", "source": "microphone"})
        assert websocket.receive_json()["type"] == "transcription.ready"
        acknowledgement = websocket.receive_json()
        assert acknowledgement["message_type"] == "audio.start"

    result = client.get(f"/api/meetings/{meeting['id']}")
    assert result.status_code == 200
    assert result.json()["audio_source"] == "microphone"


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
