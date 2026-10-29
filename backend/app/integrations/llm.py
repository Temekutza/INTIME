import json
import os
from urllib.parse import urlsplit

import httpx

from app.core.config import settings
from app.core.errors import BadGateway, ServiceUnavailable

_LOOPBACK = frozenset({"127.0.0.1", "localhost", "::1"})


def _require_key() -> str:
    key = (settings.llm_api_key or "").strip()
    if not key:
        raise ServiceUnavailable("LLM не настроен: задайте LLM_API_KEY")
    return key


def _ollama_ports() -> set[int]:
    ports = {11434}
    raw = os.environ.get("OLLAMA_HOST", "").strip()
    if not raw:
        return ports
    if "://" not in raw:
        raw = "http://" + raw
    parsed = urlsplit(raw)
    if parsed.hostname:
        ports.add(parsed.port or 11434)
    return ports


def _request(model: str, messages: list[dict[str, str]]) -> tuple[str, dict]:
    base = settings.llm_base_url.rstrip("/")
    parsed = urlsplit(base)
    host = (parsed.hostname or "").lower()
    if host in _LOOPBACK and parsed.port in _ollama_ports():
        host_text = f"[{host}]" if ":" in host else host
        url = f"{parsed.scheme}://{host_text}:{parsed.port}/api/chat"
        return url, {
            "model": model,
            "messages": messages,
            "stream": False,
            "think": False,
            "format": "json",
            "options": {"temperature": 0},
        }
    return base + "/chat/completions", {
        "model": model,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": messages,
    }


def message_text(payload: dict) -> str:
    message = payload.get("message")
    if isinstance(message, dict) and "choices" not in payload:
        content = message.get("content")
        if isinstance(content, str):
            return content
    choices = payload.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        message = choices[0].get("message")
        if isinstance(message, dict) and isinstance(message.get("content"), str):
            return message["content"]
    raise BadGateway("Модель вернула непонятный ответ")


def parse_json_object(content: str) -> dict:
    text = content.strip()
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < start:
        raise BadGateway("Модель вернула непонятный ответ")
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError as exc:
        raise BadGateway("Модель вернула непонятный ответ") from exc
    if not isinstance(data, dict):
        raise BadGateway("Модель вернула непонятный ответ")
    return data


async def complete(messages: list[dict[str, str]]) -> dict:
    key = _require_key()
    url, body = _request(settings.llm_model, messages)
    try:
        async with httpx.AsyncClient(timeout=settings.llm_timeout) as client:
            response = await client.post(
                url,
                json=body,
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            )
    except httpx.HTTPError as exc:
        raise BadGateway("LLM не ответил") from exc
    if response.status_code >= 400:
        raise BadGateway("LLM не ответил")
    try:
        payload = response.json()
    except json.JSONDecodeError as exc:
        raise BadGateway("Модель вернула непонятный ответ") from exc
    if not isinstance(payload, dict):
        raise BadGateway("Модель вернула непонятный ответ")
    return parse_json_object(message_text(payload))
