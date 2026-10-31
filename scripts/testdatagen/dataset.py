"""Фиксированный тестовый набор планировщика.

Даты считаются от момента запуска, в часовом поясе пользователя.
Описание набора — в testdescription.md, его нужно обновлять вместе с этим файлом.
"""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

DEFAULT_WORKSPACE = "Общее пространство"
WORK_WORKSPACE = "Работа"
PERSONAL_WORKSPACE = "Личное"
ANNA_WORKSPACES = (WORK_WORKSPACE, PERSONAL_WORKSPACE)

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
    general = (
        Item(
            "task",
            "todo",
            "Купить молоко",
            priority="medium",
            workspace=DEFAULT_WORKSPACE,
        ),
        Item(
            "task",
            "todo",
            "Купить хлеб",
            due_on=today,
            priority="important",
            workspace=DEFAULT_WORKSPACE,
        ),
        Item(
            "task",
            "done",
            "Протереть пол",
            due_on=_day(now, tz, -2),
            completed_at=_at(_day(now, tz, -2), 20, 0, tz),
            workspace=DEFAULT_WORKSPACE,
        ),
        Item(
            "meeting",
            "scheduled",
            "Планирование выходных",
            description="Что делаем в субботу и воскресенье",
            start_at=_at(today, 19, 0, tz),
            end_at=_at(today, 19, 30, tz),
            workspace=DEFAULT_WORKSPACE,
        ),
        Item(
            "meeting",
            "scheduled",
            "Поход в кино",
            start_at=_at(_day(now, tz, 2), 18, 0, tz),
            end_at=_at(_day(now, tz, 2), 20, 30, tz),
            workspace=DEFAULT_WORKSPACE,
        ),
        Item(
            "meeting",
            "done",
            "Созвон с родителями",
            start_at=_at(_day(now, tz, -1), 20, 0, tz),
            end_at=_at(_day(now, tz, -1), 20, 40, tz),
            completed_at=_at(_day(now, tz, -1), 20, 40, tz),
            workspace=DEFAULT_WORKSPACE,
        ),
        Item(
            "reminder",
            "pending",
            "Выпить воду",
            remind_at=now.astimezone(ZoneInfo(tz)).replace(microsecond=0) + timedelta(hours=1),
            workspace=DEFAULT_WORKSPACE,
        ),
        Item(
            "reminder",
            "pending",
            "Полить цветы",
            remind_at=_at(_day(now, tz, 1), 9, 0, tz),
            workspace=DEFAULT_WORKSPACE,
        ),
        Item(
            "reminder",
            "done",
            "Вынести мусор",
            remind_at=_at(_day(now, tz, -1), 21, 0, tz),
            completed_at=_at(_day(now, tz, -1), 21, 10, tz),
            workspace=DEFAULT_WORKSPACE,
        ),
    )
    work = (
        Item(
            "task",
            "todo",
            "Сдать отчёт",
            description="Квартальный отчёт в бухгалтерию",
            due_on=today,
            priority="urgent",
            color="#be5766",
            workspace=WORK_WORKSPACE,
        ),
        Item(
            "task",
            "in_progress",
            "Позвонить клиенту",
            due_at=_at(today, 18, 0, tz),
            remind_at=_at(today, 17, 30, tz),
            priority="urgent",
            workspace=WORK_WORKSPACE,
        ),
        Item(
            "task",
            "in_progress",
            "Подготовить слайды",
            start_at=_at(today, 14, 0, tz),
            end_at=_at(today, 16, 0, tz),
            due_at=_at(today, 16, 0, tz),
            workspace=WORK_WORKSPACE,
        ),
        Item(
            "task",
            "cancelled",
            "Переезд сервера",
            due_at=_at(_day(now, tz, 2), 11, 0, tz),
            workspace=WORK_WORKSPACE,
        ),
        Item(
            "meeting",
            "scheduled",
            "Стендап",
            start_at=_at(today, 10, 0, tz),
            end_at=_at(today, 10, 15, tz),
            remind_at=_at(today, 9, 50, tz),
            workspace=WORK_WORKSPACE,
        ),
        Item(
            "meeting",
            "scheduled",
            "Демо заказчику",
            description="Показать прототип календаря",
            start_at=_at(today, 15, 0, tz),
            end_at=_at(today, 16, 0, tz),
            color="#2255aa",
            workspace=WORK_WORKSPACE,
        ),
        Item(
            "meeting",
            "done",
            "Планёрка",
            start_at=_at(_day(now, tz, -1), 11, 0, tz),
            end_at=_at(_day(now, tz, -1), 12, 0, tz),
            completed_at=_at(_day(now, tz, -1), 12, 0, tz),
            workspace=WORK_WORKSPACE,
        ),
        Item(
            "meeting",
            "cancelled",
            "Созвон с подрядчиком",
            start_at=_at(_day(now, tz, 1), 13, 0, tz),
            end_at=_at(_day(now, tz, 1), 13, 30, tz),
            workspace=WORK_WORKSPACE,
        ),
        Item(
            "meeting",
            "scheduled",
            "Воркшоп",
            start_at=_at(_day(now, tz, 3), 9, 0, tz),
            end_at=_at(_day(now, tz, 3), 13, 0, tz),
            workspace=WORK_WORKSPACE,
        ),
        Item(
            "meeting",
            "scheduled",
            "Дежурство",
            start_at=_at(today, 23, 0, tz),
            end_at=_at(_day(now, tz, 1), 1, 0, tz),
            workspace=WORK_WORKSPACE,
        ),
        Item(
            "meeting",
            "scheduled",
            "Быстрый вопрос",
            start_at=_at(_day(now, tz, 1), 9, 0, tz),
            workspace=WORK_WORKSPACE,
        ),
        Item(
            "meeting",
            "done",
            "Ретроспектива",
            description="Команда платформы",
            start_at=_at(_day(now, tz, -5), 16, 0, tz),
            end_at=_at(_day(now, tz, -5), 17, 0, tz),
            completed_at=_at(_day(now, tz, -5), 17, 0, tz),
            workspace=WORK_WORKSPACE,
        ),
        Item(
            "reminder",
            "pending",
            "Забрать пропуск",
            remind_at=_at(_day(now, tz, 1), 9, 0, tz),
            workspace=WORK_WORKSPACE,
        ),
        Item(
            "reminder",
            "pending",
            "Отправить протокол стендапа",
            remind_at=_at(today, 12, 0, tz),
            workspace=WORK_WORKSPACE,
        ),
        Item(
            "reminder",
            "done",
            "Проверить стенд",
            remind_at=_at(_day(now, tz, -1), 9, 30, tz),
            completed_at=_at(_day(now, tz, -1), 9, 40, tz),
            workspace=WORK_WORKSPACE,
        ),
    )
    personal = (
        Item(
            "task",
            "todo",
            "Оплатить интернет",
            due_on=_day(now, tz, -1),
            priority="important",
            workspace=PERSONAL_WORKSPACE,
        ),
        Item(
            "task",
            "todo",
            "Записаться к врачу",
            due_on=_day(now, tz, 7),
            priority="low",
            workspace=PERSONAL_WORKSPACE,
        ),
        Item(
            "task",
            "todo",
            "Забрать куртку из химчистки",
            due_on=today,
            priority="medium",
            workspace=PERSONAL_WORKSPACE,
        ),
        Item(
            "task",
            "done",
            "Разобрать почту",
            description="Входящие за неделю",
            due_on=_day(now, tz, -3),
            completed_at=_at(_day(now, tz, -3), 18, 0, tz),
            workspace=PERSONAL_WORKSPACE,
        ),
        Item(
            "task",
            "todo",
            "Черновик статьи",
            start_at=_at(_day(now, tz, 1), 10, 0, tz),
            due_on=_day(now, tz, 1),
            workspace=PERSONAL_WORKSPACE,
        ),
        Item(
            "task",
            "todo",
            "Налоги",
            due_at=_at(_day(now, tz, 30), 12, 0, tz),
            remind_at=_at(_day(now, tz, 29), 9, 0, tz),
            priority="important",
            workspace=PERSONAL_WORKSPACE,
        ),
        Item(
            "task",
            "todo",
            "Старый черновик",
            description="Мягко удалена, в списках не показывается",
            due_on=_day(now, tz, -10),
            deleted_at=_at(_day(now, tz, -2), 12, 0, tz),
            workspace=PERSONAL_WORKSPACE,
        ),
        Item(
            "meeting",
            "scheduled",
            "Тренировка",
            start_at=_at(today, 18, 0, tz),
            end_at=_at(today, 19, 0, tz),
            workspace=PERSONAL_WORKSPACE,
        ),
        Item(
            "meeting",
            "scheduled",
            "Ужин с друзьями",
            start_at=_at(_day(now, tz, 2), 19, 0, tz),
            end_at=_at(_day(now, tz, 2), 21, 0, tz),
            workspace=PERSONAL_WORKSPACE,
        ),
        Item(
            "meeting",
            "done",
            "Прогулка в парке",
            start_at=_at(_day(now, tz, -2), 11, 0, tz),
            end_at=_at(_day(now, tz, -2), 12, 30, tz),
            completed_at=_at(_day(now, tz, -2), 12, 30, tz),
            workspace=PERSONAL_WORKSPACE,
        ),
        Item(
            "reminder",
            "pending",
            "Позвонить маме",
            remind_at=_at(_day(now, tz, -1), 8, 0, tz),
            workspace=PERSONAL_WORKSPACE,
        ),
        Item(
            "reminder",
            "done",
            "Оплатить парковку",
            remind_at=_at(_day(now, tz, -1), 19, 0, tz),
            completed_at=_at(_day(now, tz, -1), 19, 0, tz),
            workspace=PERSONAL_WORKSPACE,
        ),
        Item(
            "reminder",
            "cancelled",
            "Отменить подписку",
            remind_at=_at(_day(now, tz, 2), 12, 0, tz),
            workspace=PERSONAL_WORKSPACE,
        ),
        Item(
            "reminder",
            "pending",
            "Продлить домен",
            remind_at=_at(_day(now, tz, 14), 8, 0, tz),
            workspace=PERSONAL_WORKSPACE,
        ),
    )
    return general + work + personal


def _boris(now: datetime) -> tuple[Item, ...]:
    tz = "Asia/Yekaterinburg"
    today = _day(now, tz)
    return (
        Item(
            "task",
            "todo",
            "Закрыть тикеты",
            due_on=today,
            priority="important",
            workspace=DEFAULT_WORKSPACE,
        ),
        Item(
            "task",
            "done",
            "Код-ревью",
            due_at=_at(_day(now, tz, -1), 17, 0, tz),
            completed_at=_at(_day(now, tz, -1), 17, 0, tz),
            workspace=DEFAULT_WORKSPACE,
        ),
        Item(
            "meeting",
            "scheduled",
            "Синк по релизам",
            start_at=_at(today, 11, 0, tz),
            end_at=_at(today, 11, 30, tz),
            workspace=DEFAULT_WORKSPACE,
        ),
        Item(
            "meeting",
            "scheduled",
            "Созвон с Анной",
            start_at=_at(_day(now, tz, 1), 12, 0, tz),
            end_at=_at(_day(now, tz, 1), 12, 45, tz),
            workspace=DEFAULT_WORKSPACE,
        ),
        Item(
            "reminder",
            "pending",
            "Забрать посылку",
            remind_at=_at(_day(now, tz, 1), 18, 0, tz),
            workspace=DEFAULT_WORKSPACE,
        ),
    )


def _clara(now: datetime) -> tuple[Item, ...]:
    tz = "UTC"
    today = _day(now, tz)
    return (
        Item("task", "todo", "Идея для пет-проекта", workspace=DEFAULT_WORKSPACE),
        Item(
            "task",
            "todo",
            "Прочитать RFC",
            due_on=today,
            priority="low",
            workspace=DEFAULT_WORKSPACE,
        ),
        Item(
            "meeting",
            "scheduled",
            "Интервью",
            start_at=_at(_day(now, tz, 4), 15, 0, tz),
            end_at=_at(_day(now, tz, 4), 15, 30, tz),
            workspace=DEFAULT_WORKSPACE,
        ),
        Item(
            "reminder",
            "pending",
            "Проверить CI",
            remind_at=_at(_day(now, tz, 1), 7, 0, tz),
            workspace=DEFAULT_WORKSPACE,
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
