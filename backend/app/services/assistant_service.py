from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Unprocessable
from app.integrations import llm
from app.models.user import User
from app.schemas.assistant import AssistantCommand, AssistantMessageResponse
from app.schemas.item import ItemCreate, ItemQuery, ItemUpdate
from app.services import item_service

_SYSTEM = """Ты помощник планировщика. Ответь одним JSON-объектом без пояснений:
{"action":"create|list|update|delete|none","reply":"короткий ответ пользователю","item":null,"item_id":null,"filters":null}
Для create заполни item: item_type (task, meeting или reminder), status, title, description, start_at, end_at, due_on, due_at, remind_at.
Время — ISO 8601 с часовым поясом пользователя. due_on — дата YYYY-MM-DD.
Не заполняй due_on и due_at вместе. Встрече нужен start_at. Напоминанию нужен remind_at.
Для list заполни filters: item_type, status, q, from, to.
Для update и delete укажи item_id. В update.item только меняемые поля.
Если данных не хватает, action=none и спроси в reply. Не выдумывай id записи."""


async def interpret(user: User, text: str, context: str | None = None) -> AssistantCommand:
    now = datetime.now(timezone.utc).astimezone(ZoneInfo(user.timezone))
    chunks = [
        (
            f"Сейчас {now.strftime('%Y-%m-%d %H:%M')}, пояс {user.timezone}, "
            f"день недели {now.strftime('%A')}."
        )
    ]
    if context:
        chunks.append(context)
    chunks.append(text)
    raw = await llm.complete(
        [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": "\n".join(chunks)},
        ]
    )
    try:
        return AssistantCommand.model_validate(raw)
    except ValidationError as exc:
        raise Unprocessable("Модель вернула непонятную команду") from exc


async def handle_message(session: AsyncSession, user: User, text: str) -> AssistantMessageResponse:
    command = await interpret(user, text)
    reply = command.reply.strip()
    if command.action == "none":
        return AssistantMessageResponse(reply=reply or "Уточните запрос", action="none", items=[])
    if command.action == "create":
        item = await item_service.create_item(session, user, _create_payload(command.item))
        return AssistantMessageResponse(reply=reply or "Запись создана", action="create", items=[item])
    if command.action == "list":
        found = await item_service.list_items(session, user, _query(command.filters))
        return AssistantMessageResponse(
            reply=reply or f"Найдено записей: {found.total}",
            action="list",
            items=found.items,
        )
    if command.item_id is None:
        raise Unprocessable("Модель не указала запись")
    if command.action == "delete":
        await item_service.delete_item(session, user, command.item_id)
        return AssistantMessageResponse(reply=reply or "Запись удалена", action="delete", items=[])
    updated = await item_service.update_item(session, user, command.item_id, _update_payload(command.item))
    return AssistantMessageResponse(reply=reply or "Запись обновлена", action="update", items=[updated])


def _create_payload(raw: dict | None) -> ItemCreate:
    if not raw:
        raise Unprocessable("Модель не передала поля записи")
    try:
        return ItemCreate.model_validate(raw)
    except ValidationError as exc:
        raise Unprocessable("Не хватает полей для записи") from exc


def _update_payload(raw: dict | None) -> ItemUpdate:
    if not raw:
        raise Unprocessable("Модель не передала изменения")
    try:
        return ItemUpdate.model_validate(raw)
    except ValidationError as exc:
        raise Unprocessable("Некорректные поля записи") from exc


def _query(raw: dict | None) -> ItemQuery:
    data = raw or {}
    payload = {
        "item_type": data.get("item_type"),
        "status": data.get("status"),
        "q": data.get("q"),
        "start": data.get("from"),
        "end": data.get("to"),
        "limit": 50,
        "offset": 0,
    }
    try:
        return ItemQuery.model_validate(payload)
    except ValidationError as exc:
        raise Unprocessable("Некорректные фильтры") from exc
