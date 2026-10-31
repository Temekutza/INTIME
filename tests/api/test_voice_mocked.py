import pytest
from fastapi.testclient import TestClient

from app.core.errors import BadGateway
from tests.conftest import Accounts


def test_transcription_requires_auth(client: TestClient) -> None:
    response = client.post(
        "/api/v1/voice/transcriptions",
        files={"file": ("note.wav", b"RIFFxxxx", "audio/wav")},
    )
    assert response.status_code == 401


def test_speech_requires_auth(client: TestClient) -> None:
    response = client.post("/api/v1/voice/speech", json={"text": "привет"})
    assert response.status_code == 401


def test_transcription_mocked_success(
    client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    accounts.register()

    async def transcribe(_name: str, _content: bytes, _type: str) -> str:
        return "купить молоко"

    monkeypatch.setattr("app.api.v1.endpoints.voice.stt.transcribe", transcribe)
    response = client.post(
        "/api/v1/voice/transcriptions",
        files={"file": ("note.wav", b"RIFFxxxx", "audio/wav")},
    )
    assert response.status_code == 200
    assert response.json() == {"text": "купить молоко"}


def test_transcription_empty_file(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    response = client.post(
        "/api/v1/voice/transcriptions",
        files={"file": ("note.wav", b"", "audio/wav")},
    )
    assert response.status_code == 422


def test_transcription_too_large(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    response = client.post(
        "/api/v1/voice/transcriptions",
        files={"file": ("note.wav", b"x" * (10 * 1024 * 1024 + 1), "audio/wav")},
    )
    assert response.status_code == 422


def test_transcription_network_error(
    client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    accounts.register()

    async def transcribe(_name: str, _content: bytes, _type: str) -> str:
        raise BadGateway("Сервис распознавания не ответил")

    monkeypatch.setattr("app.api.v1.endpoints.voice.stt.transcribe", transcribe)
    response = client.post(
        "/api/v1/voice/transcriptions",
        files={"file": ("note.wav", b"RIFFxxxx", "audio/wav")},
    )
    assert response.status_code == 502


def test_speech_mocked_success(
    client: TestClient, accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    accounts.register()

    async def synthesize(text: str, _voice: str | None) -> tuple[bytes, str]:
        assert text == "доброе утро"
        return b"ID3fake", "audio/mpeg"

    monkeypatch.setattr("app.api.v1.endpoints.voice.tts.synthesize", synthesize)
    response = client.post("/api/v1/voice/speech", json={"text": "доброе утро"})
    assert response.status_code == 200
    assert response.content == b"ID3fake"
    assert response.headers["content-type"].startswith("audio/mpeg")


def test_speech_blank_text(client: TestClient, accounts: Accounts) -> None:
    accounts.register()
    response = client.post("/api/v1/voice/speech", json={"text": "   "})
    assert response.status_code == 422
