import re

from app.core.errors import Unprocessable

# Тот же список держит frontend/web/lib/profanity.js.
REFUSAL = "Так задачу не создать. Напишите обычными словами, что нужно сделать."
PLAIN_ERROR = "Не принимаем ненормативную лексику в тексте записи"

_TOKEN = re.compile(r"[0-9A-Za-zА-Яа-яЁё]+(?:[*._'\-]+[0-9A-Za-zА-Яа-яЁё]+)*")
_LEET = str.maketrans({"@": "а", "0": "о", "3": "е", "6": "б"})
_LETTERS = "абвгдежзийклмнопрстуфхцчшщъыьэюя"
_OBSCENE = re.compile(
    r"^(?:"
    r"ху[йяеи][а-я]*"
    r"|пизд[а-я]*"
    r"|пезд[а-я]*"
    r"|(?:по|на|за|вы|до|от|раз|рас|про|пере|под|при|из|об|вз|долбо|у|о|с)*еб(?:[ауиолстшеы][а-я]*)?"
    r"|бля(?:ть|д[а-я]*)?"
    r"|су(?:ка|ки|ку|ке|кой|кою|кам|ках|чар[а-я]*)"
    r"|пид[оае]р[а-я]*"
    r"|пидр[а-я]*"
    r"|муд(?:ак[а-я]*|ач[а-я]*|ил[а-я]*|о[а-я]*)"
    r"|гандон[а-я]*"
    r"|залуп[а-я]*"
    r"|дроч[а-я]*"
    r"|елд[аыуе][а-я]*"
    r"|(?:по|на)хер[а-я]*"
    r"|хер(?:а[а-я]*|у[а-я]*|ом[а-я]*|ня[а-я]*|ов[а-я]*|е[а-я]*)?"
    r"|манда"
    r")$"
)


def _expand(text: str) -> list[str]:
    if "?" not in text:
        return [text]
    head, _, tail = text.partition("?")
    found: list[str] = []
    for piece in _expand(tail):
        found.append(head + piece)
        found.extend(head + letter + piece for letter in _LETTERS)
    return found


def _keys(token: str) -> list[str]:
    text = token.casefold().replace("ё", "е").translate(_LEET)
    text = re.sub(r"[*._'\-]+", "?", text)
    text = re.sub(r"(.)\1+", r"\1", text)
    if text.count("?") > 2:
        text = text.replace("?", "")
    return [item for item in _expand(text) if item]


def _obscene(token: str) -> bool:
    return any(_OBSCENE.fullmatch(key) for key in _keys(token))


def _spans(text: str) -> list[tuple[int, int]]:
    return [match.span() for match in _TOKEN.finditer(text) if _obscene(match.group())]


def has_profanity(text: str) -> bool:
    return bool(_spans(text))


def mask_profanity(text: str) -> str:
    parts: list[str] = []
    cursor = 0
    for start, end in _spans(text):
        parts.append(text[cursor:start])
        parts.append("*" * (end - start))
        cursor = end
    parts.append(text[cursor:])
    return "".join(parts)


def _tidy(text: str) -> str:
    text = re.sub(r"\*+", " ", text)
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r"([,.;:!?])(?:\s*\1)+", r"\1", text)
    return text.strip(" ,.;:!?-—…\"'«»()[]")


def strip_profanity(text: str) -> str:
    parts: list[str] = []
    cursor = 0
    for start, end in _spans(text):
        parts.append(text[cursor:start])
        cursor = end
    parts.append(text[cursor:])
    return _tidy("".join(parts))


def for_model(text: str) -> str:
    return strip_profanity(text)


def is_rejected(text: str) -> bool:
    cleaned = for_model(text)
    return has_profanity(text) and re.search(r"[0-9A-Za-zА-Яа-яЁё]", cleaned) is None


def ensure_plain(*parts: str | None) -> None:
    if any(part and has_profanity(part) for part in parts):
        raise Unprocessable(PLAIN_ERROR)
