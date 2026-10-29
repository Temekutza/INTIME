from dataclasses import dataclass
from datetime import date, datetime

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.item_status import ItemStatus
from app.models.planner_item import PlannerItem

OwnedItem = tuple[PlannerItem, str]


@dataclass(frozen=True)
class ItemFilters:
    item_type: str | None
    status: str | None
    query: str | None
    start: datetime | None
    end: datetime | None
    start_date: date | None
    end_date: date | None
    limit: int
    offset: int


def _like(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _filtered(user_id: int, filters: ItemFilters):
    stmt = (
        select(PlannerItem, ItemStatus.code)
        .join(ItemStatus, PlannerItem.status_id == ItemStatus.id)
        .where(PlannerItem.user_id == user_id)
    )
    if filters.item_type is not None:
        stmt = stmt.where(PlannerItem.item_type_code == filters.item_type)
    if filters.status is not None:
        stmt = stmt.where(ItemStatus.code == filters.status)
    if filters.query:
        pattern = _like(filters.query)
        stmt = stmt.where(
            or_(
                PlannerItem.title.ilike(pattern, escape="\\"),
                PlannerItem.description.ilike(pattern, escape="\\"),
            )
        )
    window = []
    for column in (
        PlannerItem.start_at,
        PlannerItem.end_at,
        PlannerItem.due_at,
        PlannerItem.remind_at,
    ):
        parts = []
        if filters.start is not None:
            parts.append(column >= filters.start)
        if filters.end is not None:
            parts.append(column <= filters.end)
        if parts:
            window.append(and_(column.is_not(None), *parts))
    if filters.start_date is not None or filters.end_date is not None:
        parts = [PlannerItem.due_on.is_not(None)]
        if filters.start_date is not None:
            parts.append(PlannerItem.due_on >= filters.start_date)
        if filters.end_date is not None:
            parts.append(PlannerItem.due_on <= filters.end_date)
        window.append(and_(*parts))
    if window:
        stmt = stmt.where(or_(*window))
    return stmt


async def list_items(session: AsyncSession, user_id: int, filters: ItemFilters) -> tuple[list[OwnedItem], int]:
    filtered = _filtered(user_id, filters).subquery()
    total = await session.scalar(select(func.count()).select_from(filtered))
    rows = await session.execute(
        _filtered(user_id, filters)
        .order_by(
            func.coalesce(
                PlannerItem.start_at,
                PlannerItem.due_at,
                PlannerItem.remind_at,
                PlannerItem.created_at,
            ),
            PlannerItem.id,
        )
        .limit(filters.limit)
        .offset(filters.offset)
    )
    return [(row[0], row[1]) for row in rows.all()], int(total or 0)


async def get_item(session: AsyncSession, user_id: int, item_id: int) -> OwnedItem | None:
    row = await session.execute(
        select(PlannerItem, ItemStatus.code)
        .join(ItemStatus, PlannerItem.status_id == ItemStatus.id)
        .where(PlannerItem.user_id == user_id, PlannerItem.id == item_id)
    )
    found = row.first()
    if found is None:
        return None
    return found[0], found[1]


def add(session: AsyncSession, item: PlannerItem) -> None:
    session.add(item)


async def delete_item(session: AsyncSession, item: PlannerItem) -> None:
    await session.delete(item)
