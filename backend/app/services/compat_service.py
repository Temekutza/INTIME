import json
import struct
import uuid
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import persist
from app.core.errors import Conflict, NotFound, Unprocessable
from app.integrations import stt
from app.models.assistant import AssistantMessage, AssistantProposal
from app.models.user import User
from app.repositories import assistant_repository, catalog_repository, color_repository, item_repository
from app.repositories.item_repository import ItemFilters
from app.schemas.assistant import AssistantCommand
from app.schemas.item import ItemCreate, ItemQuery
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
from app.services import assistant_service, item_service, workspace_service
from app.services.delete_match import choice_index, resolve_delete
from app.services.list_phrase import is_command, is_create_phrase, match_list_phrase
from app.services.text_guard import REFUSAL, ensure_plain, for_model, is_rejected, mask_profanity
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


def _scoped_query(query: ItemQuery, workspace_id: int | None) -> ItemQuery:
    if workspace_id is None:
        return query
    return query.model_copy(update={"workspace_id": workspace_id})


async def _bind_workspace(session: AsyncSession, user: User, item: ItemCreate) -> ItemCreate:
    workspace_id = await workspace_service.resolve_id(session, user, item.workspace_id)
    if item.workspace_id == workspace_id:
        return item
    return item.model_copy(update={"workspace_id": workspace_id})


def _session_key(value: str | None, workspace_id: int | None = None) -> str:
    base = (value or "default").strip() or "default"
    if workspace_id is None:
        return base
    return f"ws:{workspace_id}:{base}"


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


def _asks_to_confirm(reply: str) -> bool:
    text = reply.casefold()
    return any(token in text for token in ("?", "хотите", "всё-таки", "все-таки", "подтверд"))


def _mentions_title(title: object, *texts: str) -> bool:
    if not isinstance(title, str):
        return False
    key = " ".join(title.split()).casefold()
    if len(key) < 2:
        return False
    return any(key in " ".join(text.split()).casefold() for text in texts if text)


def _matching_rejected_create(
    proposals: list[AssistantProposal], *texts: str
) -> AssistantProposal | None:
    matches = [
        row
        for row in proposals
        if row.action == "create"
        and row.status == "rejected"
        and _mentions_title(row.payload.get("title"), *texts)
    ]
    if not matches:
        return None
    return max(matches, key=lambda row: (row.resolved_at or row.created_at, row.id))


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


async def _owned_item(
    session: AsyncSession,
    user: User,
    event_id: int,
    workspace_id: int | None = None,
) -> tuple:
    if workspace_id is not None:
        await workspace_service.get_owned(session, user, workspace_id)
    found = await item_repository.get_item(session, user.id, event_id)
    if found is None:
        raise NotFound("Запись не найдена")
    item, status = found
    if workspace_id is not None and item.workspace_id != workspace_id:
        raise NotFound("Запись не найдена")
    return item, status


async def _ritm(
    session: AsyncSession,
    user: User,
    item_id: int,
    workspace_id: int | None = None,
) -> RitmEvent:
    item, status = await _owned_item(session, user, item_id, workspace_id)
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
        workspace_id=data.workspace_id,
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


def _schedule_complete(payload: dict) -> bool:
    kind = payload.get("event_type")
    if kind in {"meeting", "reminder"}:
        return bool(payload.get("date") and payload.get("time"))
    return True


def _incomplete_text(item_type: str) -> str:
    if item_type == "reminder":
        return "Для напоминания нужны дата и время."
    if item_type == "meeting":
        return "Для встречи нужны дата и время."
    return "Не хватает данных для создания. Уточните название, дату или время."


def _payload_from_create(data: ItemCreate, color: str | None, timezone: str, extra: dict | None = None) -> dict:
    card = card_from_create(data, color, timezone)
    if extra:
        card.update(extra)
    if data.workspace_id is not None:
        card["workspace_id"] = data.workspace_id
    card["complete"] = _schedule_complete(card)
    card["fingerprint"] = _fingerprint(card)
    return card


def _payload_from_request(data: EventCreateRequest, item: ItemCreate, timezone: str) -> dict:
    return _payload_from_create(item, data.color, timezone)


def _item_from_payload(payload: dict, timezone: str) -> ItemCreate:
    workspace_id = payload.get("workspace_id")
    return item_create_from_ritm(
        item_type=payload["event_type"],
        title=payload["title"],
        day=payload.get("date"),
        clock=payload.get("time"),
        duration_min=payload.get("duration_min"),
        is_deadline=bool(payload.get("is_deadline")),
        timezone=timezone,
        workspace_id=workspace_id if isinstance(workspace_id, int) else None,
    )


async def _conversation(
    session: AsyncSession,
    user: User,
    session_id: str | None,
    workspace_id: int | None = None,
):
    if workspace_id is not None:
        await workspace_service.get_owned(session, user, workspace_id)
    return await assistant_repository.get_or_create_conversation(
        session, user.id, _session_key(session_id, workspace_id)
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
        user_text = mask_profanity(user_text)
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
        text=mask_profanity(assistant_text),
        kind=kind,
        request_id=request_id,
    )


async def _put_pending(
    session: AsyncSession,
    conversation_id: int,
    request_id: str,
    payload: dict,
    action: str = "create",
) -> AssistantProposal:
    await assistant_repository.reject_open(session, conversation_id, keep_request_id=request_id)
    found = await assistant_repository.get_proposal(session, conversation_id, request_id)
    if found is None:
        return await assistant_repository.add_proposal(
            session,
            conversation_id,
            request_id=request_id,
            action=action,
            payload=payload,
            status="pending",
        )
    found.payload = payload
    found.action = action
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
    workspace_id: int | None = None,
) -> EventListResponse:
    if workspace_id is not None:
        await workspace_service.get_owned(session, user, workspace_id)
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
        workspace_id=workspace_id,
    )
    rows, _ = await item_repository.list_items(session, user.id, filters)
    events = [event_from_item(item, code, user.timezone) for item, code in rows]
    if status == "planned":
        events = [event for event in events if event.status == "planned"]
    return EventListResponse(events=events)


async def get_event(
    session: AsyncSession,
    user: User,
    event_id: int,
    workspace_id: int | None = None,
) -> RitmEvent:
    return await _ritm(session, user, event_id, workspace_id)


async def search_events(
    session: AsyncSession,
    user: User,
    query: str,
    limit: int,
    workspace_id: int | None = None,
) -> SearchResponse:
    text = query.strip()
    if not text:
        return SearchResponse(hits=[])
    if workspace_id is not None:
        await workspace_service.get_owned(session, user, workspace_id)
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
        workspace_id=workspace_id,
    )
    rows, _ = await item_repository.list_items(session, user.id, filters)
    return SearchResponse(
        hits=[SearchHit(event=event_from_item(item, code, user.timezone)) for item, code in rows]
    )


async def create_event(
    session: AsyncSession, user: User, data: EventCreateRequest
) -> ReplyResponse:
    ensure_plain(data.title)
    item = item_create_from_ritm(
        item_type=data.type,
        title=data.title,
        day=data.date,
        clock=data.time,
        duration_min=data.duration_min,
        is_deadline=data.is_deadline,
        timezone=user.timezone,
        workspace_id=data.workspace_id,
    )
    item = await _bind_workspace(session, user, item)
    payload = _payload_from_request(data, item, user.timezone)
    conversation = await _conversation(session, user, data.session_id, data.workspace_id)
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
    session: AsyncSession,
    user: User,
    event_id: int,
    data: EventPatchRequest,
    workspace_id: int | None = None,
) -> RitmEvent:
    item, current_status = await _owned_item(session, user, event_id, workspace_id)
    fields = data.model_dump(exclude_unset=True)
    ensure_plain(fields.get("title"))
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


async def delete_event(
    session: AsyncSession,
    user: User,
    event_id: int,
    workspace_id: int | None = None,
) -> None:
    await _owned_item(session, user, event_id, workspace_id)
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
    session: AsyncSession,
    user: User,
    event_id: int,
    color: str | None,
    workspace_id: int | None = None,
) -> ColorOverrideResponse:
    item, _status = await _owned_item(session, user, event_id, workspace_id)
    item.color = color
    await persist(session)
    return ColorOverrideResponse(event_id=event_id, color=color)


def _context(messages: list[AssistantMessage], pending: AssistantProposal | None) -> str | None:
    parts: list[str] = []
    if messages:
        recent = messages[-8:]
        lines = [f"{row.role}: {for_model(row.text)}" for row in recent]
        parts.append("Недавний диалог:\n" + "\n".join(lines))
        last = recent[-1]
        if last.role == "assistant" and last.kind == "cancelled":
            parts.append(
                "Последнее предложение отклонено, запись не создана. "
                "Если пользователь снова просит создать — action=create и заполни item. "
                "Не спрашивай подтверждение текстом."
            )
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
    if pending.action == "update":
        return await _apply_pending_update(
            session, user, conversation_id, request_id, pending, data
        )
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
    nxt = _pop_follow(payload)
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
    if nxt is None:
        return _reply(kind="created", text=text, request_id=request_id, events=[event], proposal=payload)
    return await _offer_follow(session, user, conversation_id, request_id, nxt, event=event)


async def _reject_pending(
    session: AsyncSession,
    user: User,
    conversation_id: int,
    request_id: str,
    pending: AssistantProposal,
    data: MessageRequest,
) -> ReplyResponse:
    pending.status = "rejected"
    pending.resolved_at = datetime.now(timezone.utc)
    nxt = _pop_follow(pending.payload)
    if nxt is not None:
        await _store_turn(
            session,
            conversation_id,
            request_id=request_id,
            user_text=data.text,
            kind="cancelled",
            assistant_text="Эту не создаю.",
        )
        return await _offer_follow(session, user, conversation_id, request_id, nxt, event=None)
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


def _update_preview_card(event: RitmEvent, update: dict | None, color: str | None) -> dict:
    raw = dict(update or {})
    title = raw.get("title")
    if not isinstance(title, str) or not title.strip():
        title = event.title
    else:
        title = title.strip()
    card = proposal_card(
        item_type=event.type,
        title=title,
        day=event.date,
        clock=event.time,
        duration_min=event.duration_min,
        color=color,
        is_deadline=event.is_deadline,
        intent="update",
    )
    card["item_id"] = event.id
    card["workspace_id"] = event.workspace_id
    card["update"] = raw
    card["complete"] = True
    card["fingerprint"] = _fingerprint(card)
    return card


async def _apply_pending_update(
    session: AsyncSession,
    user: User,
    conversation_id: int,
    request_id: str,
    pending: AssistantProposal,
    data: MessageRequest,
) -> ReplyResponse:
    payload = dict(pending.payload)
    item_id = payload.get("item_id")
    if not isinstance(item_id, int):
        raise Unprocessable("Модель не указала запись")
    workspace_id = payload.get("workspace_id")
    space_id = workspace_id if isinstance(workspace_id, int) else data.workspace_id
    await _owned_item(session, user, item_id, space_id)
    await item_service.update_item(
        session, user, item_id, assistant_service._update_payload(payload.get("update"))
    )
    pending.status = "confirmed"
    pending.payload = payload
    pending.result_item_id = item_id
    pending.resolved_at = datetime.now(timezone.utc)
    event = await _ritm(session, user, item_id)
    text = "Запись обновлена"
    await _store_turn(
        session,
        conversation_id,
        request_id=request_id,
        user_text=data.text,
        kind="updated",
        assistant_text=text,
    )
    return _reply(
        kind="updated",
        text=text,
        request_id=request_id,
        events=[event],
        proposal=payload,
    )


async def _handle_update(
    session: AsyncSession,
    user: User,
    conversation_id: int,
    request_id: str,
    data: MessageRequest,
    command,
) -> ReplyResponse:
    if command.item_id is None:
        raise Unprocessable("Модель не указала запись")
    try:
        event = await _ritm(session, user, command.item_id, data.workspace_id)
    except NotFound:
        text = "Не нашла эту запись в текущем пространстве."
        await _store_turn(
            session,
            conversation_id,
            request_id=request_id,
            user_text=data.text,
            kind="info",
            assistant_text=text,
        )
        return _reply(kind="info", text=text, request_id=request_id)
    payload = _update_preview_card(event, command.item, _chosen_color(data))
    if data.require_confirmation:
        await _put_pending(session, conversation_id, request_id, payload, action="update")
        text = command.reply.strip() or "Проверьте изменения и подтвердите."
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
            proposal=payload,
            suggestions=["Да", "Нет"],
            expecting="confirmation",
        )
    await assistant_repository.reject_open(session, conversation_id)
    await item_service.update_item(
        session, user, command.item_id, assistant_service._update_payload(command.item)
    )
    event = await _ritm(session, user, command.item_id, data.workspace_id)
    text = command.reply.strip() or "Запись обновлена"
    await _store_turn(
        session,
        conversation_id,
        request_id=request_id,
        user_text=data.text,
        kind="updated",
        assistant_text=text,
    )
    return _reply(kind="updated", text=text, request_id=request_id, events=[event], proposal=payload)


async def handle_message(
    session: AsyncSession, user: User, data: MessageRequest
) -> ReplyResponse:
    conversation = await _conversation(session, user, data.session_id, data.workspace_id)
    request_id = _request_key(data.request_id)
    if data.request_id:
        user_row = await assistant_repository.user_message_for_request(
            session, conversation.id, data.request_id
        )
        if user_row is not None and mask_profanity(user_row.text) != mask_profanity(data.text):
            raise Conflict("Эта фраза уже отправлялась с другим текстом")
        assistant = await assistant_repository.last_assistant_for_request(
            session, conversation.id, data.request_id
        )
        if assistant is not None:
            return await _replay_message(session, user, conversation.id, assistant)
    if is_rejected(data.text):
        await _store_turn(
            session,
            conversation.id,
            request_id=request_id,
            user_text=data.text,
            kind="info",
            assistant_text=REFUSAL,
        )
        return _reply(kind="info", text=REFUSAL, request_id=request_id)
    pending = await assistant_repository.latest_pending(session, conversation.id)
    spoken = for_model(data.text)
    verdict = _verdict(spoken)
    if pending is not None and pending.action == "delete":
        outcome = await _take_delete_choice(
            session, user, conversation.id, request_id, pending, data, spoken
        )
        if outcome is not None:
            return outcome
        pending = None
    elif pending is not None and verdict == "yes":
        return await _confirm_pending(session, user, conversation.id, request_id, pending, data)
    elif pending is not None and verdict == "no":
        return await _reject_pending(session, user, conversation.id, request_id, pending, data)

    phrase = match_list_phrase(spoken, assistant_service.local_now(user))
    space_id = data.workspace_id
    if phrase is not None:
        return await _answer_list(session, user, conversation.id, request_id, data, phrase, space_id)
    history = await assistant_repository.list_messages(session, conversation.id, 20)
    dialog = _context(history, pending)
    agenda = await assistant_service.agenda_text(session, user, workspace_id=space_id)
    context = "\n".join(part for part in (agenda, dialog) if part)
    command = await assistant_service.interpret(user, spoken, context)
    if command.action == "create" or (
        command.action == "none" and assistant_service.has_create_fields(command)
    ):
        return await _handle_create(session, user, conversation.id, request_id, data, command, pending)
    if command.action == "list":
        await assistant_repository.reject_open(session, conversation.id)
        query = _scoped_query(assistant_service._query(command.filters), space_id)
        found = await item_service.list_items(session, user, query)
        events = [await _ritm(session, user, row.id) for row in found.items]
        text = assistant_service.reply_for_filters(found, query, user)
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
        return await _handle_delete(session, user, conversation.id, request_id, data, spoken)
    if command.action == "update":
        return await _handle_update(
            session, user, conversation.id, request_id, data, command
        )
    return await _handle_none(session, user, conversation.id, request_id, data, command, pending)


async def _answer_list(
    session: AsyncSession,
    user: User,
    conversation_id: int,
    request_id: str,
    data: MessageRequest,
    phrase,
    workspace_id: int | None,
) -> ReplyResponse:
    await assistant_repository.reject_open(session, conversation_id)
    found = await item_service.list_items(
        session, user, _scoped_query(assistant_service._query_from_phrase(phrase), workspace_id)
    )
    events = [await _ritm(session, user, row.id) for row in found.items]
    text = assistant_service.list_reply(found, phrase, ZoneInfo(user.timezone))
    await _store_turn(
        session,
        conversation_id,
        request_id=request_id,
        user_text=data.text,
        kind="info",
        assistant_text=text,
    )
    return _reply(kind="info", text=text, request_id=request_id, events=events)


def _pop_follow(payload: dict) -> dict | None:
    follow = payload.get("follow")
    if not isinstance(follow, list) or not follow or not isinstance(follow[0], dict):
        return None
    nxt = dict(follow[0])
    tail = [dict(row) for row in follow[1:] if isinstance(row, dict)]
    if tail:
        nxt["follow"] = tail
    else:
        nxt.pop("follow", None)
    return nxt


def _moment_label(day: str | None, clock: str | None, today: date) -> str:
    clock_text = clock[:5] if isinstance(clock, str) and len(clock) >= 5 else ""
    label = ""
    if isinstance(day, str):
        try:
            parsed = date.fromisoformat(day)
        except ValueError:
            parsed = None
        if parsed is not None:
            delta = (parsed - today).days
            label = {0: "сегодня", 1: "завтра", 2: "послезавтра", -1: "вчера"}.get(
                delta, parsed.strftime("%d.%m")
            )
    if label and clock_text:
        return f"{label} в {clock_text}"
    if label:
        return label
    if clock_text:
        return f"в {clock_text}"
    return "без даты"


def _payload_line(payload: dict, index: int, today: date) -> str:
    names = {"task": "задача", "meeting": "встреча", "reminder": "напоминание"}
    kind = names.get(str(payload.get("event_type")), "запись")
    title = str(payload.get("title") or "Без названия")
    day = payload.get("date") if isinstance(payload.get("date"), str) else None
    clock = payload.get("time") if isinstance(payload.get("time"), str) else None
    return f"{index}. {kind} «{title}», {_moment_label(day, clock, today)}"


def _batch_text(payloads: list[dict], today: date, truncated: bool) -> str:
    lines = [_payload_line(payload, index, today) for index, payload in enumerate(payloads, 1)]
    head = "В фразе несколько записей. Каждую нужно подтвердить."
    if truncated:
        head += " Беру первые три."
    return head + "\n" + "\n".join(lines) + "\nСначала первая."


async def _offer_follow(
    session: AsyncSession,
    user: User,
    conversation_id: int,
    request_id: str,
    nxt: dict,
    event: RitmEvent | None,
) -> ReplyResponse:
    next_id = f"{request_id}:next"
    await _put_pending(session, conversation_id, next_id, nxt)
    today = assistant_service.local_now(user).date()
    lead = "Запись создана." if event is not None else "Эту не создаю."
    text = lead + "\nСледующая ждёт подтверждения.\n" + _payload_line(nxt, 1, today)
    await _store_turn(
        session,
        conversation_id,
        request_id=next_id,
        user_text=None,
        kind="confirm",
        assistant_text=text,
    )
    return _reply(
        kind="created" if event is not None else "cancelled",
        text=text,
        request_id=next_id,
        events=[event] if event is not None else [],
        proposal=nxt,
        suggestions=["Да", "Нет"],
        expecting="confirmation",
    )


async def _offer_batch(
    session: AsyncSession,
    user: User,
    conversation_id: int,
    request_id: str,
    data: MessageRequest,
    creates: list[ItemCreate],
    color: str | None,
    truncated: bool,
) -> ReplyResponse:
    today = assistant_service.local_now(user).date()
    payloads = []
    for index, item in enumerate(creates, 1):
        payload = _payload_from_create(item, color, user.timezone)
        payload["batch_index"] = index
        payload["batch_total"] = len(creates)
        payloads.append(payload)
    first = dict(payloads[0])
    rest = [dict(row) for row in payloads[1:]]
    if rest:
        first["follow"] = rest
    await _put_pending(session, conversation_id, request_id, first)
    text = _batch_text(payloads, today, truncated)
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
        proposal=first,
        suggestions=["Да", "Нет"],
        expecting="confirmation",
    )


async def _handle_delete(
    session: AsyncSession,
    user: User,
    conversation_id: int,
    request_id: str,
    data: MessageRequest,
    spoken: str,
) -> ReplyResponse:
    found = await item_service.list_items(
        session, user, _scoped_query(ItemQuery(limit=200, offset=0), data.workspace_id)
    )
    decision = resolve_delete(found.items, spoken, assistant_service.local_now(user))
    await assistant_repository.reject_open(session, conversation_id)
    if decision.item_id is not None:
        await item_service.delete_item(session, user, decision.item_id)
        await _store_turn(
            session,
            conversation_id,
            request_id=request_id,
            user_text=data.text,
            kind="deleted",
            assistant_text=decision.text,
        )
        return _reply(kind="deleted", text=decision.text, request_id=request_id)
    if decision.choices:
        events = [await _ritm(session, user, item_id) for item_id in decision.choices]
        await _put_pending(
            session,
            conversation_id,
            request_id,
            {"intent": "delete", "event_ids": list(decision.choices)},
            action="delete",
        )
        await _store_turn(
            session,
            conversation_id,
            request_id=request_id,
            user_text=data.text,
            kind="choice",
            assistant_text=decision.text,
        )
        return _reply(
            kind="choice",
            text=decision.text,
            request_id=request_id,
            events=events,
            expecting="choice",
        )
    await _store_turn(
        session,
        conversation_id,
        request_id=request_id,
        user_text=data.text,
        kind="info",
        assistant_text=decision.text,
    )
    return _reply(kind="info", text=decision.text, request_id=request_id)


async def _take_delete_choice(
    session: AsyncSession,
    user: User,
    conversation_id: int,
    request_id: str,
    pending: AssistantProposal,
    data: MessageRequest,
    spoken: str,
) -> ReplyResponse | None:
    raw_ids = pending.payload.get("event_ids")
    ids = [int(item_id) for item_id in raw_ids] if isinstance(raw_ids, list) else []
    index = choice_index(spoken)
    if index is not None:
        if index < 1 or index > len(ids):
            text = "В списке нет такого номера."
            await _store_turn(
                session,
                conversation_id,
                request_id=request_id,
                user_text=data.text,
                kind="clarify",
                assistant_text=text,
            )
            return _reply(kind="clarify", text=text, request_id=request_id, expecting="choice")
        item_id = ids[index - 1]
        await item_service.delete_item(session, user, item_id)
        pending.status = "confirmed"
        pending.resolved_at = datetime.now(timezone.utc)
        text = "Запись удалена"
        await _store_turn(
            session,
            conversation_id,
            request_id=request_id,
            user_text=data.text,
            kind="deleted",
            assistant_text=text,
        )
        return _reply(kind="deleted", text=text, request_id=request_id)
    if _verdict(spoken) == "no":
        pending.status = "rejected"
        pending.resolved_at = datetime.now(timezone.utc)
        text = "Хорошо, не удаляю."
        await _store_turn(
            session,
            conversation_id,
            request_id=request_id,
            user_text=data.text,
            kind="cancelled",
            assistant_text=text,
        )
        return _reply(kind="cancelled", text=text, request_id=request_id)
    if _verdict(spoken) == "yes" or not is_command(spoken):
        text = "Напишите номер записи из списка."
        await _store_turn(
            session,
            conversation_id,
            request_id=request_id,
            user_text=data.text,
            kind="clarify",
            assistant_text=text,
        )
        return _reply(kind="clarify", text=text, request_id=request_id, expecting="choice")
    pending.status = "rejected"
    pending.resolved_at = datetime.now(timezone.utc)
    return None


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
        creates, truncated = assistant_service.command_creates(command)
    except Unprocessable:
        return await _handle_none(session, user, conversation_id, request_id, data, command, pending)
    color = _chosen_color(data, pending.payload if pending is not None else None)
    creates = [
        await _bind_workspace(
            session,
            user,
            row.model_copy(
                update={
                    "workspace_id": data.workspace_id
                    if data.workspace_id is not None
                    else row.workspace_id
                }
            ),
        )
        for row in creates
    ]
    if len(creates) > 1:
        return await _offer_batch(
            session, user, conversation_id, request_id, data, creates, color, truncated
        )
    item = creates[0]
    payload = _payload_from_create(item, color, user.timezone)
    if not payload.get("complete"):
        await _put_pending(session, conversation_id, request_id, payload)
        text = _incomplete_text(item.item_type)
        await _store_turn(
            session,
            conversation_id,
            request_id=request_id,
            user_text=data.text,
            kind="clarify",
            assistant_text=text,
        )
        return _reply(kind="clarify", text=text, request_id=request_id, proposal=payload)
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


async def _offer_declined_retry(
    session: AsyncSession,
    user: User,
    conversation_id: int,
    request_id: str,
    data: MessageRequest,
    command: AssistantCommand,
    pending: AssistantProposal | None,
) -> ReplyResponse | None:
    spoken = for_model(data.text)
    if not is_create_phrase(spoken) or not _asks_to_confirm(command.reply):
        return None
    rejected = _matching_rejected_create(
        await assistant_repository.list_proposals(session, conversation_id),
        spoken,
        command.reply,
    )
    if rejected is None:
        return None
    try:
        item = _item_from_payload(rejected.payload, user.timezone)
    except (KeyError, TypeError, Unprocessable):
        return None
    synthetic = AssistantCommand(
        action="create",
        reply=command.reply,
        item=item.model_dump(exclude_none=True),
    )
    return await _handle_create(
        session, user, conversation_id, request_id, data, synthetic, pending
    )


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
    if pending is None:
        retried = await _offer_declined_retry(
            session, user, conversation_id, request_id, data, command, pending
        )
        if retried is not None:
            return retried
    color = _chosen_color(data, pending.payload if pending is not None else None)
    if pending is not None or color:
        payload = dict(pending.payload) if pending is not None else proposal_card(
            item_type="task",
            title=(for_model(data.text) or "Запись")[:300],
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
    session: AsyncSession,
    user: User,
    session_id: str | None,
    limit: int,
    workspace_id: int | None = None,
) -> HistoryResponse:
    if workspace_id is not None:
        await workspace_service.get_owned(session, user, workspace_id)
    conversation = await assistant_repository.get_conversation(
        session, user.id, _session_key(session_id, workspace_id)
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
        if index == last_assistant and pending is not None and pending.status == "pending":
            if pending_color is not None:
                item["pending_color"] = pending_color
            item["proposal"] = _public_proposal(pending.payload)
            item["active_confirmation"] = row.kind == "confirm"
            if row.kind == "confirm":
                item["expecting"] = "confirmation"
                item["suggestions"] = ["Да", "Нет"]
            elif row.kind in {"choice", "clarify"}:
                item["expecting"] = "choice"
        elif item.get("active_confirmation") and row.kind == "confirm":
            item["expecting"] = "confirmation"
            item["suggestions"] = ["Да", "Нет"]
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
