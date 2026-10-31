import re
from dataclasses import dataclass
from datetime import date, datetime
from zoneinfo import ZoneInfo

from num2words import num2words

from app.schemas.item import ItemRead
from app.services.list_phrase import mentioned_day


def _ordinal_forms() -> dict[str, int]:
    forms: dict[str, int] = {}
    for number in range(1, 31):
        forms[str(number)] = number
        for case in ("n", "g", "d", "a", "i", "p"):
            for gender in ("m", "f", "n"):
                for animate in (True, False):
                    word = num2words(
                        number,
                        lang="ru",
                        to="ordinal",
                        case=case,
                        gender=gender,
                        plural=False,
                        animate=animate,
                    )
                    forms[word.casefold().replace("ё", "е")] = number
    return forms


_ORDINALS = _ordinal_forms()
_STOP = frozenset(
    """
    удали удалить удалите убери убрать уберите сотри стереть
    пожалуйста мне мою мой моя мое мои это эту этот эти
    задачу задачи задача запись записи
    встречу встречи встреча напоминание напоминания
    на в во и или а же бы только именно про
    завтра сегодня послезавтра
    понедельник вторник среду четверг пятницу субботу воскресенье
    понедельника вторника среды четверга пятницы субботы
    утра вечера дня ночи утром вечером
    час часа часов минуту минут минуты время
    """.split()
)
_KIND = {"task": "задачу", "meeting": "встречу", "reminder": "напоминание"}


@dataclass(frozen=True)
class DeleteDecision:
    item_id: int | None
    choices: tuple[int, ...]
    text: str


@dataclass(frozen=True)
class _Row:
    id: int
    item_type: str
    title: str
    title_norm: str
    day: date | None
    clock: str | None


def choice_index(text: str) -> int | None:
    key = _norm(text)
    if key in _ORDINALS:
        return _ORDINALS[key]
    numbered = re.fullmatch(r"номер (\d{1,2})", key)
    if numbered:
        return int(numbered.group(1))
    words = key.split()
    if words and words[0] in _ORDINALS and len(words) <= 3:
        return _ORDINALS[words[0]]
    return None


def resolve_delete(items: list[ItemRead], text: str, now: datetime) -> DeleteDecision:
    zone = now.tzinfo if isinstance(now.tzinfo, ZoneInfo) else ZoneInfo("UTC")
    phrase = _norm(text)
    rows = [_row(item, zone) for item in items]
    if "задач" in phrase:
        rows = [row for row in rows if row.item_type == "task"]
    elif "встреч" in phrase:
        rows = [row for row in rows if row.item_type == "meeting"]
    elif "напомина" in phrase:
        rows = [row for row in rows if row.item_type == "reminder"]
    day = mentioned_day(text, now)
    clocks = _clocks(text)
    tokens = _title_tokens(phrase)
    pool = [row for row in rows if day is None or row.day == day]
    identified = bool(tokens or clocks)
    strict = [row for row in pool if _title_ok(row, tokens) and _clock_ok(row, clocks)]
    if identified and len(strict) == 1:
        return DeleteDecision(strict[0].id, (), _removed(strict[0], now.date()))
    if identified and len(strict) > 1:
        return _ask(strict, now.date(), "Подходят несколько записей. Какую удалить?")
    partial = [
        row
        for row in pool
        if (tokens and _title_ok(row, tokens)) or (clocks and _clock_ok(row, clocks))
    ]
    show = partial or (pool if not identified else [])
    if not show:
        return DeleteDecision(None, (), "Не нашла такую запись. Назовите название и время.")
    return _ask(show, now.date(), "Не уверена, какую запись удалить. Выберите нужную.")


def _ask(rows: list[_Row], today: date, lead: str) -> DeleteDecision:
    shown = sorted(rows, key=lambda row: (row.day or date.max, row.clock or "99:99", row.title))[:8]
    lines = [f"{index}. {row.title}, {_when(row, today)}" for index, row in enumerate(shown, 1)]
    return DeleteDecision(None, tuple(row.id for row in shown), lead + "\n" + "\n".join(lines))


def _removed(row: _Row, today: date) -> str:
    kind = _KIND.get(row.item_type, "запись")
    return f"Удаляю {kind} «{row.title}», {_when(row, today)}."


def _when(row: _Row, today: date) -> str:
    label = ""
    if row.day is not None:
        delta = (row.day - today).days
        label = {0: "сегодня", 1: "завтра", 2: "послезавтра", -1: "вчера"}.get(
            delta, row.day.strftime("%d.%m")
        )
    if label and row.clock:
        return f"{label} в {row.clock}"
    if label:
        return label
    if row.clock:
        return f"в {row.clock}"
    return "без даты"


def _row(item: ItemRead, zone: ZoneInfo) -> _Row:
    moment = item.start_at or item.due_at or item.remind_at
    day = item.due_on
    clock = None
    if moment is not None:
        local = moment.astimezone(zone)
        day = local.date()
        clock = local.strftime("%H:%M")
    return _Row(item.id, item.item_type, item.title, _norm(item.title), day, clock)


def _title_tokens(phrase: str) -> list[str]:
    tokens: list[str] = []
    for word in phrase.split():
        if word in _STOP or word.isdigit() or len(word) < 3:
            continue
        tokens.append(word)
    return tokens


def _title_ok(row: _Row, tokens: list[str]) -> bool:
    if not tokens:
        return True
    return all(re.search(rf"(?<!\w){re.escape(token)}", row.title_norm) for token in tokens)


def _clock_ok(row: _Row, clocks: set[str]) -> bool:
    if not clocks:
        return True
    return row.clock in clocks


def _clocks(text: str) -> set[str]:
    raw = text.casefold().replace("ё", "е")
    found: set[str] = set()
    for match in re.finditer(r"\b(\d{1,2})[:.](\d{2})\b", raw):
        hour, minute = int(match.group(1)), int(match.group(2))
        if hour <= 23 and minute <= 59:
            found.add(f"{hour:02d}:{minute:02d}")
    for match in re.finditer(r"\bв\s+(\d{1,2})(?:\s+(утра|вечера|дня|ночи))?\b", raw):
        hour = int(match.group(1))
        part = match.group(2)
        if part in {"вечера", "ночи"} and hour < 12:
            hour += 12
        if hour <= 23:
            found.add(f"{hour:02d}:00")
    return found


def _norm(text: str) -> str:
    cleaned = text.casefold().replace("ё", "е")
    cleaned = re.sub(r"[^\w\s]+", " ", cleaned, flags=re.UNICODE)
    return re.sub(r"\s+", " ", cleaned).strip()
