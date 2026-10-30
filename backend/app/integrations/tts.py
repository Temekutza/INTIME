import logging

import httpx

from app.core.config import settings
from app.core.errors import BadGateway, ServiceUnavailable

logger = logging.getLogger(__name__)


def _key() -> str:
    return (settings.tts_api_key or settings.llm_api_key or "").strip()


def _base_url() -> str:
    return (settings.tts_base_url or settings.llm_base_url).rstrip("/")


async def synthesize(text: str, voice: str | None) -> tuple[bytes, str]:
    key = _key()
    if not key:
        raise ServiceUnavailable("Синтез не настроен: задайте TTS_API_KEY или LLM_API_KEY")
    url = _base_url() + "/audio/speech"
    try:
        async with httpx.AsyncClient(timeout=settings.llm_timeout) as client:
            response = await client.post(
                url,
                headers={"Authorization": f"Bearer {key}"},
                json={
                    "model": settings.tts_model,
                    "input": text,
                    "voice": voice or settings.tts_voice,
                },
            )
    except httpx.HTTPError as exc:
        logger.warning("TTS request failed url=%s error=%s", url, type(exc).__name__)
        raise BadGateway("Сервис синтеза не ответил") from exc
    if response.status_code >= 400 or not response.content:
        logger.warning(
            "TTS bad response url=%s status=%s empty=%s",
            url,
            response.status_code,
            not response.content,
        )
        raise BadGateway("Сервис синтеза не ответил")
    media_type = response.headers.get("content-type", "audio/mpeg").split(";", 1)[0].strip()
    if not media_type.startswith("audio/"):
        media_type = "audio/mpeg"
    return response.content, media_type
