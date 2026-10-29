from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.endpoints.auth import _user_read
from app.core.database import get_session
from app.core.security import CurrentUser
from app.schemas.auth import UserRead, UserUpdate
from app.services import auth_service

router = APIRouter()


@router.get("/me", response_model=UserRead)
async def read_me(user: CurrentUser) -> UserRead:
    return _user_read(user)


@router.patch("/me", response_model=UserRead)
async def update_me(
    data: UserUpdate,
    user: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> UserRead:
    updated = await auth_service.update_profile(session, user, data)
    return _user_read(updated)
