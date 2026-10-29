from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session
from app.core.security import CurrentUser
from app.schemas.assistant import AssistantMessageRequest, AssistantMessageResponse
from app.services import assistant_service

router = APIRouter()


@router.post("/messages", response_model=AssistantMessageResponse)
async def create_message(
    data: AssistantMessageRequest,
    user: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AssistantMessageResponse:
    return await assistant_service.handle_message(session, user, data.text)
