from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_session
from app.core.security import COOKIE_NAME
from app.schemas.auth import AuthResponse, LoginRequest, RegisterRequest, UserRead
from app.services import auth_service
from app.services.auth_service import IssuedSession

router = APIRouter()


def _user_read(user) -> UserRead:
    return UserRead(
        id=user.id,
        login=user.login,
        email=user.email,
        timezone=user.timezone,
        created_at=user.created_at,
    )


def _auth_response(issued: IssuedSession) -> AuthResponse:
    return AuthResponse(user=_user_read(issued.user), token=issued.token)


def _set_session_cookie(response: Response, issued: IssuedSession) -> None:
    max_age = max(1, int((issued.expires_at - datetime.now(timezone.utc)).total_seconds()))
    response.set_cookie(
        key=COOKIE_NAME,
        value=issued.token,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        max_age=max_age,
        path="/",
    )


@router.post("/register", response_model=AuthResponse, status_code=201)
async def register(
    data: RegisterRequest,
    response: Response,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AuthResponse:
    issued = await auth_service.register(session, data)
    _set_session_cookie(response, issued)
    return _auth_response(issued)


@router.post("/login", response_model=AuthResponse)
async def login(
    data: LoginRequest,
    response: Response,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AuthResponse:
    issued = await auth_service.login(session, data)
    _set_session_cookie(response, issued)
    return _auth_response(issued)
