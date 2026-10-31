import re

from safetext import SafeText

from app.core.errors import Unprocessable

# Словарь — пакет safetext. В браузере тот же список лежит в profanity-words.js.
REFUSAL = "Так задачу не создать. Напишите обычными словами, что нужно сделать."
PLAIN_ERROR = "Не принимаем ненормативную лексику в тексте записи"

_TOKEN = re.compile(r"[0-9A-Za-zА-Яа-яЁё]+(?:[*._'\-]+[0-9A-Za-zА-Яа-яЁё]+)*")
_LEET = str.maketrans({"@": "а", "0": "о", "3": "е", "6": "б"})
_LETTERS = "абвгдежзийклмнопрстуфхцчшщъыьэюя"
_MASK = set("*._'-")
_checker = SafeText(language="ru")


def _merge(spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
    if not spans:
        return []
    ordered = sorted(spans)
    merged = [ordered[0]]
    for start, end in ordered[1:]:
        prev_start, prev_end = merged[-1]
        if start <= prev_end:
            merged[-1] = (prev_start, max(prev_end, end))
        else:
            merged.append((start, end))
    return merged


def _hidden_token(token: str) -> bool:
    folded = token.casefold().replace("ё", "е").translate(_LEET)
    positions = [index for index, char in enumerate(folded) if char in _MASK]
    if len(positions) != 1 or len(folded) > 24:
        return False
    index = positions[0]
    for letter in _LETTERS:
        candidate = folded[:index] + letter + folded[index + 1 :]
        if _checker.check_profanity(candidate):
            return True
    return False


def _spans(text: str) -> list[tuple[int, int]]:
    found = [(item["start"], item["end"]) for item in _checker.check_profanity(text)]
    for match in _TOKEN.finditer(text):
        if _hidden_token(match.group()):
            found.append(match.span())
    return _merge(found)


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
