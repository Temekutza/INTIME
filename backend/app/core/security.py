import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pwdlib import PasswordHash
from pwdlib.exceptions import PwdlibError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_session
from app.core.errors import Unauthorized
from app.models.user import User
from app.repositories import user_repository

_hasher = PasswordHash.recommended()
_bearer = HTTPBearer(auto_error=False)
COOKIE_NAME = "session"


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password, password_hash)
    except PwdlibError:
        return False


def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def session_expires_at() -> datetime:
    return datetime.now(timezone.utc) + timedelta(days=settings.session_ttl_days)


def token_from_request(request: Request, credentials: HTTPAuthorizationCredentials | None) -> str | None:
    if credentials is not None and credentials.scheme.lower() == "bearer" and credentials.credentials:
        return credentials.credentials
    cookie = request.cookies.get(COOKIE_NAME)
    return cookie or None


async def get_current_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> User:
    token = token_from_request(request, credentials)
    if not token:
        raise Unauthorized("Требуется вход")
    user = await user_repository.get_by_token_hash(session, hash_token(token))
    if user is None:
        raise Unauthorized("Требуется вход")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
