import json
import struct
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import persist
from app.core.errors import Conflict, NotFound, Unprocessable
from app.integrations import stt
from app.models.assistant import AssistantMessage, AssistantProposal
from app.models.user import User
from app.repositories import assistant_repository, catalog_repository, color_repository, item_repository
from app.repositories.item_repository import ItemFilters
from app.schemas.item import ItemCreate
from app.schemas.ritm import (
    ColorDefaultResponse,
    ColorOverrideResponse,
    ColorSnapshot,
    EventCreateRequest,
    EventListResponse,
    EventPatchRequest,
    EventType,
    HistoryResponse,
    MessageRequest,
    ReplyResponse,
    RitmEvent,
    SearchHit,
    SearchResponse,
    TranscriptionOut,
)
from app.services import assistant_service, item_service
from app.services.item_service import validate_schedule
from app.services.ritm_map import (
    apply_schedule,
    card_from_create,
    event_from_item,
    is_past,
    item_create_from_ritm,
    open_status,
    proposal_card,
)

LIST_LIMIT = 2000
_TYPES = ("task", "meeting", "reminder")
_YES = frozenset({"да", "yes", "ок", "ok", "подтвердить", "подтверждаю", "ага", "конечно", "угу"})
_NO = frozenset({"нет", "no", "отмена", "отменить", "отказаться", "не надо"})
_PROPOSAL_KEYS = (
    "intent",
    "event_type",
    "title",
    "date",
    "time",
    "duration_min",
    "is_deadline",
    "color",
)
_MAX_AUDIO = 10 * 1024 * 1024


def _session_key(value: str | None) -> str:
    return (value or "default").strip() or "default"


def _request_key(value: str | None) -> str:
    return value or str(uuid.uuid4())


def _public_proposal(payload: dict) -> dict:
    return {key: payload.get(key) for key in _PROPOSAL_KEYS}


def _fingerprint(payload: dict) -> str:
    data = {key: payload.get(key) for key in _PROPOSAL_KEYS}
    return json.dumps(data, ensure_ascii=False, sort_keys=True, default=str)


def _verdict(text: str) -> str | None:
    key = text.strip().lower().rstrip("!.?")
    if key in _YES:
        return "yes"
    if key in _NO:
        return "no"
    return None


def _chosen_color(data: MessageRequest, payload: dict | None = None) -> str | None:
    if "new_event_color" in data.model_fields_set:
        return data.new_event_color
    if payload:
        color = payload.get("color")
        return color if isinstance(color, str) else None
    return data.new_event_color


def _reply(
    *,
    kind: str,
    text: str,
    request_id: str | None,
    events: list[RitmEvent] | None = None,
    proposal: dict | None = None,
    suggestions: list[str] | None = None,
    expecting: str | None = None,
) -> ReplyResponse:
    return ReplyResponse(
        kind=kind,
        text=text,
        events=events or [],
        request_id=request_id,
        proposal=_public_proposal(proposal) if proposal else None,
        suggestions=suggestions or [],
        expecting=expecting,
    )


def _confirm_text(conflicts: list[RitmEvent], past: bool) -> str:
    if conflicts and past:
        return "Эта дата уже прошла, и время пересекается с другой встречей. Создать всё равно?"
    if conflicts:
        return "Это время пересекается с другой встречей. Создать всё равно?"
    if past:
        return "Эта дата уже прошла. Создать всё равно?"
    return "Проверьте карточку и подтвердите создание."


def _pcm_to_wav(payload: bytes, sample_rate: int = 16000) -> bytes:
    if payload[:4] == b"RIFF":
        return payload
    n = len(payload)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + n,
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        sample_rate,
        sample_rate * 2,
        2,
        16,
        b"data",
        n,
    )
    return header + payload


async def _ritm(session: AsyncSession, user: User, item_id: int) -> RitmEvent:
    found = await item_repository.get_item(session, user.id, item_id)
    if found is None:
        raise NotFound("Запись не найдена")
    item, status = found
    return event_from_item(item, status, user.timezone)


async def _save_item(
    session: AsyncSession, user: User, data: ItemCreate, color: str | None
) -> RitmEvent:
    created = await item_service.create_item(session, user, data)
    found = await item_repository.get_item(session, user.id, created.id)
    if found is None:
        raise NotFound("Запись не найдена")
    item, status = found
    if color:
        item.color = color
        await persist(session)
        await session.refresh(item)
    return event_from_item(item, status, user.timezone)


async def _conflicts(session: AsyncSession, user: User, data: ItemCreate) -> list[RitmEvent]:
    if data.item_type != "meeting" or data.start_at is None:
        return []
    start = data.start_at
    end = data.end_at or start + timedelta(minutes=60)
    filters = ItemFilters(
        item_type="meeting",
        status=None,
        query=None,
        start=start - timedelta(hours=12),
        end=end + timedelta(hours=12),
        start_date=None,
        end_date=None,
        limit=200,
        offset=0,
    )
    rows, _ = await item_repository.list_items(session, user.id, filters)
    found: list[RitmEvent] = []
    for item, status in rows:
        if status in {"done", "cancelled"} or item.start_at is None:
            continue
        other_end = item.end_at or item.start_at + timedelta(hours=1)
        if item.start_at < end and other_end > start:
            found.append(event_from_item(item, status, user.timezone))
    return found


def _payload_from_create(data: ItemCreate, color: str | None, timezone: str, extra: dict | None = None) -> dict:
    card = card_from_create(data, color, timezone)
    if extra:
        card.update(extra)
    card["complete"] = True
    card["fingerprint"] = _fingerprint(card)
    return card


def _payload_from_request(data: EventCreateRequest, item: ItemCreate, timezone: str) -> dict:
    return _payload_from_create(item, data.color, timezone)


def _item_from_payload(payload: dict, timezone: str) -> ItemCreate:
    return item_create_from_ritm(
        item_type=payload["event_type"],
        title=payload["title"],
        day=payload.get("date"),
        clock=payload.get("time"),
        duration_min=payload.get("duration_min"),
        is_deadline=bool(payload.get("is_deadline")),
        timezone=timezone,
    )


async def _conversation(session: AsyncSession, user: User, session_id: str | None):
    return await assistant_repository.get_or_create_conversation(
        session, user.id, _session_key(session_id)
    )


async def _store_turn(
    session: AsyncSession,
    conversation_id: int,
    *,
    request_id: str,
    user_text: str | None,
    kind: str,
    assistant_text: str,
) -> None:
    if user_text:
        existing = await assistant_repository.user_message_for_request(
            session, conversation_id, request_id
        )
        if existing is None:
            await assistant_repository.add_message(
                session,
                conversation_id,
                role="user",
                text=user_text,
                request_id=request_id,
            )
    await assistant_repository.add_message(
        session,
        conversation_id,
        role="assistant",
        text=assistant_text,
        kind=kind,
        request_id=request_id,
    )


async def _put_pending(
    session: AsyncSession,
    conversation_id: int,
    request_id: str,
    payload: dict,
) -> AssistantProposal:
    await assistant_repository.reject_open(session, conversation_id, keep_request_id=request_id)
    found = await assistant_repository.get_proposal(session, conversation_id, request_id)
    if found is None:
        return await assistant_repository.add_proposal(
            session,
            conversation_id,
            request_id=request_id,
            action="create",
            payload=payload,
            status="pending",
        )
    found.payload = payload
    found.action = "create"
    found.status = "pending"
    found.result_item_id = None
    found.resolved_at = None
    return found


async def _replay_message(
    session: AsyncSession,
    user: User,
    conversation_id: int,
    message: AssistantMessage,
) -> ReplyResponse:
    request_id = message.request_id
    proposal = None
    if request_id:
        proposal = await assistant_repository.get_proposal(session, conversation_id, request_id)
        if proposal is None and message.kind == "confirm":
            proposal = await assistant_repository.latest_pending(session, conversation_id)
    events: list[RitmEvent] = []
    if proposal is not None and proposal.result_item_id is not None:
        try:
            events = [await _ritm(session, user, proposal.result_item_id)]
        except NotFound:
            events = []
    expecting = None
    suggestions: list[str] = []
    if message.kind == "confirm" and proposal is not None and proposal.status == "pending":
        expecting = "confirmation"
        suggestions = ["Да", "Нет"]
    return _reply(
        kind=message.kind or "info",
        text=message.text,
        request_id=request_id,
        events=events,
        proposal=proposal.payload if proposal is not None else None,
        suggestions=suggestions,
        expecting=expecting,
    )


async def _replay_form(session: AsyncSession, user: User, proposal: AssistantProposal) -> ReplyResponse:
    if proposal.status == "pending":
        conflicts: list[RitmEvent] = []
        try:
            item = _item_from_payload(proposal.payload, user.timezone)
            conflicts = await _conflicts(session, user, item)
        except Unprocessable:
            conflicts = []
        past = is_past(proposal.payload.get("date"), proposal.payload.get("time"), user.timezone)
        return _reply(
            kind="confirm",
            text=_confirm_text(conflicts, past),
            request_id=proposal.request_id,
            events=conflicts,
            proposal=proposal.payload,
            suggestions=["Да", "Нет"],
            expecting="confirmation",
        )
    events: list[RitmEvent] = []
    if proposal.result_item_id is not None:
        try:
            events = [await _ritm(session, user, proposal.result_item_id)]
        except NotFound:
            events = []
    kind = "duplicate" if proposal.status == "confirmed" else "cancelled"
    text = "Запись уже создана" if kind == "duplicate" else "Хорошо, не создаю."
    return _reply(kind=kind, text=text, request_id=proposal.request_id, events=events)


async def list_events(
    session: AsyncSession,
    user: User,
    *,
    item_type: EventType | None = None,
    status: str | None = None,
) -> EventListResponse:
    filters = ItemFilters(
        item_type=item_type,
        status="done" if status == "done" else None,
        query=None,
        start=None,
        end=None,
        start_date=None,
        end_date=None,
        limit=LIST_LIMIT,
        offset=0,
    )
    rows, _ = await item_repository.list_items(session, user.id, filters)
    events = [event_from_item(item, code, user.timezone) for item, code in rows]
    if status == "planned":
        events = [event for event in events if event.status == "planned"]
    return EventListResponse(events=events)


async def get_event(session: AsyncSession, user: User, event_id: int) -> RitmEvent:
    return await _ritm(session, user, event_id)


async def search_events(
    session: AsyncSession, user: User, query: str, limit: int
) -> SearchResponse:
    text = query.strip()
    if not text:
        return SearchResponse(hits=[])
    filters = ItemFilters(
        item_type=None,
        status=None,
        query=text,
        start=None,
        end=None,
        start_date=None,
        end_date=None,
        limit=limit,
        offset=0,
    )
    rows, _ = await item_repository.list_items(session, user.id, filters)
    return SearchResponse(
        hits=[SearchHit(event=event_from_item(item, code, user.timezone)) for item, code in rows]
    )


async def create_event(
    session: AsyncSession, user: User, data: EventCreateRequest
) -> ReplyResponse:
    item = item_create_from_ritm(
        item_type=data.type,
        title=data.title,
        day=data.date,
        clock=data.time,
        duration_min=data.duration_min,
        is_deadline=data.is_deadline,
        timezone=user.timezone,
    )
    payload = _payload_from_request(data, item, user.timezone)
    conversation = await _conversation(session, user, data.session_id)
    request_id = _request_key(data.request_id)
    if data.request_id:
        existing = await assistant_repository.get_proposal(
            session, conversation.id, data.request_id
        )
        if existing is not None:
            if existing.payload.get("fingerprint") != payload["fingerprint"]:
                raise Conflict("Эта фраза уже отправлялась с другим текстом")
            return await _replay_form(session, user, existing)
    conflicts = await _conflicts(session, user, item)
    past = is_past(data.date, data.time, user.timezone)
    if conflicts or past:
        await _put_pending(session, conversation.id, request_id, payload)
        await _store_turn(
            session,
            conversation.id,
            request_id=request_id,
            user_text=None,
            kind="confirm",
            assistant_text=_confirm_text(conflicts, past),
        )
        return _reply(
            kind="confirm",
            text=_confirm_text(conflicts, past),
            request_id=request_id,
            events=conflicts,
            proposal=payload,
            suggestions=["Да", "Нет"],
            expecting="confirmation",
        )
    event = await _save_item(session, user, item, data.color)
    await assistant_repository.reject_open(session, conversation.id)
    await assistant_repository.add_proposal(
        session,
        conversation.id,
        request_id=request_id,
        action="create",
        payload=payload,
        status="confirmed",
        result_item_id=event.id,
    )
    text = "Запись создана"
    await _store_turn(
        session,
        conversation.id,
        request_id=request_id,
        user_text=None,
        kind="created",
        assistant_text=text,
    )
    return _reply(kind="created", text=text, request_id=request_id, events=[event])


async def patch_event(
    session: AsyncSession, user: User, event_id: int, data: EventPatchRequest
) -> RitmEvent:
    found = await item_repository.get_item(session, user.id, event_id)
    if found is None:
        raise NotFound("Запись не найдена")
    item, current_status = found
    fields = data.model_dump(exclude_unset=True)
    if "title" in fields:
        item.title = fields["title"]
    if "date" in fields or "time" in fields:
        current = event_from_item(item, current_status, user.timezone)
        day = fields["date"] if "date" in fields else current.date
        clock = fields["time"] if "time" in fields else current.time
        if not day and not clock:
            if item.item_type_code in {"meeting", "reminder"}:
                raise Unprocessable("Для встречи или напоминания нужны дата и время")
            item.start_at = None
            item.end_at = None
            item.due_on = None
            item.due_at = None
            item.remind_at = None
        else:
            apply_schedule(item, day=day, clock=clock, timezone=user.timezone)
    status_code = current_status
    if "status" in fields:
        if fields["status"] == "done":
            status_code = "done"
            item.completed_at = datetime.now(timezone.utc)
        else:
            status_code = open_status(item.item_type_code)
            item.completed_at = None
    status = await catalog_repository.get_status(session, item.item_type_code, status_code)
    if status is None:
        raise Unprocessable("Неизвестный статус для этого типа")
    item.status_id = status.id
    validate_schedule(
        item_type=item.item_type_code,
        start_at=item.start_at,
        end_at=item.end_at,
        due_on=item.due_on,
        due_at=item.due_at,
        remind_at=item.remind_at,
    )
    await persist(session)
    await session.refresh(item)
    return event_from_item(item, status.code, user.timezone)


async def delete_event(session: AsyncSession, user: User, event_id: int) -> None:
    await item_service.delete_item(session, user, event_id)


async def color_snapshot(session: AsyncSession, user: User) -> ColorSnapshot:
    defaults: dict[str, str | None] = {code: None for code in _TYPES}
    for row in await color_repository.list_defaults(session, user.id):
        if row.item_type_code in defaults:
            defaults[row.item_type_code] = row.color
    overrides = {
        str(item_id): color
        for item_id, color in await color_repository.list_overrides(session, user.id)
    }
    return ColorSnapshot(defaults=defaults, overrides=overrides)


async def set_default_color(
    session: AsyncSession, user: User, item_type: EventType, color: str | None
) -> ColorDefaultResponse:
    row = await color_repository.get_default(session, user.id, item_type)
    if color is None:
        if row is not None:
            await color_repository.delete_default(session, row)
        return ColorDefaultResponse(type=item_type, color=None)
    await color_repository.upsert_default(session, user.id, item_type, color)
    await persist(session)
    return ColorDefaultResponse(type=item_type, color=color)


async def set_event_color(
    session: AsyncSession, user: User, event_id: int, color: str | None
) -> ColorOverrideResponse:
    found = await item_repository.get_item(session, user.id, event_id)
    if found is None:
        raise NotFound("Запись не найдена")
    found[0].color = color
    await persist(session)
    return ColorOverrideResponse(event_id=event_id, color=color)


def _context(messages: list[AssistantMessage], pending: AssistantProposal | None) -> str | None:
    parts: list[str] = []
    if messages:
        lines = [f"{row.role}: {row.text}" for row in messages[-8:]]
        parts.append("Недавний диалог:\n" + "\n".join(lines))
    if pending is not None:
        parts.append(
            "Незавершённое предложение, ещё не создано: "
            + json.dumps(_public_proposal(pending.payload), ensure_ascii=False)
        )
    return "\n".join(parts) if parts else None


async def _confirm_pending(
    session: AsyncSession,
    user: User,
    conversation_id: int,
    request_id: str,
    pending: AssistantProposal,
    data: MessageRequest,
) -> ReplyResponse:
    payload = dict(pending.payload)
    payload["color"] = _chosen_color(data, payload)
    if not payload.get("complete"):
        text = "Не хватает данных для создания. Уточните название, дату или время."
        await _store_turn(
            session,
            conversation_id,
            request_id=request_id,
            user_text=data.text,
            kind="clarify",
            assistant_text=text,
        )
        return _reply(kind="clarify", text=text, request_id=request_id, proposal=payload)
    item = _item_from_payload(payload, user.timezone)
    event = await _save_item(session, user, item, payload.get("color") if isinstance(payload.get("color"), str) else None)
    pending.status = "confirmed"
    pending.payload = payload
    pending.result_item_id = event.id
    pending.resolved_at = datetime.now(timezone.utc)
    await assistant_repository.add_proposal(
        session,
        conversation_id,
        request_id=request_id,
        action="create",
        payload=payload,
        status="confirmed",
        result_item_id=event.id,
    )
    text = "Запись создана"
    await _store_turn(
        session,
        conversation_id,
        request_id=request_id,
        user_text=data.text,
        kind="created",
        assistant_text=text,
    )
    return _reply(kind="created", text=text, request_id=request_id, events=[event], proposal=payload)


async def _reject_pending(
    session: AsyncSession,
    conversation_id: int,
    request_id: str,
    pending: AssistantProposal,
    data: MessageRequest,
) -> ReplyResponse:
    pending.status = "rejected"
    pending.resolved_at = datetime.now(timezone.utc)
    text = "Хорошо, не создаю."
    await _store_turn(
        session,
        conversation_id,
        request_id=request_id,
        user_text=data.text,
        kind="cancelled",
        assistant_text=text,
    )
    return _reply(kind="cancelled", text=text, request_id=request_id, proposal=pending.payload)


async def handle_message(
    session: AsyncSession, user: User, data: MessageRequest
) -> ReplyResponse:
    conversation = await _conversation(session, user, data.session_id)
    request_id = _request_key(data.request_id)
    if data.request_id:
        user_row = await assistant_repository.user_message_for_request(
            session, conversation.id, data.request_id
        )
        if user_row is not None and user_row.text != data.text:
            raise Conflict("Эта фраза уже отправлялась с другим текстом")
        assistant = await assistant_repository.last_assistant_for_request(
            session, conversation.id, data.request_id
        )
        if assistant is not None:
            return await _replay_message(session, user, conversation.id, assistant)
    pending = await assistant_repository.latest_pending(session, conversation.id)
    verdict = _verdict(data.text)
    if pending is not None and verdict == "yes":
        return await _confirm_pending(session, user, conversation.id, request_id, pending, data)
    if pending is not None and verdict == "no":
        return await _reject_pending(session, conversation.id, request_id, pending, data)

    history = await assistant_repository.list_messages(session, conversation.id, 20)
    command = await assistant_service.interpret(user, data.text, _context(history, pending))
    if command.action == "create":
        return await _handle_create(session, user, conversation.id, request_id, data, command, pending)
    if command.action == "list":
        await assistant_repository.reject_open(session, conversation.id)
        found = await item_service.list_items(session, user, assistant_service._query(command.filters))
        events = [await _ritm(session, user, row.id) for row in found.items]
        text = command.reply.strip() or f"Найдено записей: {found.total}"
        await _store_turn(
            session,
            conversation.id,
            request_id=request_id,
            user_text=data.text,
            kind="info",
            assistant_text=text,
        )
        return _reply(kind="info", text=text, request_id=request_id, events=events)
    if command.action == "delete":
        await assistant_repository.reject_open(session, conversation.id)
        if command.item_id is None:
            raise Unprocessable("Модель не указала запись")
        await item_service.delete_item(session, user, command.item_id)
        text = command.reply.strip() or "Запись удалена"
        await _store_turn(
            session,
            conversation.id,
            request_id=request_id,
            user_text=data.text,
            kind="deleted",
            assistant_text=text,
        )
        return _reply(kind="deleted", text=text, request_id=request_id)
    if command.action == "update":
        await assistant_repository.reject_open(session, conversation.id)
        if command.item_id is None:
            raise Unprocessable("Модель не указала запись")
        await item_service.update_item(
            session, user, command.item_id, assistant_service._update_payload(command.item)
        )
        event = await _ritm(session, user, command.item_id)
        text = command.reply.strip() or "Запись обновлена"
        await _store_turn(
            session,
            conversation.id,
            request_id=request_id,
            user_text=data.text,
            kind="updated",
            assistant_text=text,
        )
        return _reply(kind="updated", text=text, request_id=request_id, events=[event])
    return await _handle_none(session, user, conversation.id, request_id, data, command, pending)


async def _handle_create(
    session: AsyncSession,
    user: User,
    conversation_id: int,
    request_id: str,
    data: MessageRequest,
    command,
    pending: AssistantProposal | None,
) -> ReplyResponse:
    try:
        item = assistant_service._create_payload(command.item)
    except Unprocessable:
        return await _handle_none(session, user, conversation_id, request_id, data, command, pending)
    color = _chosen_color(data, pending.payload if pending is not None else None)
    payload = _payload_from_create(item, color, user.timezone)
    conflicts = await _conflicts(session, user, item)
    past = is_past(payload.get("date"), payload.get("time"), user.timezone)
    needs_confirm = data.require_confirmation or bool(conflicts) or past
    if needs_confirm:
        await _put_pending(session, conversation_id, request_id, payload)
        text = _confirm_text(conflicts, past)
        await _store_turn(
            session,
            conversation_id,
            request_id=request_id,
            user_text=data.text,
            kind="confirm",
            assistant_text=text,
        )
        return _reply(
            kind="confirm",
            text=text,
            request_id=request_id,
            events=conflicts,
            proposal=payload,
            suggestions=["Да", "Нет"],
            expecting="confirmation",
        )
    event = await _save_item(session, user, item, color)
    await assistant_repository.reject_open(session, conversation_id)
    await assistant_repository.add_proposal(
        session,
        conversation_id,
        request_id=request_id,
        action="create",
        payload=payload,
        status="confirmed",
        result_item_id=event.id,
    )
    text = command.reply.strip() or "Запись создана"
    await _store_turn(
        session,
        conversation_id,
        request_id=request_id,
        user_text=data.text,
        kind="created",
        assistant_text=text,
    )
    return _reply(kind="created", text=text, request_id=request_id, events=[event], proposal=payload)


async def _handle_none(
    session: AsyncSession,
    user: User,
    conversation_id: int,
    request_id: str,
    data: MessageRequest,
    command,
    pending: AssistantProposal | None,
) -> ReplyResponse:
    text = command.reply.strip() or "Уточните запрос"
    color = _chosen_color(data, pending.payload if pending is not None else None)
    if pending is not None or color:
        payload = dict(pending.payload) if pending is not None else proposal_card(
            item_type="task",
            title=data.text[:300],
            day=None,
            clock=None,
            duration_min=None,
            color=color,
        )
        payload["color"] = color
        payload["complete"] = False
        payload["fingerprint"] = _fingerprint(payload)
        await _put_pending(session, conversation_id, request_id, payload)
        await _store_turn(
            session,
            conversation_id,
            request_id=request_id,
            user_text=data.text,
            kind="clarify",
            assistant_text=text,
        )
        return _reply(kind="clarify", text=text, request_id=request_id, proposal=payload)
    await _store_turn(
        session,
        conversation_id,
        request_id=request_id,
        user_text=data.text,
        kind="info",
        assistant_text=text,
    )
    return _reply(kind="info", text=text, request_id=request_id)


async def history(
    session: AsyncSession, user: User, session_id: str | None, limit: int
) -> HistoryResponse:
    conversation = await assistant_repository.get_conversation(
        session, user.id, _session_key(session_id)
    )
    if conversation is None:
        return HistoryResponse(messages=[])
    messages = await assistant_repository.list_messages(session, conversation.id, limit)
    proposals = {
        row.request_id: row
        for row in await assistant_repository.list_proposals(session, conversation.id)
    }
    pending = await assistant_repository.latest_pending(session, conversation.id)
    pending_color = None
    if pending is not None and isinstance(pending.payload.get("color"), str):
        pending_color = pending.payload.get("color")
    last_assistant = max(
        (index for index, row in enumerate(messages) if row.role == "assistant"),
        default=None,
    )
    out: list[dict] = []
    for index, row in enumerate(messages):
        proposal = proposals.get(row.request_id or "")
        item: dict = {
            "id": row.id,
            "role": row.role,
            "text": row.text,
            "kind": row.kind,
            "request_id": row.request_id,
            "created_at": row.created_at.isoformat() if row.created_at else None,
        }
        if proposal is not None:
            item["proposal"] = _public_proposal(proposal.payload)
            item["active_confirmation"] = proposal.status == "pending"
            if proposal.status == "confirmed":
                item["resolution"] = "confirmed"
            elif proposal.status == "rejected":
                item["resolution"] = "declined"
            else:
                item["resolution"] = None
        if index == last_assistant and pending_color is not None:
            item["pending_color"] = pending_color
            if pending is not None and pending.status == "pending":
                item["proposal"] = _public_proposal(pending.payload)
                item["active_confirmation"] = pending.status == "pending" and (row.kind == "confirm")
        out.append(item)
    return HistoryResponse(messages=out)


async def transcribe_pcm(payload: bytes) -> TranscriptionOut:
    if not payload:
        raise Unprocessable("Пустой аудиофайл")
    if len(payload) > _MAX_AUDIO:
        raise Unprocessable("Аудиофайл больше 10 МБ")
    wav = _pcm_to_wav(payload)
    text = await stt.transcribe("speech.wav", wav, "audio/wav")
    return TranscriptionOut(text=text)
