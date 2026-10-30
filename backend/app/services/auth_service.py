from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import persist
from app.core.errors import Conflict, Unauthorized
from app.core.security import hash_password, hash_token, new_token, session_expires_at, verify_password
from app.models.auth_session import AuthSession
from app.models.user import User
from app.repositories import user_repository
from app.schemas.auth import LoginRequest, RegisterRequest, UserUpdate


@dataclass(frozen=True)
class IssuedSession:
    user: User
    token: str
    expires_at: datetime


async def register(session: AsyncSession, data: RegisterRequest) -> IssuedSession:
    if await user_repository.login_taken(session, data.login):
        raise Conflict("Логин уже занят")
    if data.email and await user_repository.email_taken(session, data.email):
        raise Conflict("Почта уже занята")
    user = User(
        login=data.login,
        password_hash=hash_password(data.password),
        email=data.email,
        timezone=data.timezone,
    )
    user_repository.add(session, user)
    await session.flush()
    issued = await _open_session(session, user)
    await persist(session)
    await session.refresh(issued.user)
    return issued


async def login(session: AsyncSession, data: LoginRequest) -> IssuedSession:
    user = await user_repository.get_by_login(session, data.login.strip())
    if user is None or not verify_password(data.password, user.password_hash):
        raise Unauthorized("Неверный логин или пароль")
    issued = await _open_session(session, user)
    await persist(session)
    return issued


async def update_profile(session: AsyncSession, user: User, data: UserUpdate) -> User:
    fields = data.model_dump(exclude_unset=True)
    if "login" in fields and fields["login"] is not None:
        if await user_repository.login_taken(session, fields["login"], except_id=user.id):
            raise Conflict("Логин уже занят")
        user.login = fields["login"]
    if "email" in fields:
        email = fields["email"]
        if email and await user_repository.email_taken(session, email, except_id=user.id):
            raise Conflict("Почта уже занята")
        user.email = email
    if "timezone" in fields and fields["timezone"] is not None:
        user.timezone = fields["timezone"]
    await persist(session)
    await session.refresh(user)
    return user


async def _open_session(session: AsyncSession, user: User) -> IssuedSession:
    now = datetime.now(timezone.utc)
    await session.execute(
        delete(AuthSession).where(AuthSession.user_id == user.id, AuthSession.expires_at <= now)
    )
    token = new_token()
    expires_at = session_expires_at()
    session.add(AuthSession(user_id=user.id, token_hash=hash_token(token), expires_at=expires_at))
    await session.flush()
    return IssuedSession(user=user, token=token, expires_at=expires_at)
