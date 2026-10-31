from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from app.schemas.item import ItemRead
from app.services.delete_match import choice_index, resolve_delete

ZONE = ZoneInfo("Europe/Moscow")
NOW = datetime(2026, 10, 31, 12, 0, tzinfo=ZONE)


def _task(item_id: int, title: str, hour: int) -> ItemRead:
    moment = datetime(2026, 11, 1, hour - 3, 0, tzinfo=timezone.utc)
    stamp = datetime(2026, 10, 31, tzinfo=timezone.utc)
    return ItemRead(
        id=item_id,
        item_type="task",
        status="planned",
        title=title,
        description=None,
        start_at=None,
        end_at=None,
        due_on=None,
        due_at=moment,
        remind_at=None,
        workspace_id=1,
        created_at=stamp,
        updated_at=stamp,
    )


def test_named_time_deletes_that_task_only() -> None:
    items = [_task(1, "Прием", 10), _task(2, "Отчёт", 10)]
    decision = resolve_delete(items, "удали задачу прием завтра в 10:00", NOW)
    assert decision.item_id == 1
    assert decision.choices == ()


def test_same_day_without_a_unique_name_asks() -> None:
    items = [_task(1, "Прием", 10), _task(2, "Отчёт", 15)]
    decision = resolve_delete(items, "удали задачу завтра", NOW)
    assert decision.item_id is None
    assert set(decision.choices) == {1, 2}
    assert "Прием" in decision.text
    assert "Отчёт" in decision.text


def test_choice_index_reads_the_button_label() -> None:
    assert choice_index("первую") == 1
    assert choice_index("четвёртую") == 4
    assert choice_index("номер 2") == 2
    assert choice_index("удали другую") is None
