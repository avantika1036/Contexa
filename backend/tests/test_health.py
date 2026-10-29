from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_health_endpoint() -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "contexa-api",
    }


def test_websocket_ping_pong() -> None:
    with client.websocket_connect(
        "/ws/meeting/test-meeting"
    ) as websocket:
        connected = websocket.receive_json()

        assert connected["type"] == "connection.established"
        assert connected["meeting_id"] == "test-meeting"

        websocket.send_json({"type": "ping"})

        response = websocket.receive_json()

        assert response == {
            "type": "pong",
            "meeting_id": "test-meeting",
        }


def test_websocket_binary_chunk_acknowledgement() -> None:
    with client.websocket_connect(
        "/ws/meeting/audio-test"
    ) as websocket:
        websocket.receive_json()

        websocket.send_bytes(b"test-audio")

        response = websocket.receive_json()

        assert response["type"] == "audio.chunk.received"
        assert response["meeting_id"] == "audio-test"
        assert response["byte_length"] == len(b"test-audio")
        assert response["transcription_status"] == "not_implemented"


def test_websocket_rejects_non_object_json() -> None:
    with client.websocket_connect(
        "/ws/meeting/json-test"
    ) as websocket:
        websocket.receive_json()

        websocket.send_text('"hello"')

        response = websocket.receive_json()

        assert response["type"] == "error"
