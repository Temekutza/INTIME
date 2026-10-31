from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.core.errors import Unprocessable
from app.models.planner_item import PlannerItem
from app.schemas.item import ItemCreate
from app.schemas.ritm import EventType, RitmEvent
from app.services.item_service import DEFAULT_STATUS

def zone_of(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError as exc:
        raise Unprocessable("Неизвестный часовой пояс") from exc


def ritm_status(code: str) -> str:
    return "done" if code == "done" else "planned"


def open_status(item_type: str) -> str:
    return DEFAULT_STATUS[item_type]


def event_from_item(item: PlannerItem, status: str, timezone: str) -> RitmEvent:
    zone = zone_of(timezone)
    kind = item.item_type_code
    day, clock, duration, deadline = _public_schedule(item, kind, zone)
    return RitmEvent(
        id=item.id,
        type=kind,  # type: ignore[arg-type]
        title=item.title,
        date=day,
        time=clock,
        duration_min=duration,
        is_deadline=deadline,
        status=ritm_status(status),  # type: ignore[arg-type]
        source="user",
        source_ref=None,
        created_at=_stamp(item.created_at),
        updated_at=_stamp(item.updated_at),
        deleted_at=_stamp(item.deleted_at) if item.deleted_at else None,
    )


def item_create_from_ritm(
    *,
    item_type: EventType,
    title: str,
    day: str | None,
    clock: str | None,
    duration_min: int | None,
    is_deadline: bool,
    timezone: str,
) -> ItemCreate:
    schedule = schedule_from_ritm(
        item_type=item_type,
        day=day,
        clock=clock,
        duration_min=duration_min,
        is_deadline=is_deadline,
        timezone=timezone,
    )
    return ItemCreate(item_type=item_type, title=title, **schedule)


def schedule_from_ritm(
    *,
    item_type: str,
    day: str | None,
    clock: str | None,
    duration_min: int | None,
    is_deadline: bool,
    timezone: str,
) -> dict:
    zone = zone_of(timezone)
    parsed_day = _parse_day(day)
    if clock and parsed_day is None:
        raise Unprocessable("Для времени укажите дату")
    if item_type in {"meeting", "reminder"} and (parsed_day is None or not clock):
        raise Unprocessable("Для встречи или напоминания нужны дата и время")
    if duration_min is not None and (duration_min < 1 or duration_min > 1440):
        raise Unprocessable("Укажите длительность от 1 до 1440 минут")
    moment = _combine(parsed_day, clock, zone) if parsed_day and clock else None
    start_at = end_at = due_on = due_at = remind_at = None
    if item_type == "meeting":
        start_at = moment
        minutes = duration_min if duration_min is not None else 60
        if start_at is not None:
            end_at = start_at + timedelta(minutes=minutes)
    elif item_type == "reminder":
        remind_at = moment
    elif is_deadline and moment is not None:
        due_at = moment
    elif is_deadline and parsed_day is not None:
        due_on = parsed_day
    elif moment is not None:
        start_at = moment
    elif parsed_day is not None:
        due_on = parsed_day
    return {
        "start_at": start_at,
        "end_at": end_at,
        "due_on": due_on,
        "due_at": due_at,
        "remind_at": remind_at,
    }


def is_past(day: str | None, clock: str | None, tz_name: str) -> bool:
    if not day:
        return False
    zone = zone_of(tz_name)
    now = datetime.now(timezone.utc).astimezone(zone)
    parsed = _parse_day(day)
    if parsed is None:
        return False
    if clock:
        return _combine(parsed, clock, zone) < now
    return parsed < now.date()


def apply_schedule(item: PlannerItem, *, day: str | None, clock: str | None, timezone: str) -> None:
    duration = None
    if item.start_at and item.end_at:
        duration = max(1, int((item.end_at - item.start_at).total_seconds() // 60))
    deadline = item.due_on is not None or item.due_at is not None
    schedule = schedule_from_ritm(
        item_type=item.item_type_code,
        day=day,
        clock=clock,
        duration_min=duration,
        is_deadline=deadline,
        timezone=timezone,
    )
    item.start_at = schedule["start_at"]
    item.end_at = schedule["end_at"]
    item.due_on = schedule["due_on"]
    item.due_at = schedule["due_at"]
    item.remind_at = schedule["remind_at"]


def proposal_card(
    *,
    item_type: str,
    title: str,
    day: str | None,
    clock: str | None,
    duration_min: int | None,
    color: str | None,
    is_deadline: bool = False,
    intent: str = "create",
) -> dict:
    return {
        "intent": intent,
        "event_type": item_type,
        "title": title,
        "date": day,
        "time": clock,
        "duration_min": duration_min if item_type == "meeting" else None,
        "is_deadline": bool(is_deadline),
        "color": color,
    }


def card_from_create(data: ItemCreate, color: str | None, timezone: str) -> dict:
    item = PlannerItem(
        id=0,
        user_id=0,
        item_type_code=data.item_type,
        status_id=0,
        title=data.title,
        description=data.description,
        start_at=data.start_at,
        end_at=data.end_at,
        due_on=data.due_on,
        due_at=data.due_at,
        remind_at=data.remind_at,
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )
    day, clock, duration, deadline = _public_schedule(item, data.item_type, zone_of(timezone))
    return proposal_card(
        item_type=data.item_type,
        title=data.title,
        day=day,
        clock=clock,
        duration_min=duration,
        color=color,
        is_deadline=deadline,
    )


def _public_schedule(
    item: PlannerItem, kind: str, zone: ZoneInfo
) -> tuple[str | None, str | None, int | None, bool]:
    if kind == "meeting":
        day, clock = _parts(item.start_at, zone)
        duration = None
        if item.start_at and item.end_at:
            duration = max(1, int((item.end_at - item.start_at).total_seconds() // 60))
        return day, clock, duration, False
    if kind == "reminder":
        day, clock = _parts(item.remind_at, zone)
        return day, clock, None, False
    if item.due_at is not None:
        day, clock = _parts(item.due_at, zone)
        return day, clock, None, True
    if item.due_on is not None:
        return item.due_on.isoformat(), None, None, True
    day, clock = _parts(item.start_at, zone)
    duration = None
    if item.start_at and item.end_at:
        duration = max(1, int((item.end_at - item.start_at).total_seconds() // 60))
    return day, clock, duration, False


def _parts(moment: datetime | None, zone: ZoneInfo) -> tuple[str | None, str | None]:
    if moment is None:
        return None, None
    local = moment.astimezone(zone)
    return local.date().isoformat(), local.strftime("%H:%M")


def _parse_day(value: str | None) -> date | None:
    if value is None or not value.strip():
        return None
    text = value.strip()
    try:
        year, month, day = (int(part) for part in text.split("-"))
        parsed = date(year, month, day)
    except ValueError as exc:
        raise Unprocessable("Проверьте дату") from exc
    if parsed.isoformat() != text:
        raise Unprocessable("Проверьте дату")
    return parsed


def _combine(day: date, clock: str, zone: ZoneInfo) -> datetime:
    text = clock.strip()
    parts = text.split(":")
    try:
        hour = int(parts[0])
        minute = int(parts[1]) if len(parts) > 1 else 0
    except (ValueError, IndexError) as exc:
        raise Unprocessable("Проверьте время") from exc
    if hour > 23 or minute > 59:
        raise Unprocessable("Проверьте время")
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=zone)


def _stamp(value: datetime) -> str:
    return value.isoformat()
