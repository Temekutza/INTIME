from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.auth_session import AuthSession
from app.models.user import User


async def get_by_login(session: AsyncSession, login: str) -> User | None:
    return await session.scalar(select(User).where(func.lower(User.login) == login.lower()))


async def login_taken(session: AsyncSession, login: str, *, except_id: int | None = None) -> bool:
    stmt = select(User.id).where(func.lower(User.login) == login.lower())
    if except_id is not None:
        stmt = stmt.where(User.id != except_id)
    return await session.scalar(stmt) is not None


async def email_taken(session: AsyncSession, email: str, *, except_id: int | None = None) -> bool:
    stmt = select(User.id).where(func.lower(User.email) == email.lower())
    if except_id is not None:
        stmt = stmt.where(User.id != except_id)
    return await session.scalar(stmt) is not None


def add(session: AsyncSession, user: User) -> None:
    session.add(user)


async def get_by_token_hash(session: AsyncSession, token_hash: str) -> User | None:
    return await session.scalar(
        select(User)
        .join(AuthSession, AuthSession.user_id == User.id)
        .where(
            AuthSession.token_hash == token_hash,
            AuthSession.expires_at > datetime.now(timezone.utc),
        )
    )
