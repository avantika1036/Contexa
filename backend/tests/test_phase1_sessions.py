"""Phase 1: session lifecycle (no duplicates, discard, cleanup, resume) and speaker splitting."""
import json
from datetime import datetime, timedelta, timezone

from app.database import get_session_factory
from app.main import app
from app.models import Meeting, MemoryItem, TranscriptSegment
from test_health import FakeDeepgramConnection, client, create_session  # noqa: F401


def _factory():
    return app.dependency_overrides[get_session_factory]()


def add_segment(meeting_id: str, text="Hello.", start=1.0, end=2.0, created_at=None) -> str:
    with _factory()() as session:
        segment = TranscriptSegment(meeting_id=meeting_id, text=text, start_seconds=start, end_seconds=end)
        if created_at is not None:
            segment.created_at = created_at
        session.add(segment)
        session.commit()
        return segment.id


def backdate_meeting(meeting_id: str, minutes: int) -> None:
    with _factory()() as session:
        meeting = session.get(Meeting, meeting_id)
        meeting.created_at = datetime.now(timezone.utc) - timedelta(minutes=minutes)
        session.commit()


def test_discard_if_empty_deletes_a_session_with_no_transcript(client):
    meeting = create_session(client, "Auto · failed start")
    response = client.post(f"/api/meetings/{meeting['id']}/end?discard_if_empty=true")
    assert response.status_code == 200
    assert response.json()["status"] == "discarded"
    assert client.get(f"/api/meetings/{meeting['id']}").status_code == 404
    assert client.get("/api/meetings").json() == []


def test_discard_if_empty_never_deletes_a_session_that_has_transcript(client):
    meeting = create_session(client, "Auto · real meeting")
    add_segment(meeting["id"])
    response = client.post(f"/api/meetings/{meeting['id']}/end?discard_if_empty=true")
    assert response.json()["status"] == "ended"
    assert client.get(f"/api/meetings/{meeting['id']}").status_code == 200


def test_plain_end_keeps_an_empty_session_for_manual_meetings(client):
    meeting = create_session(client, "Manual")
    assert client.post(f"/api/meetings/{meeting['id']}/end").json()["status"] == "ended"
    assert client.get(f"/api/meetings/{meeting['id']}").status_code == 200


def test_delete_meeting_removes_transcript_and_memory(client):
    meeting = create_session(client, "To delete")
    add_segment(meeting["id"])
    with _factory()() as session:
        session.add(MemoryItem(
            meeting_id=meeting["id"], item_type="fact", title="t", content="c",
            evidence_quote="Hello.", dedupe_key="k", source_segment_ids=[],
        ))
        session.commit()
    assert client.delete(f"/api/meetings/{meeting['id']}").status_code == 204
    with _factory()() as session:
        assert session.query(TranscriptSegment).count() == 0
        assert session.query(MemoryItem).count() == 0
    assert client.delete(f"/api/meetings/{meeting['id']}").status_code == 404


def test_cleanup_handles_stale_active_sessions_and_leaves_recent_ones(client):
    stale_empty = create_session(client, "stale empty")
    stale_with_text = create_session(client, "stale with transcript")
    recent = create_session(client, "recent")
    backdate_meeting(stale_empty["id"], 60)
    backdate_meeting(stale_with_text["id"], 60)
    add_segment(stale_with_text["id"], created_at=datetime.now(timezone.utc) - timedelta(minutes=45))

    counts = client.post("/api/meetings/cleanup").json()
    assert counts == {"ended": 1, "discarded": 1, "purged": 0}
    assert client.get(f"/api/meetings/{stale_empty['id']}").status_code == 404
    assert client.get(f"/api/meetings/{stale_with_text['id']}").json()["status"] == "ended"
    assert client.get(f"/api/meetings/{recent['id']}").json()["status"] == "active"


def test_cleanup_purge_empty_removes_old_empty_ended_duplicates_only(client):
    empty_ended = create_session(client, "old duplicate")
    real_ended = create_session(client, "real")
    add_segment(real_ended["id"])
    client.post(f"/api/meetings/{empty_ended['id']}/end")
    client.post(f"/api/meetings/{real_ended['id']}/end")

    assert client.post("/api/meetings/cleanup").json()["purged"] == 0  # opt-in only
    assert client.post("/api/meetings/cleanup?purge_empty=true").json()["purged"] == 1
    assert client.get(f"/api/meetings/{empty_ended['id']}").status_code == 404
    assert client.get(f"/api/meetings/{real_ended['id']}").status_code == 200


def test_connected_meeting_is_protected_from_cleanup_and_delete(client, monkeypatch):
    from app import main as main_module

    async def fake_connect(*args, **kwargs):
        return FakeDeepgramConnection()

    monkeypatch.setattr(main_module, "upstream_connect", fake_connect)
    meeting = create_session(client, "live")
    backdate_meeting(meeting["id"], 120)
    with client.websocket_connect(f"/ws/meeting/{meeting['id']}") as websocket:
        websocket.receive_json()
        assert client.delete(f"/api/meetings/{meeting['id']}").status_code == 409
        assert client.post("/api/meetings/cleanup").json() == {"ended": 0, "discarded": 0, "purged": 0}
    assert client.get(f"/api/meetings/{meeting['id']}").status_code == 200


def test_resumed_capture_continues_the_meeting_clock(client, monkeypatch):
    from app import main as main_module

    async def fake_connect(*args, **kwargs):
        return FakeDeepgramConnection(emit_transcript=True)

    monkeypatch.setattr(main_module.settings, "deepgram_api_key", "test-key")
    monkeypatch.setattr(main_module, "upstream_connect", fake_connect)
    meeting = create_session(client, "resumed")
    backdate_meeting(meeting["id"], 10)  # created ten minutes ago
    add_segment(meeting["id"], text="Earlier talk.", start=5.0, end=20.0)

    with client.websocket_connect(f"/ws/meeting/{meeting['id']}") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "audio.start", "source": "microphone"})
        websocket.receive_json(); websocket.receive_json()
        websocket.send_bytes(b"test-audio")
        for _ in range(2):
            websocket.receive_json()

    segments = client.get(f"/api/meetings/{meeting['id']}/transcript").json()
    new_segment = next(item for item in segments if item["text"] == "Hello everyone.")
    assert new_segment["start_seconds"] > 590  # ~600 s offset + the 1.25 s stream time


def test_fresh_session_timestamps_still_start_at_stream_time(client, monkeypatch):
    from app import main as main_module

    async def fake_connect(*args, **kwargs):
        return FakeDeepgramConnection(emit_transcript=True)

    monkeypatch.setattr(main_module.settings, "deepgram_api_key", "test-key")
    monkeypatch.setattr(main_module, "upstream_connect", fake_connect)
    meeting = create_session(client, "fresh")
    with client.websocket_connect(f"/ws/meeting/{meeting['id']}") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "audio.start", "source": "microphone"})
        websocket.receive_json(); websocket.receive_json()
        websocket.send_bytes(b"test-audio")
        for _ in range(2):
            websocket.receive_json()
    segments = client.get(f"/api/meetings/{meeting['id']}/transcript").json()
    assert segments[0]["start_seconds"] == 1.25


class TwoSpeakerProvider(FakeDeepgramConnection):
    async def send(self, data):
        self.sent.append(data)
        if isinstance(data, bytes):
            words = [
                {"word": "hello", "punctuated_word": "Hello", "start": 1.0, "end": 1.3, "speaker": 0},
                {"word": "team", "punctuated_word": "team.", "start": 1.4, "end": 1.8, "speaker": 0},
                {"word": "sounds", "punctuated_word": "Sounds", "start": 2.0, "end": 2.3, "speaker": 1},
                {"word": "good", "punctuated_word": "good.", "start": 2.4, "end": 2.8, "speaker": 1},
            ]
            await self.queue.put(json.dumps({
                "type": "Results", "start": 1.0, "duration": 1.8, "is_final": True, "speech_final": True,
                "channel": {"alternatives": [{"transcript": "Hello team. Sounds good.", "confidence": 0.9, "words": words}]},
            }))
        if isinstance(data, str) and '"type": "CloseStream"' in data:
            await self.queue.put(None)


def test_final_result_with_two_speakers_becomes_two_segments(client, monkeypatch):
    from app import main as main_module

    async def fake_connect(*args, **kwargs):
        return TwoSpeakerProvider()

    monkeypatch.setattr(main_module.settings, "deepgram_api_key", "test-key")
    monkeypatch.setattr(main_module, "upstream_connect", fake_connect)
    meeting = create_session(client, "two speakers")
    seen = []
    with client.websocket_connect(f"/ws/meeting/{meeting['id']}") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "audio.start", "source": "microphone"})
        websocket.receive_json(); websocket.receive_json()
        websocket.send_bytes(b"test-audio")
        for _ in range(3):
            event = websocket.receive_json()
            if event["type"] == "transcript.segment":
                seen.append(event["segment"])

    assert [(item["speaker_id"], item["text"]) for item in seen] == [(0, "Hello team."), (1, "Sounds good.")]
    stored = client.get(f"/api/meetings/{meeting['id']}/transcript").json()
    assert [(item["speaker_id"], item["text"]) for item in stored] == [(0, "Hello team."), (1, "Sounds good.")]
    assert stored[0]["start_seconds"] == 1.0 and stored[1]["start_seconds"] == 2.0


def test_auto_meeting_creation_is_idempotent_for_stable_capture_key(client):
    payload = {
        "title": "Auto · Product sync",
        "capture_key": "meet:abc-defg-hij",
        "process_name": "chrome",
    }
    first = client.post("/api/meetings/auto", json=payload)
    second = client.post("/api/meetings/auto", json=payload)

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["reused"] is False
    assert second.json()["reused"] is True
    assert first.json()["meeting"]["id"] == second.json()["meeting"]["id"]
    assert len(client.get("/api/meetings").json()) == 1


def test_auto_meeting_key_can_be_reused_after_previous_session_ended(client):
    payload = {
        "title": "Auto · Product sync",
        "capture_key": "meet:abc-defg-hij",
        "process_name": "chrome",
    }
    first = client.post("/api/meetings/auto", json=payload).json()
    ended = client.post(f"/api/meetings/{first['meeting']['id']}/end")
    second = client.post("/api/meetings/auto", json=payload)

    assert ended.status_code == 200
    assert ended.json()["status"] == "ended"
    assert second.status_code == 200
    assert second.json()["reused"] is False
    assert second.json()["meeting"]["id"] != first["meeting"]["id"]
    assert len(client.get("/api/meetings").json()) == 2


def test_different_stable_capture_keys_create_different_active_sessions(client):
    first = client.post("/api/meetings/auto", json={
        "title": "Auto · Meet A", "capture_key": "meet:abc-defg-hij", "process_name": "chrome"
    })
    second = client.post("/api/meetings/auto", json={
        "title": "Auto · Meet B", "capture_key": "meet:zzz-zzzz-zzz", "process_name": "chrome"
    })

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["meeting"]["id"] != second.json()["meeting"]["id"]
    assert len(client.get("/api/meetings").json()) == 2


def test_database_partial_unique_index_allows_only_one_active_stable_identity(client):
    from sqlalchemy.exc import IntegrityError

    with _factory()() as session:
        first = Meeting(title="First", capture_key="meet:abc-defg-hij")
        session.add(first)
        session.commit()
        first_id = first.id

    with _factory()() as session:
        session.add(Meeting(title="Duplicate", capture_key="meet:abc-defg-hij"))
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
        else:
            raise AssertionError("The database accepted two active sessions for one stable capture key")

    with _factory()() as session:
        first = session.get(Meeting, first_id)
        first.status = "ended"
        session.commit()
        session.add(Meeting(title="Next occurrence", capture_key="meet:abc-defg-hij"))
        session.commit()
        assert session.query(Meeting).filter(Meeting.capture_key == "meet:abc-defg-hij").count() == 2


def test_suspend_and_resume_preserves_the_same_meeting_session(client):
    meeting = client.post("/api/meetings/auto", json={
        "title": "Auto · Meet A",
        "capture_key": "meet:abc-defg-hij",
        "process_name": "chrome",
    }).json()["meeting"]

    suspended = client.post(f"/api/meetings/{meeting['id']}/suspend")
    assert suspended.status_code == 200
    assert suspended.json()["status"] == "suspended"
    assert suspended.json()["suspended_at"] is not None
    assert suspended.json()["ended_at"] is None

    resumed = client.post(f"/api/meetings/{meeting['id']}/resume")
    assert resumed.status_code == 200
    assert resumed.json()["id"] == meeting["id"]
    assert resumed.json()["status"] == "active"
    assert resumed.json()["suspended_at"] is None
    assert resumed.json()["ended_at"] is None


def test_resume_never_revives_an_ended_session(client):
    meeting = create_session(client, "Already ended")
    client.post(f"/api/meetings/{meeting['id']}/end")

    response = client.post(f"/api/meetings/{meeting['id']}/resume")
    assert response.status_code == 409
    assert "ended" in response.json()["detail"].lower()


def test_auto_endpoint_reclaims_a_recently_suspended_session(client):
    from app.config import settings

    meeting_payload = {
        "title": "Auto · persistent recovery",
        "capture_key": "meet:abc-defg-hij",
        "process_name": "chrome",
    }
    first = client.post("/api/meetings/auto", json=meeting_payload).json()["meeting"]
    client.post(f"/api/meetings/{first['id']}/suspend")

    resumed = client.post("/api/meetings/auto", json=meeting_payload)
    assert resumed.status_code == 200
    assert resumed.json()["reused"] is True
    assert resumed.json()["meeting"]["id"] == first["id"]
    assert resumed.json()["meeting"]["status"] == "active"
    assert resumed.json()["meeting"]["suspended_at"] is None


def test_auto_endpoint_does_not_reuse_an_expired_suspended_session(client, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "suspended_session_resume_grace_seconds", 1)
    payload = {
        "title": "Auto · expired recovery",
        "capture_key": "meet:abc-defg-hij",
        "process_name": "chrome",
    }
    first = client.post("/api/meetings/auto", json=payload).json()["meeting"]
    add_segment(first["id"], text="Previously captured speech.")
    suspended = client.post(f"/api/meetings/{first['id']}/suspend")
    assert suspended.status_code == 200

    from datetime import timedelta
    with _factory()() as session:
        row = session.get(Meeting, first["id"])
        row.suspended_at = datetime.now(timezone.utc) - timedelta(seconds=10)
        session.commit()

    next_session = client.post("/api/meetings/auto", json=payload)
    assert next_session.status_code == 200
    assert next_session.json()["reused"] is False
    assert next_session.json()["meeting"]["id"] != first["id"]
    assert client.get(f"/api/meetings/{first['id']}").json()["status"] == "ended"


def test_cleanup_expires_stale_suspended_sessions(client):
    empty = client.post("/api/meetings/auto", json={
        "title": "Auto · stale suspended empty",
        "capture_key": "meet:abc-defg-hij",
        "process_name": "chrome",
    }).json()["meeting"]
    client.post(f"/api/meetings/{empty['id']}/suspend")
    with _factory()() as session:
        row = session.get(Meeting, empty["id"])
        row.suspended_at = datetime.now(timezone.utc) - timedelta(minutes=60)
        session.commit()

    counts = client.post("/api/meetings/cleanup").json()
    assert counts["discarded"] == 1
    assert client.get(f"/api/meetings/{empty['id']}").status_code == 404


def test_idle_meeting_websocket_does_not_block_suspension(client):
    from app import main as main_module

    meeting = create_session(client, "connected idle meeting websocket")
    with client.websocket_connect(f"/ws/meeting/{meeting['id']}") as websocket:
        websocket.receive_json()
        # A connected UI/control websocket is not an active audio capture stream.
        response = client.post(f"/api/meetings/{meeting['id']}/suspend")
        assert response.status_code == 200
        assert response.json()["status"] == "suspended"
        assert main_module.ACTIVE_MEETING_CONNECTIONS.get(meeting["id"]) == 1
        assert main_module.ACTIVE_MEETING_STREAMS.get(meeting["id"], 0) == 0


def test_suspension_waits_for_audio_stream_stop_not_websocket_disconnect(client, monkeypatch):
    """A control WebSocket may stay open after audio.stop; that must not block suspend."""
    from app import main as main_module

    async def fake_connect(*args, **kwargs):
        return FakeDeepgramConnection()

    monkeypatch.setattr(main_module.settings, "deepgram_api_key", "test-key")
    monkeypatch.setattr(main_module, "upstream_connect", fake_connect)
    meeting = create_session(client, "shutdown suspension")

    with client.websocket_connect(f"/ws/meeting/{meeting['id']}") as websocket:
        websocket.receive_json()  # connection.established
        websocket.send_json({"type": "audio.start", "source": "desktop_auto"})
        assert websocket.receive_json()["type"] == "transcription.ready"
        assert websocket.receive_json()["message_type"] == "audio.start"

        assert main_module.ACTIVE_MEETING_CONNECTIONS.get(meeting["id"]) == 1
        assert main_module.ACTIVE_MEETING_STREAMS.get(meeting["id"]) == 1
        blocked = client.post(f"/api/meetings/{meeting['id']}/suspend")
        assert blocked.status_code == 409

        websocket.send_json({"type": "audio.stop", "source": "desktop_auto"})
        stopped = websocket.receive_json()
        assert stopped["type"] == "message.received"
        assert stopped["message_type"] == "audio.stop"

        # The websocket itself is still open, but the provider stream has been
        # finalized and the server has acknowledged audio.stop. Suspension is safe.
        assert main_module.ACTIVE_MEETING_CONNECTIONS.get(meeting["id"]) == 1
        assert main_module.ACTIVE_MEETING_STREAMS.get(meeting["id"], 0) == 0
        suspended = client.post(f"/api/meetings/{meeting['id']}/suspend")
        assert suspended.status_code == 200, suspended.text
        assert suspended.json()["status"] == "suspended"

    assert main_module.ACTIVE_MEETING_CONNECTIONS.get(meeting["id"], 0) == 0
    assert main_module.ACTIVE_MEETING_STREAMS.get(meeting["id"], 0) == 0


def test_identity_upgrade_persists_the_google_meet_key_on_the_original_session(client):
    provisional = create_session(client, "Auto · Meet")
    upgraded = client.patch(
        f"/api/meetings/{provisional['id']}/identity",
        json={
            "title": "Auto · Meet - fai-wivv-szk",
            "capture_key": "meet:fai-wivv-szk",
            "process_name": "chrome",
        },
    )
    assert upgraded.status_code == 200, upgraded.text
    assert upgraded.json()["id"] == provisional["id"]
    assert upgraded.json()["title"] == "Auto · Meet - fai-wivv-szk"
    with _factory()() as session:
        stored = session.get(Meeting, provisional["id"])
        assert stored.capture_key == "meet:fai-wivv-szk"
        assert stored.capture_process_name == "chrome"
        assert stored.audio_source == "desktop_auto"

    reused = client.post("/api/meetings/auto", json={
        "title": "Auto · Meet - fai-wivv-szk",
        "capture_key": "meet:fai-wivv-szk",
        "process_name": "chrome",
    })
    assert reused.status_code == 200
    assert reused.json()["reused"] is True
    assert reused.json()["meeting"]["id"] == provisional["id"]


def test_auto_endpoint_adopts_a_recent_legacy_provisional_meet_after_restart(client):
    provisional = create_session(client, "Auto · Meet")
    add_segment(provisional["id"], text="Speech before Contexa restarted.", start=1.0, end=2.0)
    suspended = client.post(f"/api/meetings/{provisional['id']}/suspend")
    assert suspended.status_code == 200

    recovered = client.post("/api/meetings/auto", json={
        "title": "Auto · Meet - fai-wivv-szk",
        "capture_key": "meet:fai-wivv-szk",
        "process_name": "chrome",
    })
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["reused"] is True
    assert recovered.json()["meeting"]["id"] == provisional["id"]
    assert recovered.json()["meeting"]["title"] == "Auto · Meet - fai-wivv-szk"
    assert recovered.json()["meeting"]["status"] == "active"
    with _factory()() as session:
        stored = session.get(Meeting, provisional["id"])
        assert stored.capture_key == "meet:fai-wivv-szk"
        assert session.query(TranscriptSegment).filter(TranscriptSegment.meeting_id == provisional["id"]).count() == 1
    assert len(client.get("/api/meetings").json()) == 1


def test_auto_endpoint_merges_one_legacy_transcript_into_existing_stable_session(client):
    payload = {
        "title": "Auto · Meet - fai-wivv-szk",
        "capture_key": "meet:fai-wivv-szk",
        "process_name": "chrome",
    }
    stable = client.post("/api/meetings/auto", json=payload).json()["meeting"]
    add_segment(stable["id"], text="Earlier stable-session transcript.", start=1.0, end=2.0)

    legacy = create_session(client, "Auto · Meet")
    add_segment(legacy["id"], text="Later provisional transcript.", start=1.0, end=2.0)
    assert client.post(f"/api/meetings/{legacy['id']}/suspend").status_code == 200

    recovered = client.post("/api/meetings/auto", json=payload)
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["meeting"]["id"] == stable["id"]
    transcript = client.get(f"/api/meetings/{stable['id']}/transcript").json()
    assert [item["text"] for item in transcript] == [
        "Earlier stable-session transcript.",
        "Later provisional transcript.",
    ]
    assert transcript[0]["start_seconds"] == 1.0
    assert transcript[1]["start_seconds"] >= 3.0
    assert client.get(f"/api/meetings/{legacy['id']}").status_code == 404
    assert len(client.get("/api/meetings").json()) == 1


def test_identity_upgrade_rejects_a_second_open_owner_for_the_same_call_key(client):
    first = client.post("/api/meetings/auto", json={
        "title": "Auto · Meet - fai-wivv-szk",
        "capture_key": "meet:fai-wivv-szk",
        "process_name": "chrome",
    }).json()["meeting"]
    second = create_session(client, "Auto · Meet")
    conflict = client.patch(
        f"/api/meetings/{second['id']}/identity",
        json={
            "title": "Auto · Meet - fai-wivv-szk",
            "capture_key": "meet:fai-wivv-szk",
            "process_name": "chrome",
        },
    )
    assert conflict.status_code == 409
    assert client.get(f"/api/meetings/{first['id']}").status_code == 200
    assert client.get(f"/api/meetings/{second['id']}").status_code == 200


def test_cleanup_uses_five_minute_recovery_window_for_suspended_rows(client, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "suspended_session_resume_grace_seconds", 300)
    meeting = client.post("/api/meetings/auto", json={
        "title": "Auto · Meet - expired-call",
        "capture_key": "meet:abc-defg-hij",
        "process_name": "chrome",
    }).json()["meeting"]
    add_segment(meeting["id"], text="Transcript must be retained after expiration.")
    assert client.post(f"/api/meetings/{meeting['id']}/suspend").status_code == 200
    with _factory()() as session:
        row = session.get(Meeting, meeting["id"])
        row.suspended_at = datetime.now(timezone.utc) - timedelta(minutes=6)
        session.commit()

    counts = client.post("/api/meetings/cleanup").json()
    assert counts["ended"] == 1
    assert client.get(f"/api/meetings/{meeting['id']}").json()["status"] == "ended"


def test_auto_cleanup_expires_only_disconnected_desktop_auto_sessions_with_short_threshold(client):
    from app import main as main_module

    old_auto_empty = create_session(client, "Auto · old empty")
    old_auto_with_text = create_session(client, "Auto · old captured session")
    old_manual = create_session(client, "Manual session")
    backdate_meeting(old_auto_empty["id"], 20)
    backdate_meeting(old_auto_with_text["id"], 20)
    backdate_meeting(old_manual["id"], 10)
    add_segment(old_auto_with_text["id"], text="Saved auto transcript.", created_at=datetime.now(timezone.utc) - timedelta(minutes=10))

    # The API must not mark an actually connected auto session as stale.
    main_module.ACTIVE_MEETING_CONNECTIONS[old_auto_with_text["id"]] = 1
    try:
        first = client.post("/api/meetings/cleanup?auto_idle_minutes=5")
        assert first.status_code == 200
        assert client.get(f"/api/meetings/{old_auto_empty['id']}").status_code == 404
        assert client.get(f"/api/meetings/{old_auto_with_text['id']}").json()["status"] == "active"
        assert client.get(f"/api/meetings/{old_manual['id']}").json()["status"] == "active"
    finally:
        main_module.ACTIVE_MEETING_CONNECTIONS.pop(old_auto_with_text["id"], None)

    second = client.post("/api/meetings/cleanup?auto_idle_minutes=5")
    assert second.status_code == 200
    assert client.get(f"/api/meetings/{old_auto_with_text['id']}").json()["status"] == "ended"
    assert client.get(f"/api/meetings/{old_manual['id']}").json()["status"] == "active"


def test_native_window_recovery_key_resumes_same_zoom_session_when_title_falls_back(client):
    payload = {
        "title": "Auto · Avantika Pandey's Zoom Meeting",
        "capture_key": "zoom:window:34404:50122",
        "process_name": "Zoom",
    }
    first = client.post("/api/meetings/auto", json=payload)
    assert first.status_code == 200, first.text
    original_id = first.json()["meeting"]["id"]
    assert first.json()["reused"] is False
    assert client.post(f"/api/meetings/{original_id}/suspend").status_code == 200

    # Zoom may show the generic title after Contexa restarts while retaining PID/HWND.
    resumed = client.post("/api/meetings/auto", json={
        "title": "Auto · Zoom Meeting",
        "capture_key": "zoom:window:34404:50122",
        "process_name": "Zoom",
    })
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["reused"] is True
    assert resumed.json()["meeting"]["id"] == original_id
    assert resumed.json()["meeting"]["status"] == "active"


def test_first_restart_after_native_window_key_rollout_adopts_one_recent_legacy_zoom_session(client):
    legacy = create_session(client, "Auto · Avantika Pandey's Zoom Meeting")
    assert client.post(f"/api/meetings/{legacy['id']}/suspend").status_code == 200

    recovered = client.post("/api/meetings/auto", json={
        "title": "Auto · Zoom Meeting",
        "capture_key": "zoom:window:34404:50122",
        "process_name": "Zoom",
    })
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["reused"] is True
    assert recovered.json()["meeting"]["id"] == legacy["id"]
    assert client.get(f"/api/meetings/{legacy['id']}").json()["status"] == "active"


def test_native_window_key_does_not_reuse_a_different_named_meeting_on_same_window(client):
    first = client.post("/api/meetings/auto", json={
        "title": "Auto · Daily Standup on Zoom",
        "capture_key": "zoom:window:34404:50122",
        "process_name": "Zoom",
    })
    assert first.status_code == 200, first.text
    old_id = first.json()["meeting"]["id"]
    add_segment(old_id, text="Daily standup notes should remain in history.")
    assert client.post(f"/api/meetings/{old_id}/suspend").status_code == 200

    second = client.post("/api/meetings/auto", json={
        "title": "Auto · Customer Review on Zoom",
        "capture_key": "zoom:window:34404:50122",
        "process_name": "Zoom",
    })
    assert second.status_code == 200, second.text
    assert second.json()["reused"] is False
    assert second.json()["meeting"]["id"] != old_id
    assert client.get(f"/api/meetings/{old_id}").json()["status"] == "ended"


def test_new_webex_call_epoch_creates_a_new_auto_session_after_the_previous_call_ended(client):
    first = client.post("/api/meetings/auto", json={
        "title": "Auto · Webex",
        "capture_key": "webex:window:18760:10093378",
        "process_name": "CiscoCollabHost",
    })
    assert first.status_code == 200, first.text
    first_meeting = first.json()["meeting"]
    assert first.json()["reused"] is False

    ended = client.post(f"/api/meetings/{first_meeting['id']}/end")
    assert ended.status_code == 200, ended.text
    assert ended.json()["status"] == "ended"

    second = client.post("/api/meetings/auto", json={
        "title": "Auto · Webex",
        "capture_key": "webex:window:18760:3348120-call2",
        "process_name": "CiscoCollabHost",
    })
    assert second.status_code == 200, second.text
    assert second.json()["reused"] is False
    assert second.json()["meeting"]["id"] != first_meeting["id"]
    assert client.get(f"/api/meetings/{first_meeting['id']}").json()["status"] == "ended"
    assert client.get(f"/api/meetings/{second.json()['meeting']['id']}").json()["status"] == "active"

