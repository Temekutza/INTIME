from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from app.core.errors import Unprocessable
from app.models.planner_item import PlannerItem
from app.schemas.item import ItemCreate
from app.services.ritm_map import (
    event_from_item,
    item_create_from_ritm,
    ritm_status,
    schedule_from_ritm,
)

UTC = timezone.utc
MOSCOW = ZoneInfo("Europe/Moscow")


def _item(**kwargs) -> PlannerItem:
    now = datetime(2026, 10, 31, 8, 0, tzinfo=UTC)
    values = {
        "id": 1,
        "user_id": 1,
        "item_type_code": "task",
        "status_id": 1,
        "title": "Черновик",
        "created_at": now,
        "updated_at": now,
    }
    values.update(kwargs)
    return PlannerItem(**values)


def test_status_mapping() -> None:
    assert ritm_status("todo") == "planned"
    assert ritm_status("scheduled") == "planned"
    assert ritm_status("done") == "done"


def test_task_due_on_is_deadline() -> None:
    event = event_from_item(_item(due_on=date(2028, 1, 2)), "todo", "Europe/Moscow")
    assert event.date == "2028-01-02"
    assert event.time is None
    assert event.is_deadline is True
    assert event.status == "planned"


def test_meeting_duration_and_local_time() -> None:
    start = datetime(2028, 6, 1, 11, 30, tzinfo=MOSCOW)
    end = datetime(2028, 6, 1, 12, 30, tzinfo=MOSCOW)
    event = event_from_item(
        _item(item_type_code="meeting", start_at=start, end_at=end),
        "scheduled",
        "Europe/Moscow",
    )
    assert event.date == "2028-06-01"
    assert event.time == "11:30"
    assert event.duration_min == 60
    assert event.is_deadline is False


def test_schedule_meeting_requires_date_and_time() -> None:
    with pytest.raises(Unprocessable):
        schedule_from_ritm(
            item_type="meeting",
            day="2028-06-01",
            clock=None,
            duration_min=60,
            is_deadline=False,
            timezone="Europe/Moscow",
        )


def test_item_create_from_ritm_task_with_time_is_not_deadline() -> None:
    data = item_create_from_ritm(
        item_type="task",
        title="Позвонить",
        day="2028-06-01",
        clock="18:00",
        duration_min=None,
        is_deadline=False,
        timezone="Europe/Moscow",
    )
    assert isinstance(data, ItemCreate)
    assert data.start_at is not None
    assert data.due_on is None
    assert data.due_at is None
