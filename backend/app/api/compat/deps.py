from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_session
from app.core.errors import ServiceUnavailable, Unauthorized
from app.core.security import hash_token, token_from_request
from app.models.user import User
from app.repositories import user_repository

_bearer = HTTPBearer(auto_error=False)


async def get_compat_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> User:
    token = token_from_request(request, credentials)
    if token:
        user = await user_repository.get_by_token_hash(session, hash_token(token))
        if user is None:
            raise Unauthorized("Требуется вход")
        return user
    login = (settings.compat_user_login or "").strip()
    if not login:
        raise ServiceUnavailable("Нет демо-пользователя: задайте COMPAT_USER_LOGIN")
    user = await user_repository.get_by_login(session, login)
    if user is None:
        raise ServiceUnavailable("Демо-пользователь не найден")
    return user


CompatUser = Annotated[User, Depends(get_compat_user)]
