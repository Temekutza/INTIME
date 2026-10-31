from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session
from app.core.errors import Unprocessable
from app.core.security import CurrentUser
from app.schemas.item import ItemCreate, ItemList, ItemQuery, ItemRead, ItemUpdate
from app.services import item_service

router = APIRouter()


def _aware(value: datetime | None, name: str) -> datetime | None:
    if value is not None and value.tzinfo is None:
        raise Unprocessable(f"У параметра {name} укажите часовой пояс")
    return value


@router.post("", response_model=ItemRead, status_code=201)
async def create_item(
    data: ItemCreate,
    user: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ItemRead:
    return await item_service.create_item(session, user, data)


@router.get("", response_model=ItemList)
async def list_items(
    user: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
    item_type: Annotated[Literal["task", "meeting", "reminder"] | None, Query()] = None,
    status: Annotated[str | None, Query()] = None,
    q: Annotated[str | None, Query(max_length=200)] = None,
    start: Annotated[datetime | None, Query(alias="from")] = None,
    end: Annotated[datetime | None, Query(alias="to")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    workspace_id: Annotated[int | None, Query(ge=1)] = None,
) -> ItemList:
    query = ItemQuery(
        item_type=item_type,
        status=status,
        q=q,
        start=_aware(start, "from"),
        end=_aware(end, "to"),
        limit=limit,
        offset=offset,
        workspace_id=workspace_id,
    )
    return await item_service.list_items(session, user, query)


@router.get("/{item_id}", response_model=ItemRead)
async def get_item(
    item_id: int,
    user: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ItemRead:
    return await item_service.get_item(session, user, item_id)


@router.patch("/{item_id}", response_model=ItemRead)
async def update_item(
    item_id: int,
    data: ItemUpdate,
    user: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ItemRead:
    return await item_service.update_item(session, user, item_id, data)


@router.delete("/{item_id}", status_code=204)
async def delete_item(
    item_id: int,
    user: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Response:
    await item_service.delete_item(session, user, item_id)
    return Response(status_code=204)
