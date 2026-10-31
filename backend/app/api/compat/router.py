from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.compat.deps import CompatUser
from app.api.v1.health import readiness_response
from app.core.database import get_session
from app.schemas.workspace import WorkspaceCreate, WorkspaceList, WorkspaceRead, WorkspaceUpdate
from app.schemas.ritm import (
    ColorBody,
    ColorDefaultResponse,
    ColorOverrideResponse,
    ColorSnapshot,
    EventCreateRequest,
    EventListResponse,
    EventPatchRequest,
    EventType,
    EventStatus,
    HistoryResponse,
    MessageRequest,
    ReplyResponse,
    RitmEvent,
    SearchResponse,
    TranscriptionOut,
)
from app.services import compat_service, workspace_service

router = APIRouter()


@router.get("/workspaces", response_model=WorkspaceList)
async def list_workspaces(
    user: CompatUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> WorkspaceList:
    return await workspace_service.list_workspaces(session, user)


@router.post("/workspaces", response_model=WorkspaceRead, status_code=201)
async def create_workspace(
    data: WorkspaceCreate,
    user: CompatUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> WorkspaceRead:
    return await workspace_service.create_workspace(session, user, data)


@router.patch("/workspaces/{workspace_id}", response_model=WorkspaceRead)
async def update_workspace(
    workspace_id: int,
    data: WorkspaceUpdate,
    user: CompatUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> WorkspaceRead:
    return await workspace_service.rename_workspace(session, user, workspace_id, data)


@router.get("/health")
async def health() -> JSONResponse:
    return await readiness_response()


@router.get("/events", response_model=EventListResponse)
async def list_events(
    user: CompatUser,
    session: Annotated[AsyncSession, Depends(get_session)],
    type: Annotated[EventType | None, Query()] = None,
    status: Annotated[EventStatus | None, Query()] = None,
    workspace_id: Annotated[int | None, Query(ge=1)] = None,
) -> EventListResponse:
    return await compat_service.list_events(
        session, user, item_type=type, status=status, workspace_id=workspace_id
    )


@router.post("/events", response_model=ReplyResponse)
async def create_event(
    data: EventCreateRequest,
    user: CompatUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ReplyResponse:
    return await compat_service.create_event(session, user, data)


@router.get("/events/{event_id}", response_model=RitmEvent)
async def get_event(
    event_id: int,
    user: CompatUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> RitmEvent:
    return await compat_service.get_event(session, user, event_id)


@router.patch("/events/{event_id}", response_model=RitmEvent)
async def patch_event(
    event_id: int,
    data: EventPatchRequest,
    user: CompatUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> RitmEvent:
    return await compat_service.patch_event(session, user, event_id, data)


@router.delete("/events/{event_id}", status_code=204)
async def delete_event(
    event_id: int,
    user: CompatUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Response:
    await compat_service.delete_event(session, user, event_id)
    return Response(status_code=204)


@router.patch("/events/{event_id}/color", response_model=ColorOverrideResponse)
async def patch_event_color(
    event_id: int,
    data: ColorBody,
    user: CompatUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ColorOverrideResponse:
    return await compat_service.set_event_color(session, user, event_id, data.color)


@router.get("/search", response_model=SearchResponse)
async def search_events(
    user: CompatUser,
    session: Annotated[AsyncSession, Depends(get_session)],
    q: Annotated[str, Query(max_length=200)] = "",
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    workspace_id: Annotated[int | None, Query(ge=1)] = None,
) -> SearchResponse:
    return await compat_service.search_events(session, user, q, limit, workspace_id)


@router.get("/colors", response_model=ColorSnapshot)
async def get_colors(
    user: CompatUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ColorSnapshot:
    return await compat_service.color_snapshot(session, user)


@router.patch("/colors/defaults/{event_type}", response_model=ColorDefaultResponse)
async def patch_default_color(
    event_type: Literal["task", "meeting", "reminder"],
    data: ColorBody,
    user: CompatUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ColorDefaultResponse:
    return await compat_service.set_default_color(session, user, event_type, data.color)


@router.post("/message", response_model=ReplyResponse)
async def post_message(
    data: MessageRequest,
    user: CompatUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ReplyResponse:
    return await compat_service.handle_message(session, user, data)


@router.get("/history", response_model=HistoryResponse)
async def get_history(
    user: CompatUser,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_id: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> HistoryResponse:
    return await compat_service.history(session, user, session_id, limit)


@router.post("/speech", response_model=TranscriptionOut)
async def post_speech(
    _: CompatUser,
    request: Request,
) -> TranscriptionOut:
    payload = await request.body()
    return await compat_service.transcribe_pcm(payload)
