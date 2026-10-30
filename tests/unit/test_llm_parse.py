import pytest

from app.core.errors import BadGateway, ServiceUnavailable
from app.integrations import llm


def test_parse_json_object_from_fenced_text() -> None:
    payload = llm.parse_json_object('префикс {"action": "none", "reply": "ок"} хвост')
    assert payload == {"action": "none", "reply": "ок"}


@pytest.mark.parametrize(
    "content",
    ["", "нет объекта", "{broken", "[1, 2]", "null"],
)
def test_parse_json_object_rejects_garbage(content: str) -> None:
    with pytest.raises(BadGateway):
        llm.parse_json_object(content)


def test_message_text_openai_shape() -> None:
    text = llm.message_text({"choices": [{"message": {"content": '{"a": 1}'}}]})
    assert text == '{"a": 1}'


def test_message_text_ollama_shape() -> None:
    text = llm.message_text({"message": {"content": '{"a": 1}'}})
    assert text == '{"a": 1}'


def test_message_text_rejects_unknown_shape() -> None:
    with pytest.raises(BadGateway):
        llm.message_text({"choices": []})


def test_require_key_without_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(llm.settings, "llm_api_key", None)
    with pytest.raises(ServiceUnavailable):
        llm._require_key()


def test_request_uses_openai_chat_completions(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(llm.settings, "llm_base_url", "https://api.openai.com/v1")
    url, body = llm._request("gpt-4o-mini", [{"role": "user", "content": "hi"}])
    assert url.endswith("/chat/completions")
    assert body["response_format"] == {"type": "json_object"}


def test_request_uses_ollama_on_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(llm.settings, "llm_base_url", "http://127.0.0.1:11434")
    url, body = llm._request("llama", [{"role": "user", "content": "hi"}])
    assert url.endswith("/api/chat")
    assert body["format"] == "json"
    assert "response_format" not in body
