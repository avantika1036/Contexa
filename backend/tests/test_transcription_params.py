from urllib.parse import parse_qs, urlparse

from app.transcription_params import keyterm_params, language_warning, parse_keyterms
from test_health import FakeDeepgramConnection, client, create_session  # noqa: F401


def test_parse_keyterms_cleans_dedupes_and_caps():
    assert parse_keyterms(None) == []
    assert parse_keyterms("  Avanti   Kapadia , contexa,Contexa, ,Kubernetes ") == ["Avanti Kapadia", "contexa", "Kubernetes"]
    many = ",".join(f"term{i}" for i in range(80))
    assert len(parse_keyterms(many)) == 50
    assert len(parse_keyterms("x" * 500)[0]) == 60


def test_keyterms_only_apply_to_nova_3_models():
    assert keyterm_params("nova-3", ["A", "B"]) == [("keyterm", "A"), ("keyterm", "B")]
    assert keyterm_params("Nova-3-medical", ["A"]) == [("keyterm", "A")]
    assert keyterm_params("nova-2", ["A"]) == []
    assert keyterm_params("nova-3", []) == []


def test_multi_language_without_hints_produces_a_warning():
    assert "DEEPGRAM_LANGUAGE_HINTS" in language_warning("multi", [])
    assert language_warning("multi", ["en"]) is None
    assert language_warning("en", []) is None


def test_stream_url_carries_language_hints_and_keyterms(client, monkeypatch):
    from app import main as main_module

    captured = {}

    async def fake_connect(url, *args, **kwargs):
        captured["url"] = url
        return FakeDeepgramConnection()

    monkeypatch.setattr(main_module.settings, "deepgram_api_key", "test-key")
    monkeypatch.setattr(main_module.settings, "deepgram_language", "multi")
    monkeypatch.setattr(main_module.settings, "deepgram_language_hints", "en,hi")
    monkeypatch.setattr(main_module.settings, "deepgram_keyterms", "Avanti Kapadia,Contexa")
    monkeypatch.setattr(main_module, "upstream_connect", fake_connect)
    meeting = create_session(client, "keyterms")
    with client.websocket_connect(f"/ws/meeting/{meeting['id']}") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "audio.start", "source": "microphone"})
        websocket.receive_json(); websocket.receive_json()

    query = parse_qs(urlparse(captured["url"]).query)
    assert query["language"] == ["multi"]
    assert query["language_hint"] == ["en", "hi"]
    assert query["keyterm"] == ["Avanti Kapadia", "Contexa"]
