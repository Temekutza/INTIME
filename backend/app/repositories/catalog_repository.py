from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.item_status import ItemStatus
from app.models.item_type import ItemType


async def list_types(session: AsyncSession) -> list[ItemType]:
    result = await session.scalars(select(ItemType).order_by(ItemType.code))
    return list(result)


async def get_type(session: AsyncSession, code: str) -> ItemType | None:
    return await session.get(ItemType, code)


async def list_statuses(session: AsyncSession, type_code: str) -> list[ItemStatus]:
    result = await session.scalars(
        select(ItemStatus).where(ItemStatus.item_type_code == type_code).order_by(ItemStatus.id)
    )
    return list(result)


async def get_status(session: AsyncSession, type_code: str, code: str) -> ItemStatus | None:
    return await session.scalar(
        select(ItemStatus).where(
            ItemStatus.item_type_code == type_code,
            ItemStatus.code == code,
        )
    )
