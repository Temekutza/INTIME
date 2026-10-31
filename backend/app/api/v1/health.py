"""Liveness и readiness. Не дергают LLM/STT/TTS и не пишут в БД."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.database import engine

logger = logging.getLogger(__name__)

router = APIRouter()

LIVE_OK = {"status": "ok"}
READY_OK = {"status": "ok", "database": "ok"}
READY_FAIL = {"status": "error", "database": "unavailable"}
READINESS_TIMEOUT_SEC = 3.0


@router.get("/live")
async def live() -> dict[str, str]:
    return LIVE_OK


async def _select_one() -> None:
    async with engine.connect() as connection:
        await connection.execute(text("SELECT 1"))


async def probe_database() -> bool:
    try:
        await asyncio.wait_for(_select_one(), timeout=READINESS_TIMEOUT_SEC)
    except Exception as exc:
        logger.warning("readiness: database check failed error=%s", type(exc).__name__)
        return False
    return True


async def readiness_response() -> JSONResponse:
    if await probe_database():
        return JSONResponse(status_code=200, content=READY_OK)
    return JSONResponse(status_code=503, content=READY_FAIL)


@router.get("/health")
async def health() -> JSONResponse:
    return await readiness_response()
