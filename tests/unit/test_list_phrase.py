from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from app.schemas.item import ItemRead
from app.services.list_phrase import describe_items, match_list_phrase

ZONE = ZoneInfo("Europe/Moscow")
NOW = datetime(2026, 10, 28, 12, 0, tzinfo=ZONE)


def test_clear_questions_pick_the_asked_day() -> None:
    tomorrow = match_list_phrase("что у меня завтра", NOW)
    assert tomorrow is not None
    assert tomorrow.label == "На завтра"
    assert tomorrow.start is not None and tomorrow.start.date().isoformat() == "2026-10-29"
    assert tomorrow.item_type is None

    slight = match_list_phrase("а что там на завтра", NOW)
    assert slight is not None and slight.label == "На завтра"

    today = match_list_phrase("какие задачи на сегодня", NOW)
    assert today is not None
    assert today.item_type == "task"
    assert today.start is not None and today.start.date().isoformat() == "2026-10-28"

    later = match_list_phrase("встречи послезавтра", NOW)
    assert later is not None
    assert later.item_type == "meeting"
    assert later.start is not None and later.start.date().isoformat() == "2026-10-30"

    monday = match_list_phrase("что в понедельник", NOW)
    assert monday is not None
    assert monday.label == "В понедельник"
    assert monday.start is not None and monday.start.date().isoformat() == "2026-11-02"

    week = match_list_phrase("есть что на этой неделе", NOW)
    assert week is not None
    assert week.label == "На этой неделе"
    assert week.start is not None and week.start.date().isoformat() == "2026-10-26"
    assert week.end is not None and week.end.date().isoformat() == "2026-11-01"

    tasks = match_list_phrase("покажи задачи", NOW)
    assert tasks is not None
    assert tasks.item_type == "task"
    assert tasks.start is None


def test_create_and_confirmation_are_not_list_queries() -> None:
    assert match_list_phrase("запиши задачу в 10 утра на прием", NOW) is None
    assert match_list_phrase("удали встречу завтра", NOW) is None
    assert match_list_phrase("да", NOW) is None


def test_answer_comes_from_items() -> None:
    moment = datetime(2026, 10, 29, 7, 0, tzinfo=timezone.utc)
    item = ItemRead(
        id=1,
        item_type="task",
        status="todo",
        title="прием",
        description=None,
        start_at=moment,
        end_at=None,
        due_on=None,
        due_at=None,
        remind_at=None,
        workspace_id=1,
        created_at=moment,
        updated_at=moment,
    )
    assert describe_items([item], 1, label="На завтра", show_date=False, zone=ZONE) == (
        "На завтра: прием в 10:00"
    )
    assert describe_items([], 0, label="На сегодня", show_date=False, zone=ZONE) == (
        "На сегодня записей нет."
    )
