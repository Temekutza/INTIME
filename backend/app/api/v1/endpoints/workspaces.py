from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session
from app.core.security import CurrentUser
from app.schemas.workspace import WorkspaceCreate, WorkspaceList, WorkspaceRead, WorkspaceUpdate
from app.services import workspace_service

router = APIRouter()


@router.get("", response_model=WorkspaceList)
async def list_workspaces(
    user: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> WorkspaceList:
    return await workspace_service.list_workspaces(session, user)


@router.post("", response_model=WorkspaceRead, status_code=201)
async def create_workspace(
    data: WorkspaceCreate,
    user: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> WorkspaceRead:
    return await workspace_service.create_workspace(session, user, data)


@router.patch("/{workspace_id}", response_model=WorkspaceRead)
async def update_workspace(
    workspace_id: int,
    data: WorkspaceUpdate,
    user: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> WorkspaceRead:
    return await workspace_service.rename_workspace(session, user, workspace_id, data)
