from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Unprocessable
from app.integrations import llm
from app.models.user import User
from app.schemas.assistant import AssistantCommand, AssistantMessageResponse
from app.schemas.item import ItemCreate, ItemList, ItemQuery, ItemUpdate
from app.services import item_service
from app.services.delete_match import resolve_delete
from app.services.list_phrase import ListPhrase, agenda_line, describe_items, match_list_phrase
from app.services.text_guard import REFUSAL, for_model, is_rejected

_SYSTEM = """Ты помощник планировщика. Ответь одним JSON-объектом без пояснений:
{"action":"create|list|update|delete|none","reply":"короткий ответ пользователю","item":null,"items":null,"item_id":null,"filters":null}
Для create заполни item: item_type (task, meeting или reminder), status, title, description, start_at, end_at, due_on, due_at, remind_at.
Время — ISO 8601 с часовым поясом пользователя. due_on — дата YYYY-MM-DD.
Не заполняй due_on и due_at вместе. Встрече нужен start_at. Напоминанию нужен remind_at.
Если в одной фразе несколько записей, action=create, item=null, items — массив до 3 таких объектов. Каждую запись клади отдельно. Четвёртую и дальше не добавляй.
Для list заполни filters: item_type, status, q, from, to на тот день или период, о котором спросили.
Для update укажи item_id из блока записей. В update.item только меняемые поля.
Для delete оставь item_id пустым: запись найдёт программа по словам пользователя. Если подходит несколько, она переспросит.
Если данных не хватает, action=none и спроси в reply. Не выдумывай id записи.
Ненормативную лексику в название и описание не включай.
Блок «Записи из базы» — факты. Если на спрошенный день запись есть, filters должны покрывать этот день.
Не пиши в reply, что записей нет и не перечисляй их: это сделает программа по результату запроса."""


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
    chunks.append(for_model(text))
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


def local_now(user: User) -> datetime:
    return datetime.now(timezone.utc).astimezone(ZoneInfo(user.timezone))


def list_reply(found: ItemList, phrase: ListPhrase, zone: ZoneInfo) -> str:
    return describe_items(
        found.items,
        found.total,
        label=phrase.label,
        show_date=phrase.show_date,
        zone=zone,
    )


def reply_for_filters(found: ItemList, query: ItemQuery, user: User) -> str:
    zone = ZoneInfo(user.timezone)
    phrase = _phrase_from_query(query, local_now(user), zone)
    return list_reply(found, phrase, zone)


async def agenda_text(session: AsyncSession, user: User) -> str:
    zone = ZoneInfo(user.timezone)
    now = local_now(user)
    start = datetime.combine(now.date(), datetime.min.time(), tzinfo=zone)
    end = start + timedelta(days=14) - timedelta(seconds=1)
    found = await item_service.list_items(
        session, user, ItemQuery(start=start, end=end, limit=15, offset=0)
    )
    if not found.items:
        return "Записи из базы на ближайшие 14 дней: нет."
    lines = [
        "Записи из базы на ближайшие 14 дней. Смотри сегодня, завтра и другие дни по вопросу:"
    ]
    lines.extend(agenda_line(item, zone) for item in found.items)
    if found.total > len(found.items):
        lines.append(f"И ещё {found.total - len(found.items)}.")
    return "\n".join(lines)


def _phrase_from_query(query: ItemQuery, now: datetime, zone: ZoneInfo) -> ListPhrase:
    if query.start is None or query.end is None:
        return ListPhrase(query.item_type, query.start, query.end, _open_query_label(query.item_type), True)
    start = query.start.astimezone(zone)
    end = query.end.astimezone(zone)
    today = now.astimezone(zone).date()
    if start.date() == end.date():
        delta = (start.date() - today).days
        labels = {0: "На сегодня", 1: "На завтра", 2: "Послезавтра"}
        if delta in labels:
            return ListPhrase(query.item_type, query.start, query.end, labels[delta], False)
        return ListPhrase(
            query.item_type,
            query.start,
            query.end,
            f"На {start.strftime('%d.%m')}",
            False,
        )
    return ListPhrase(query.item_type, query.start, query.end, "За этот период", True)


def _open_query_label(item_type: str | None) -> str:
    if item_type == "task":
        return "Среди задач"
    if item_type == "meeting":
        return "Среди встреч"
    if item_type == "reminder":
        return "Среди напоминаний"
    return "По запросу"


async def handle_message(session: AsyncSession, user: User, text: str) -> AssistantMessageResponse:
    if is_rejected(text):
        return AssistantMessageResponse(reply=REFUSAL, action="none", items=[])
    zone = ZoneInfo(user.timezone)
    phrase = match_list_phrase(for_model(text), local_now(user))
    if phrase is not None:
        found = await item_service.list_items(session, user, _query_from_phrase(phrase))
        return AssistantMessageResponse(
            reply=list_reply(found, phrase, zone),
            action="list",
            items=found.items,
        )
    command = await interpret(user, text, await agenda_text(session, user))
    reply = command.reply.strip()
    if command.action == "none":
        return AssistantMessageResponse(reply=reply or "Уточните запрос", action="none", items=[])
    if command.action == "create":
        creates, _truncated = command_creates(command)
        created = [await item_service.create_item(session, user, item) for item in creates]
        return AssistantMessageResponse(reply=reply or "Запись создана", action="create", items=created)
    if command.action == "list":
        query = _query(command.filters)
        found = await item_service.list_items(session, user, query)
        return AssistantMessageResponse(
            reply=reply_for_filters(found, query, user),
            action="list",
            items=found.items,
        )
    if command.action == "delete":
        found = await item_service.list_items(session, user, ItemQuery(limit=200, offset=0))
        decision = resolve_delete(found.items, for_model(text), local_now(user))
        if decision.item_id is None:
            return AssistantMessageResponse(reply=decision.text, action="none", items=[])
        await item_service.delete_item(session, user, decision.item_id)
        return AssistantMessageResponse(reply=decision.text or "Запись удалена", action="delete", items=[])
    if command.item_id is None:
        raise Unprocessable("Модель не указала запись")
    updated = await item_service.update_item(session, user, command.item_id, _update_payload(command.item))
    return AssistantMessageResponse(reply=reply or "Запись обновлена", action="update", items=[updated])


def _plain_item(raw: dict) -> dict:
    data = dict(raw)
    if isinstance(data.get("title"), str):
        data["title"] = for_model(data["title"])
    if isinstance(data.get("description"), str):
        data["description"] = for_model(data["description"]) or None
    return data


def command_creates(command: AssistantCommand) -> tuple[list[ItemCreate], bool]:
    raws: list[dict] = []
    if isinstance(command.items, list):
        raws.extend(row for row in command.items if isinstance(row, dict))
    if not raws and isinstance(command.item, dict):
        raws.append(command.item)
    truncated = len(raws) > 3
    chosen = raws[:3]
    if not chosen:
        raise Unprocessable("Модель не передала поля записи")
    items: list[ItemCreate] = []
    for raw in chosen:
        try:
            items.append(_create_payload(raw))
        except Unprocessable:
            continue
    if not items:
        raise Unprocessable("Не хватает полей для записи")
    return items, truncated


def _create_payload(raw: dict | None) -> ItemCreate:
    if not raw:
        raise Unprocessable("Модель не передала поля записи")
    try:
        return ItemCreate.model_validate(_plain_item(raw))
    except ValidationError as exc:
        raise Unprocessable("Не хватает полей для записи") from exc


def _update_payload(raw: dict | None) -> ItemUpdate:
    if not raw:
        raise Unprocessable("Модель не передала изменения")
    try:
        return ItemUpdate.model_validate(_plain_item(raw))
    except ValidationError as exc:
        raise Unprocessable("Некорректные поля записи") from exc


def _query_from_phrase(phrase: ListPhrase) -> ItemQuery:
    return ItemQuery(
        item_type=phrase.item_type,  # type: ignore[arg-type]
        start=phrase.start,
        end=phrase.end,
        limit=50,
        offset=0,
    )


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
