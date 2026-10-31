import pytest
from pydantic import ValidationError

from app.core.errors import Unprocessable
from app.schemas.assistant import AssistantCommand, AssistantMessageRequest
from app.services.assistant_service import _create_payload, _query, _update_payload, command_creates


def test_assistant_request_strips_text() -> None:
    data = AssistantMessageRequest(text="  купить молоко  ")
    assert data.text == "купить молоко"


@pytest.mark.parametrize("text", ["", "   "])
def test_assistant_request_rejects_blank(text: str) -> None:
    with pytest.raises(ValidationError):
        AssistantMessageRequest(text=text)


def test_command_ignores_unknown_fields() -> None:
    command = AssistantCommand.model_validate(
        {"action": "none", "reply": "уточните", "unexpected": True}
    )
    assert command.action == "none"
    assert command.item is None


def test_create_payload_requires_item() -> None:
    with pytest.raises(Unprocessable, match="не передала поля"):
        _create_payload(None)


def test_create_payload_requires_title() -> None:
    with pytest.raises(Unprocessable, match="Не хватает полей"):
        _create_payload({"item_type": "task"})


def test_create_payload_accepts_task() -> None:
    item = _create_payload({"item_type": "task", "title": "Молоко"})
    assert item.item_type == "task"
    assert item.title == "Молоко"


def test_update_payload_requires_changes() -> None:
    with pytest.raises(Unprocessable, match="не передала изменения"):
        _update_payload(None)


def test_query_maps_from_to_filters() -> None:
    query = _query({"item_type": "task", "status": "todo", "q": "молоко"})
    assert query.item_type == "task"
    assert query.status == "todo"
    assert query.q == "молоко"
    assert query.limit == 50


def test_command_creates_keeps_three_records() -> None:
    command = AssistantCommand.model_validate(
        {
            "action": "create",
            "items": [
                {"item_type": "task", "title": "Первая"},
                {"item_type": "task", "title": "Вторая"},
                {"item_type": "task", "title": "Третья"},
                {"item_type": "task", "title": "Четвёртая"},
            ],
        }
    )
    items, truncated = command_creates(command)
    assert truncated is True
    assert [item.title for item in items] == ["Первая", "Вторая", "Третья"]


def test_query_rejects_unknown_type() -> None:
    with pytest.raises(Unprocessable, match="Некорректные фильтры"):
        _query({"item_type": "event"})
