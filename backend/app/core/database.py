from collections.abc import AsyncIterator
from typing import NoReturn

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import settings
from app.core.errors import Conflict, Unprocessable

engine = create_async_engine(settings.database_url, poolclass=NullPool)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

_CHECK_MESSAGES = {
    "valid_title": "Название не может быть пустым",
    "valid_interval": "Время конца должно быть позже начала",
    "valid_deadline": "Укажите либо день срока, либо точное время",
    "meeting_requires_start": "У встречи должно быть время начала",
    "reminder_requires_time": "У напоминания должно быть время",
    "known_item_type": "Неизвестный тип записи",
    "valid_login": "Некорректный логин",
    "valid_email": "Некорректная почта",
}


def _raise_from_integrity(exc: IntegrityError) -> NoReturn:
    orig = getattr(exc, "orig", None)
    sqlstate = getattr(orig, "sqlstate", None)
    constraint = getattr(orig, "constraint_name", None)
    if sqlstate == "23505":
        raise Conflict("Логин или почта уже заняты") from exc
    if sqlstate == "23503":
        raise Unprocessable("Неизвестный тип или статус") from exc
    if sqlstate == "23514":
        raise Unprocessable(_CHECK_MESSAGES.get(constraint or "", "Запись нарушает правила")) from exc
    raise exc


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        try:
            yield session
            await session.commit()
        except IntegrityError as exc:
            await session.rollback()
            _raise_from_integrity(exc)
        except Exception:
            await session.rollback()
            raise


async def persist(session: AsyncSession) -> None:
    """Пишет изменения в текущую транзакцию запроса. Commit делает get_session."""
    try:
        await session.flush()
    except IntegrityError as exc:
        await session.rollback()
        _raise_from_integrity(exc)
