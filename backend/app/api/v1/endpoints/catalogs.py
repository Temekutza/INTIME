from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session
from app.core.errors import NotFound
from app.core.security import CurrentUser
from app.repositories import catalog_repository
from app.schemas.item import ItemStatusRead, ItemTypeRead

router = APIRouter()


@router.get("/item-types", response_model=list[ItemTypeRead])
async def list_item_types(
    _: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> list[ItemTypeRead]:
    types = await catalog_repository.list_types(session)
    return [ItemTypeRead(code=item.code, name=item.name) for item in types]


@router.get("/item-types/{type}/statuses", response_model=list[ItemStatusRead])
async def list_statuses(
    type: str,
    _: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> list[ItemStatusRead]:
    item_type = await catalog_repository.get_type(session, type)
    if item_type is None:
        raise NotFound("Тип записи не найден")
    statuses = await catalog_repository.list_statuses(session, type)
    return [ItemStatusRead(code=item.code, name=item.name) for item in statuses]
