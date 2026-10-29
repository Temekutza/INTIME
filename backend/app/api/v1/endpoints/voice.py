from typing import Annotated

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import Response

from app.core.errors import Unprocessable
from app.core.security import CurrentUser
from app.integrations import stt, tts
from app.schemas.assistant import SpeechRequest, TranscriptionResponse

router = APIRouter()

_MAX_AUDIO_BYTES = 10 * 1024 * 1024
_AUDIO_TYPES = {
    "audio/wav",
    "audio/x-wav",
    "audio/mpeg",
    "audio/mp3",
    "audio/webm",
    "audio/ogg",
    "audio/mp4",
    "audio/x-m4a",
}
_AUDIO_SUFFIXES = {".wav", ".mp3", ".mpeg", ".webm", ".ogg", ".m4a", ".mp4"}


@router.post("/transcriptions", response_model=TranscriptionResponse)
async def transcribe(
    _: CurrentUser,
    file: Annotated[UploadFile, File()],
) -> TranscriptionResponse:
    content = await file.read()
    if not content:
        raise Unprocessable("Пустой аудиофайл")
    if len(content) > _MAX_AUDIO_BYTES:
        raise Unprocessable("Аудиофайл больше 10 МБ")
    content_type = (file.content_type or "").split(";", 1)[0].strip().lower()
    name = (file.filename or "audio").lower()
    suffix_ok = any(name.endswith(suffix) for suffix in _AUDIO_SUFFIXES)
    if content_type not in _AUDIO_TYPES and not (content_type in {"", "application/octet-stream"} and suffix_ok):
        raise Unprocessable("Нужен аудиофайл")
    text = await stt.transcribe(file.filename or "audio", content, content_type or "application/octet-stream")
    return TranscriptionResponse(text=text)


@router.post("/speech")
async def speak(_: CurrentUser, data: SpeechRequest) -> Response:
    audio, media_type = await tts.synthesize(data.text, data.voice)
    return Response(content=audio, media_type=media_type)
