from datetime import date, datetime
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import persist
from app.core.errors import NotFound, Unprocessable
from app.models.planner_item import PlannerItem
from app.models.user import User
from app.repositories import catalog_repository, item_repository
from app.repositories.item_repository import ItemFilters
from app.schemas.item import ItemCreate, ItemList, ItemQuery, ItemRead, ItemUpdate

DEFAULT_STATUS = {
    "task": "todo",
    "meeting": "scheduled",
    "reminder": "pending",
}


def to_read(item: PlannerItem, status: str) -> ItemRead:
    return ItemRead(
        id=item.id,
        item_type=item.item_type_code,  # type: ignore[arg-type]
        status=status,
        title=item.title,
        description=item.description,
        start_at=item.start_at,
        end_at=item.end_at,
        due_on=item.due_on,
        due_at=item.due_at,
        remind_at=item.remind_at,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


def validate_schedule(
    *,
    item_type: str,
    start_at: datetime | None,
    end_at: datetime | None,
    due_on: date | None,
    due_at: datetime | None,
    remind_at: datetime | None,
) -> None:
    if end_at is not None and (start_at is None or end_at <= start_at):
        raise Unprocessable("Время конца должно быть позже начала")
    if due_on is not None and due_at is not None:
        raise Unprocessable("Укажите либо день срока, либо точное время")
    if item_type == "meeting" and start_at is None:
        raise Unprocessable("У встречи должно быть время начала")
    if item_type == "reminder" and remind_at is None:
        raise Unprocessable("У напоминания должно быть время")


async def create_item(session: AsyncSession, user: User, data: ItemCreate) -> ItemRead:
    status_code = data.status or DEFAULT_STATUS[data.item_type]
    status = await catalog_repository.get_status(session, data.item_type, status_code)
    if status is None:
        raise Unprocessable("Неизвестный статус для этого типа")
    validate_schedule(
        item_type=data.item_type,
        start_at=data.start_at,
        end_at=data.end_at,
        due_on=data.due_on,
        due_at=data.due_at,
        remind_at=data.remind_at,
    )
    item = PlannerItem(
        user_id=user.id,
        item_type_code=data.item_type,
        status_id=status.id,
        title=data.title,
        description=data.description,
        start_at=data.start_at,
        end_at=data.end_at,
        due_on=data.due_on,
        due_at=data.due_at,
        remind_at=data.remind_at,
    )
    item_repository.add(session, item)
    await session.flush()
    await persist(session)
    await session.refresh(item)
    return to_read(item, status.code)


async def list_items(session: AsyncSession, user: User, query: ItemQuery) -> ItemList:
    if query.start and query.end and query.start > query.end:
        raise Unprocessable("Начало интервала позже конца")
    zone = ZoneInfo(user.timezone)
    text = query.q.strip() if query.q else None
    filters = ItemFilters(
        item_type=query.item_type,
        status=query.status.lower() if query.status else None,
        query=text or None,
        start=query.start,
        end=query.end,
        start_date=query.start.astimezone(zone).date() if query.start else None,
        end_date=query.end.astimezone(zone).date() if query.end else None,
        limit=query.limit,
        offset=query.offset,
    )
    rows, total = await item_repository.list_items(session, user.id, filters)
    return ItemList(items=[to_read(item, status) for item, status in rows], total=total)


async def get_item(session: AsyncSession, user: User, item_id: int) -> ItemRead:
    found = await item_repository.get_item(session, user.id, item_id)
    if found is None:
        raise NotFound("Запись не найдена")
    item, status = found
    return to_read(item, status)


async def update_item(session: AsyncSession, user: User, item_id: int, data: ItemUpdate) -> ItemRead:
    found = await item_repository.get_item(session, user.id, item_id)
    if found is None:
        raise NotFound("Запись не найдена")
    item, current_status = found
    fields = data.model_dump(exclude_unset=True)
    new_type = fields.get("item_type", item.item_type_code)
    if "item_type" in fields and new_type != item.item_type_code and "status" not in fields:
        raise Unprocessable("При смене типа укажите статус нового типа")
    if "due_on" in fields and "due_at" in fields and fields["due_on"] and fields["due_at"]:
        raise Unprocessable("Укажите либо день срока, либо точное время")
    if fields.get("due_on"):
        fields["due_at"] = None
    elif fields.get("due_at"):
        fields["due_on"] = None

    status_code = fields.get("status", current_status)
    status = await catalog_repository.get_status(session, new_type, status_code)
    if status is None:
        raise Unprocessable("Неизвестный статус для этого типа")

    for name in ("title", "description", "start_at", "end_at", "due_on", "due_at", "remind_at"):
        if name in fields:
            setattr(item, name, fields[name])
    item.item_type_code = new_type
    item.status_id = status.id
    validate_schedule(
        item_type=item.item_type_code,
        start_at=item.start_at,
        end_at=item.end_at,
        due_on=item.due_on,
        due_at=item.due_at,
        remind_at=item.remind_at,
    )
    await session.flush()
    await persist(session)
    await session.refresh(item)
    return to_read(item, status.code)


async def delete_item(session: AsyncSession, user: User, item_id: int) -> None:
    found = await item_repository.get_item(session, user.id, item_id)
    if found is None:
        raise NotFound("Запись не найдена")
    await item_repository.delete_item(session, found[0])
    await persist(session)
