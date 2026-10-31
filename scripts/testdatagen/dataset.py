"""Фиксированный тестовый набор планировщика.

Даты считаются от момента запуска, в часовом поясе пользователя.
Описание набора — в testdescription.md, его нужно обновлять вместе с этим файлом.
"""

from dataclasses import dataclass, replace
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

DEFAULT_WORKSPACE = "Общее пространство"
WORK_WORKSPACE = "Работа"
PERSONAL_WORKSPACE = "Личное"
ANNA_WORKSPACES = (WORK_WORKSPACE, PERSONAL_WORKSPACE)
ANNA_WORK_TITLES = frozenset(
    {
        "Сдать отчёт",
        "Позвонить клиенту",
        "Подготовить слайды",
        "Переезд сервера",
        "Стендап",
        "Демо заказчику",
        "Планёрка",
        "Созвон с подрядчиком",
        "Воркшоп",
        "Дежурство",
        "Быстрый вопрос",
        "Ретроспектива",
        "Забрать пропуск",
    }
)
ANNA_PERSONAL_TITLES = frozenset(
    {
        "Оплатить интернет",
        "Записаться к врачу",
        "Разобрать почту",
        "Черновик статьи",
        "Налоги",
        "Старый черновик",
        "Позвонить маме",
        "Оплатить парковку",
        "Отменить подписку",
        "Продлить домен",
    }
)

PASSWORD = "testpass"


@dataclass(frozen=True)
class User:
    login: str
    email: str | None
    timezone: str


@dataclass(frozen=True)
class Item:
    type_code: str
    status_code: str
    title: str
    description: str | None = None
    start_at: datetime | None = None
    end_at: datetime | None = None
    due_on: date | None = None
    due_at: datetime | None = None
    remind_at: datetime | None = None
    priority: str | None = None
    color: str | None = None
    completed_at: datetime | None = None
    deleted_at: datetime | None = None
    workspace: str | None = None


@dataclass(frozen=True)
class Message:
    role: str
    text: str
    kind: str | None = "info"
    request_id: str | None = None


@dataclass(frozen=True)
class Proposal:
    request_id: str
    action: str
    payload: dict
    status: str = "pending"
    result_title: str | None = None


@dataclass(frozen=True)
class Conversation:
    client_session_id: str
    messages: tuple[Message, ...]
    proposals: tuple[Proposal, ...] = ()


@dataclass(frozen=True)
class UserFixture:
    user: User
    items: tuple[Item, ...]
    type_colors: tuple[tuple[str, str], ...] = ()
    conversation: Conversation | None = None
    extra_workspaces: tuple[str, ...] = ()


def build(now: datetime) -> tuple[UserFixture, ...]:
    if now.tzinfo is None:
        raise ValueError("now должен быть timezone-aware")
    return (
        UserFixture(
            User("anna", "anna@example.com", "Europe/Moscow"),
            _anna(now),
            type_colors=(("meeting", "#3d7a62"),),
            conversation=_anna_chat(now),
            extra_workspaces=ANNA_WORKSPACES,
        ),
        UserFixture(
            User("boris", "boris@example.com", "Asia/Yekaterinburg"),
            _boris(now),
            type_colors=(("task", "#4f72d8"),),
            conversation=_boris_chat(),
        ),
        UserFixture(User("clara", None, "UTC"), _clara(now)),
    )


def _day(now: datetime, timezone: str, shift_days: int = 0) -> date:
    local_today = now.astimezone(ZoneInfo(timezone)).date()
    return local_today + timedelta(days=shift_days)


def _at(day: date, hour: int, minute: int, timezone: str) -> datetime:
    return datetime.combine(day, time(hour, minute), tzinfo=ZoneInfo(timezone))


def _anna(now: datetime) -> tuple[Item, ...]:
    tz = "Europe/Moscow"
    today = _day(now, tz)
    items = (
        Item("task", "todo", "Купить молоко", priority="medium"),
        Item(
            "task",
            "todo",
            "Сдать отчёт",
            description="Квартальный отчёт в бухгалтерию",
            due_on=today,
            priority="urgent",
            color="#be5766",
        ),
        Item(
            "task",
            "todo",
            "Оплатить интернет",
            due_on=_day(now, tz, -1),
            priority="important",
        ),
        Item("task", "todo", "Записаться к врачу", due_on=_day(now, tz, 7), priority="low"),
        Item(
            "task",
            "in_progress",
            "Позвонить клиенту",
            due_at=_at(today, 18, 0, tz),
            remind_at=_at(today, 17, 30, tz),
            priority="urgent",
        ),
        Item(
            "task",
            "in_progress",
            "Подготовить слайды",
            start_at=_at(today, 14, 0, tz),
            end_at=_at(today, 16, 0, tz),
            due_at=_at(today, 16, 0, tz),
        ),
        Item(
            "task",
            "done",
            "Разобрать почту",
            description="Входящие за неделю",
            due_on=_day(now, tz, -3),
            completed_at=_at(_day(now, tz, -3), 18, 0, tz),
        ),
        Item(
            "task",
            "cancelled",
            "Переезд сервера",
            due_at=_at(_day(now, tz, 2), 11, 0, tz),
        ),
        Item(
            "task",
            "todo",
            "Черновик статьи",
            start_at=_at(_day(now, tz, 1), 10, 0, tz),
            due_on=_day(now, tz, 1),
        ),
        Item(
            "task",
            "todo",
            "Налоги",
            due_at=_at(_day(now, tz, 30), 12, 0, tz),
            remind_at=_at(_day(now, tz, 29), 9, 0, tz),
            priority="important",
        ),
        Item(
            "task",
            "todo",
            "Старый черновик",
            description="Мягко удалена, в списках не показывается",
            due_on=_day(now, tz, -10),
            deleted_at=_at(_day(now, tz, -2), 12, 0, tz),
        ),
        Item(
            "meeting",
            "scheduled",
            "Стендап",
            start_at=_at(today, 10, 0, tz),
            end_at=_at(today, 10, 15, tz),
            remind_at=_at(today, 9, 50, tz),
        ),
        Item(
            "meeting",
            "scheduled",
            "Демо заказчику",
            description="Показать прототип календаря",
            start_at=_at(today, 15, 0, tz),
            end_at=_at(today, 16, 0, tz),
            color="#2255aa",
        ),
        Item(
            "meeting",
            "done",
            "Планёрка",
            start_at=_at(_day(now, tz, -1), 11, 0, tz),
            end_at=_at(_day(now, tz, -1), 12, 0, tz),
            completed_at=_at(_day(now, tz, -1), 12, 0, tz),
        ),
        Item(
            "meeting",
            "cancelled",
            "Созвон с подрядчиком",
            start_at=_at(_day(now, tz, 1), 13, 0, tz),
            end_at=_at(_day(now, tz, 1), 13, 30, tz),
        ),
        Item(
            "meeting",
            "scheduled",
            "Воркшоп",
            start_at=_at(_day(now, tz, 3), 9, 0, tz),
            end_at=_at(_day(now, tz, 3), 13, 0, tz),
        ),
        Item(
            "meeting",
            "scheduled",
            "Дежурство",
            start_at=_at(today, 23, 0, tz),
            end_at=_at(_day(now, tz, 1), 1, 0, tz),
        ),
        Item(
            "meeting",
            "scheduled",
            "Быстрый вопрос",
            start_at=_at(_day(now, tz, 1), 9, 0, tz),
        ),
        Item(
            "meeting",
            "done",
            "Ретроспектива",
            description="Команда платформы",
            start_at=_at(_day(now, tz, -5), 16, 0, tz),
            end_at=_at(_day(now, tz, -5), 17, 0, tz),
            completed_at=_at(_day(now, tz, -5), 17, 0, tz),
        ),
        Item(
            "reminder",
            "pending",
            "Выпить воду",
            remind_at=now.astimezone(ZoneInfo(tz)).replace(microsecond=0) + timedelta(hours=1),
        ),
        Item(
            "reminder",
            "pending",
            "Забрать пропуск",
            remind_at=_at(_day(now, tz, 1), 9, 0, tz),
        ),
        Item(
            "reminder",
            "pending",
            "Позвонить маме",
            remind_at=_at(_day(now, tz, -1), 8, 0, tz),
        ),
        Item(
            "reminder",
            "done",
            "Оплатить парковку",
            remind_at=_at(_day(now, tz, -1), 19, 0, tz),
            completed_at=_at(_day(now, tz, -1), 19, 0, tz),
        ),
        Item(
            "reminder",
            "cancelled",
            "Отменить подписку",
            remind_at=_at(_day(now, tz, 2), 12, 0, tz),
        ),
        Item(
            "reminder",
            "pending",
            "Продлить домен",
            remind_at=_at(_day(now, tz, 14), 8, 0, tz),
        ),
    )
    tagged = []
    for item in items:
        if item.title in ANNA_WORK_TITLES:
            tagged.append(replace(item, workspace=WORK_WORKSPACE))
        elif item.title in ANNA_PERSONAL_TITLES:
            tagged.append(replace(item, workspace=PERSONAL_WORKSPACE))
        else:
            tagged.append(replace(item, workspace=DEFAULT_WORKSPACE))
    return tuple(tagged)


def _boris(now: datetime) -> tuple[Item, ...]:
    tz = "Asia/Yekaterinburg"
    return (
        Item("task", "todo", "Закрыть тикеты", due_on=_day(now, tz), priority="important"),
        Item(
            "task",
            "done",
            "Код-ревью",
            due_at=_at(_day(now, tz, -1), 17, 0, tz),
            completed_at=_at(_day(now, tz, -1), 17, 0, tz),
        ),
        Item(
            "meeting",
            "scheduled",
            "Созвон с Анной",
            start_at=_at(_day(now, tz, 1), 12, 0, tz),
            end_at=_at(_day(now, tz, 1), 12, 45, tz),
        ),
        Item(
            "reminder",
            "pending",
            "Забрать посылку",
            remind_at=_at(_day(now, tz, 1), 18, 0, tz),
        ),
    )


def _clara(now: datetime) -> tuple[Item, ...]:
    tz = "UTC"
    return (
        Item("task", "todo", "Идея для пет-проекта"),
        Item(
            "meeting",
            "scheduled",
            "Интервью",
            start_at=_at(_day(now, tz, 4), 15, 0, tz),
            end_at=_at(_day(now, tz, 4), 15, 30, tz),
        ),
        Item(
            "reminder",
            "pending",
            "Проверить CI",
            remind_at=_at(_day(now, tz, 1), 7, 0, tz),
        ),
    )


def _anna_chat(now: datetime) -> Conversation:
    tz = "Europe/Moscow"
    start = _at(_day(now, tz, 1), 11, 0, tz)
    request_id = "seed-anna-create-1"
    return Conversation(
        client_session_id="seed-anna-chat",
        messages=(
            Message("user", "Создай встречу с дизайнером завтра в 11", request_id=request_id),
            Message(
                "assistant",
                "Создать встречу «Дизайнер» завтра в 11:00?",
                kind="confirmation",
                request_id=request_id,
            ),
        ),
        proposals=(
            Proposal(
                request_id=request_id,
                action="create",
                payload={
                    "item_type": "meeting",
                    "title": "Дизайнер",
                    "start_at": start.isoformat(),
                },
            ),
        ),
    )


def _boris_chat() -> Conversation:
    request_id = "seed-boris-update-1"
    return Conversation(
        client_session_id="seed-boris-chat",
        messages=(
            Message("user", "Отметь код-ревью выполненным", request_id=request_id),
            Message("assistant", "Отметила «Код-ревью» как готовую.", request_id=request_id),
        ),
        proposals=(
            Proposal(
                request_id=request_id,
                action="update",
                payload={"status": "done"},
                status="confirmed",
                result_title="Код-ревью",
            ),
        ),
    )
