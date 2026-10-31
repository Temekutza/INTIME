from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.planner_item import PlannerItem
from app.models.user_type_color import UserTypeColor


async def list_defaults(session: AsyncSession, user_id: int) -> list[UserTypeColor]:
    result = await session.scalars(
        select(UserTypeColor).where(UserTypeColor.user_id == user_id)
    )
    return list(result)


async def get_default(
    session: AsyncSession, user_id: int, item_type: str
) -> UserTypeColor | None:
    return await session.get(UserTypeColor, (user_id, item_type))


async def upsert_default(
    session: AsyncSession, user_id: int, item_type: str, color: str
) -> UserTypeColor:
    row = await get_default(session, user_id, item_type)
    if row is None:
        row = UserTypeColor(user_id=user_id, item_type_code=item_type, color=color)
        session.add(row)
        return row
    row.color = color
    return row


async def delete_default(session: AsyncSession, row: UserTypeColor) -> None:
    await session.delete(row)


async def list_overrides(session: AsyncSession, user_id: int) -> list[tuple[int, str]]:
    rows = await session.execute(
        select(PlannerItem.id, PlannerItem.color).where(
            PlannerItem.user_id == user_id,
            PlannerItem.color.is_not(None),
            PlannerItem.deleted_at.is_(None),
        )
    )
    return [(int(item_id), color) for item_id, color in rows.all() if color]
