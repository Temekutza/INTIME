import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.schemas.item import ItemRead

_CREATE_VERBS = (
    r"запиш\w*|записат\w*|постав\w*|созда\w*|добав\w*|напомни(?!а)\w*|"
    r"запланир\w*|назнач\w*"
)
_MUTATE_VERBS = r"удал\w*|убер\w*|сотр\w*|перенес\w*|измен\w*|передвин\w*|помен\w*"
_COMMAND = re.compile(rf"\b({_CREATE_VERBS}|{_MUTATE_VERBS})\b")
_CREATE = re.compile(rf"\b({_CREATE_VERBS})\b")
_CUE = r"(какие|какой|какая|какое|что|покажи|показать|список|есть|мои|мой|моя|расскажи|глянь|подскажи)"
_TIME = (
    r"(сегодня|завтра|послезавтра|понедельник\w*|вторник\w*|сред\w*|четверг\w*|"
    r"пятниц\w*|суббот\w*|воскресень\w*|недел\w*|выходн\w*)"
)
_NOUN = r"(задач\w*|встреч\w*|дела|напоминани\w*|план\w*|запис\w*)"
_LOOKUP = re.compile(
    rf"\b{_CUE}\b.*\b(?:{_TIME}|{_NOUN})\b|\b{_NOUN}\b.*\b{_TIME}\b|\b{_TIME}\b.*\b{_NOUN}\b"
)
_WEEKDAYS = (
    ("понедельник", 0, "понедельник"),
    ("вторник", 1, "вторник"),
    ("сред", 2, "среду"),
    ("четверг", 3, "четверг"),
    ("пятниц", 4, "пятницу"),
    ("суббот", 5, "субботу"),
    ("воскресень", 6, "воскресенье"),
)


@dataclass(frozen=True)
class ListPhrase:
    item_type: str | None
    start: datetime | None
    end: datetime | None
    label: str
    show_date: bool


def is_command(text: str) -> bool:
    return _COMMAND.search(_norm(text)) is not None


def is_create_phrase(text: str) -> bool:
    return _CREATE.search(_norm(text)) is not None


def mentioned_day(text: str, now: datetime) -> date | None:
    period = _period(_norm(text), now.date())
    if period is None:
        return None
    start, end, _label, show_date = period
    if show_date or start != end:
        return None
    return start


def match_list_phrase(text: str, now: datetime) -> ListPhrase | None:
    phrase = _norm(text)
    if not phrase or _COMMAND.search(phrase) or _LOOKUP.search(phrase) is None:
        return None
    zone = now.tzinfo
    if not isinstance(zone, ZoneInfo):
        zone = ZoneInfo("UTC")
        now = now.astimezone(zone)
    today = now.date()
    item_type = _item_type(phrase)
    period = _period(phrase, today)
    if period is None:
        label = _open_label(item_type)
        return ListPhrase(item_type, None, None, label, True)
    start_day, end_day, label, show_date = period
    return ListPhrase(
        item_type,
        _start(start_day, zone),
        _end(end_day, zone),
        label,
        show_date,
    )


def describe_items(
    items: list[ItemRead],
    total: int,
    *,
    label: str,
    show_date: bool,
    zone: ZoneInfo,
) -> str:
    if total <= 0 or not items:
        if label == "Среди задач":
            return "Задач нет."
        if label == "Среди встреч":
            return "Встреч нет."
        if label == "Среди напоминаний":
            return "Напоминаний нет."
        if label == "В записях":
            return "Записей нет."
        if label == "По запросу":
            return "Записей не найдено."
        return f"{label} записей нет."
    shown = items[:8]
    parts = [f"{item.title}{_when(item, zone, show_date)}" for item in shown]
    tail = f", и ещё {total - len(shown)}" if total > len(shown) else ""
    return f"{label}: " + "; ".join(parts) + tail


def agenda_line(item: ItemRead, zone: ZoneInfo) -> str:
    when = _stamp(item, zone, with_date=True) or "без даты"
    return f"id={item.id}; {item.item_type}; {item.title}; {when}"


def _norm(text: str) -> str:
    cleaned = text.casefold().replace("ё", "е")
    cleaned = re.sub(r"[^\w\s]+", " ", cleaned, flags=re.UNICODE)
    return re.sub(r"\s+", " ", cleaned).strip()


def _item_type(phrase: str) -> str | None:
    if re.search(r"задач", phrase):
        return "task"
    if re.search(r"встреч", phrase):
        return "meeting"
    if re.search(r"напоминани", phrase):
        return "reminder"
    return None


def _open_label(item_type: str | None) -> str:
    if item_type == "task":
        return "Среди задач"
    if item_type == "meeting":
        return "Среди встреч"
    if item_type == "reminder":
        return "Среди напоминаний"
    return "В записях"


def _period(phrase: str, today: date) -> tuple[date, date, str, bool] | None:
    if "послезавтра" in phrase:
        day = today + timedelta(days=2)
        return day, day, "Послезавтра", False
    if "завтра" in phrase:
        day = today + timedelta(days=1)
        return day, day, "На завтра", False
    if "сегодня" in phrase:
        return today, today, "На сегодня", False
    for stem, weekday, name in _WEEKDAYS:
        if stem in phrase:
            delta = (weekday - today.weekday()) % 7
            if "следующ" in phrase and delta == 0:
                delta = 7
            day = today + timedelta(days=delta)
            return day, day, f"В {name}", False
    if "выходн" in phrase:
        saturday = today + timedelta(days=(5 - today.weekday()) % 7)
        sunday = saturday + timedelta(days=1)
        if today.weekday() == 6:
            return today, today, "На выходных", False
        return saturday, sunday, "На выходных", True
    if "недел" in phrase:
        monday = today - timedelta(days=today.weekday())
        if "следующ" in phrase:
            monday += timedelta(days=7)
            return monday, monday + timedelta(days=6), "На следующей неделе", True
        sunday = monday + timedelta(days=6)
        return monday, sunday, "На этой неделе", True
    if re.search(r"\b(что у меня|какие дела|что запланир|мои дела)\b", phrase):
        return today, today, "На сегодня", False
    return None


def _start(day: date, zone: ZoneInfo) -> datetime:
    return datetime.combine(day, time.min, tzinfo=zone)


def _end(day: date, zone: ZoneInfo) -> datetime:
    return datetime.combine(day, time(23, 59, 59), tzinfo=zone)


def _when(item: ItemRead, zone: ZoneInfo, show_date: bool) -> str:
    stamp = _stamp(item, zone, with_date=show_date)
    if not stamp:
        return ""
    if show_date:
        return f" ({stamp})"
    return f" в {stamp}"


def _stamp(item: ItemRead, zone: ZoneInfo, *, with_date: bool) -> str | None:
    moment = item.start_at or item.due_at or item.remind_at
    if moment is not None:
        local = moment.astimezone(zone)
        if with_date:
            return local.strftime("%d.%m %H:%M")
        return local.strftime("%H:%M")
    if item.due_on is not None and with_date:
        return item.due_on.strftime("%d.%m")
    return None
