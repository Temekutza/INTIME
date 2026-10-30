from datetime import date, datetime, timezone

import pytest
from pydantic import ValidationError

from app.core.errors import Unprocessable
from app.services.item_service import DEFAULT_STATUS, validate_schedule
from app.schemas.item import ItemCreate, ItemQuery, ItemUpdate

UTC = timezone.utc
MOMENT = datetime(2026, 10, 30, 10, 0, tzinfo=UTC)
LATER = datetime(2026, 10, 30, 11, 0, tzinfo=UTC)
NAIVE = datetime(2026, 10, 30, 10, 0)


@pytest.mark.parametrize(
    ("item_type", "kwargs"),
    [
        ("task", {}),
        ("task", {"due_on": date(2026, 10, 30)}),
        ("task", {"due_at": MOMENT}),
        ("meeting", {"start_at": MOMENT}),
        ("meeting", {"start_at": MOMENT, "end_at": LATER}),
        ("reminder", {"remind_at": MOMENT}),
    ],
)
def test_validate_schedule_accepts_legal_payloads(item_type: str, kwargs: dict) -> None:
    validate_schedule(
        item_type=item_type,
        start_at=kwargs.get("start_at"),
        end_at=kwargs.get("end_at"),
        due_on=kwargs.get("due_on"),
        due_at=kwargs.get("due_at"),
        remind_at=kwargs.get("remind_at"),
    )


@pytest.mark.parametrize(
    "kwargs",
    [
        {"item_type": "meeting", "start_at": None},
        {"item_type": "reminder", "remind_at": None},
        {"item_type": "task", "due_on": date(2026, 10, 30), "due_at": MOMENT},
        {"item_type": "meeting", "start_at": LATER, "end_at": MOMENT},
        {"item_type": "meeting", "start_at": MOMENT, "end_at": MOMENT},
        {"item_type": "task", "end_at": LATER},
    ],
)
def test_validate_schedule_rejects_illegal_payloads(kwargs: dict) -> None:
    with pytest.raises(Unprocessable):
        validate_schedule(
            item_type=kwargs["item_type"],
            start_at=kwargs.get("start_at"),
            end_at=kwargs.get("end_at"),
            due_on=kwargs.get("due_on"),
            due_at=kwargs.get("due_at"),
            remind_at=kwargs.get("remind_at"),
        )


def test_default_status_covers_known_types() -> None:
    assert DEFAULT_STATUS == {
        "task": "todo",
        "meeting": "scheduled",
        "reminder": "pending",
    }


@pytest.mark.parametrize("title", ["", "   "])
def test_item_create_rejects_blank_title(title: str) -> None:
    with pytest.raises(ValidationError):
        ItemCreate(item_type="task", title=title)


def test_item_create_rejects_naive_datetime() -> None:
    with pytest.raises(ValidationError):
        ItemCreate(item_type="task", title="Отчёт", due_at=NAIVE)


def test_item_create_strips_title_and_description() -> None:
    item = ItemCreate(item_type="task", title="  Отчёт  ", description="  текст  ")
    assert item.title == "Отчёт"
    assert item.description == "текст"


def test_item_update_rejects_extra_fields() -> None:
    with pytest.raises(ValidationError):
        ItemUpdate.model_validate({"title": "x", "priority": "high"})


def test_item_query_limit_bounds() -> None:
    with pytest.raises(ValidationError):
        ItemQuery(limit=0)
    with pytest.raises(ValidationError):
        ItemQuery(limit=201)
    assert ItemQuery(limit=1).limit == 1
    assert ItemQuery(limit=200).limit == 200
