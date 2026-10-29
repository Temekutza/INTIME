import httpx

from app.core.config import settings
from app.core.errors import BadGateway, ServiceUnavailable


def _key() -> str:
    return (settings.stt_api_key or settings.llm_api_key or "").strip()


def _base_url() -> str:
    return (settings.stt_base_url or settings.llm_base_url).rstrip("/")


async def transcribe(filename: str, content: bytes, content_type: str) -> str:
    key = _key()
    if not key:
        raise ServiceUnavailable("Распознавание не настроено: задайте STT_API_KEY или LLM_API_KEY")
    try:
        async with httpx.AsyncClient(timeout=settings.llm_timeout) as client:
            response = await client.post(
                _base_url() + "/audio/transcriptions",
                headers={"Authorization": f"Bearer {key}"},
                data={"model": settings.stt_model},
                files={"file": (filename, content, content_type)},
            )
    except httpx.HTTPError as exc:
        raise BadGateway("Сервис распознавания не ответил") from exc
    if response.status_code >= 400:
        raise BadGateway("Сервис распознавания не ответил")
    try:
        payload = response.json()
    except ValueError as exc:
        raise BadGateway("Сервис распознавания вернул непонятный ответ") from exc
    text = payload.get("text") if isinstance(payload, dict) else None
    if not isinstance(text, str) or not text.strip():
        raise BadGateway("Сервис распознавания вернул пустой текст")
    return text.strip()
