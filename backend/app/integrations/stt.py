import logging

import httpx

from app.core.config import settings
from app.core.errors import BadGateway, ServiceUnavailable

logger = logging.getLogger(__name__)


def _key() -> str:
    # Пустая переменная отключает наследование: иначе речь уйдёт в чат-шлюз.
    if settings.stt_api_key is not None:
        return settings.stt_api_key.strip()
    return (settings.llm_api_key or "").strip()


def _base_url() -> str:
    if settings.stt_base_url is not None:
        return settings.stt_base_url.rstrip("/")
    return settings.llm_base_url.rstrip("/")


async def transcribe(filename: str, content: bytes, content_type: str) -> str:
    key = _key()
    if not key:
        raise ServiceUnavailable("Распознавание не настроено: задайте STT_API_KEY или LLM_API_KEY")
    url = _base_url() + "/audio/transcriptions"
    try:
        async with httpx.AsyncClient(timeout=settings.llm_timeout) as client:
            response = await client.post(
                url,
                headers={"Authorization": f"Bearer {key}"},
                data={"model": settings.stt_model},
                files={"file": (filename, content, content_type)},
            )
    except httpx.HTTPError as exc:
        logger.warning("STT request failed url=%s error=%s", url, type(exc).__name__)
        raise BadGateway("Сервис распознавания не ответил") from exc
    if response.status_code >= 400:
        logger.warning("STT bad status url=%s status=%s", url, response.status_code)
        raise BadGateway("Сервис распознавания не ответил")
    try:
        payload = response.json()
    except ValueError as exc:
        logger.warning("STT invalid JSON url=%s status=%s", url, response.status_code)
        raise BadGateway("Сервис распознавания вернул непонятный ответ") from exc
    text = payload.get("text") if isinstance(payload, dict) else None
    if not isinstance(text, str) or not text.strip():
        raise BadGateway("Сервис распознавания вернул пустой текст")
    return text.strip()
