import pytest

from app.core.errors import Unprocessable
from app.services.assistant_service import _create_payload
from app.services.text_guard import (
    PLAIN_ERROR,
    ensure_plain,
    for_model,
    has_profanity,
    is_rejected,
    mask_profanity,
)


def test_ordinary_phrase_stays() -> None:
    text = "Поставь задачу проверить макет"
    assert mask_profanity(text) == text
    assert for_model(text) == text
    assert is_rejected(text) is False


@pytest.mark.parametrize(
    "text",
    [
        "учебник по истории",
        "купить хлеб и сукно",
        "мандарин и бляха",
        "поездка в Херсон",
        "мудрый коллега",
    ],
)
def test_similar_words_are_not_profanity(text: str) -> None:
    assert has_profanity(text) is False
    assert mask_profanity(text) == text


def test_task_with_profanity_keeps_the_request() -> None:
    raw = "запиши задачу в 10 утра на прием блять"
    assert is_rejected(raw) is False
    assert for_model(raw) == "запиши задачу в 10 утра на прием"
    assert mask_profanity(raw) == "запиши задачу в 10 утра на прием *****"


def test_mixed_phrase_is_masked_in_chat_and_cleaned_for_model() -> None:
    raw = "Поставь задачу, блять, проверить макет"
    assert mask_profanity(raw) == "Поставь задачу, *****, проверить макет"
    assert for_model(raw) == "Поставь задачу, проверить макет"
    assert is_rejected(raw) is False


def test_profanity_only_is_rejected() -> None:
    assert is_rejected("блять!!!") is True
    assert for_model("блять!!!") == ""


def test_confirmation_with_profanity_keeps_the_answer() -> None:
    assert for_model("да, блять") == "да"


def test_obfuscated_word_is_masked() -> None:
    assert mask_profanity("х*й") == "***"
    assert is_rejected("х*й") is True


def test_task_text_with_profanity_is_refused() -> None:
    with pytest.raises(Unprocessable, match=PLAIN_ERROR):
        ensure_plain("проверить блять макет")


def test_create_payload_drops_profanity_from_title() -> None:
    item = _create_payload({"item_type": "task", "title": "молоко блять"})
    assert item.title == "молоко"


def test_create_payload_rejects_title_made_of_profanity() -> None:
    with pytest.raises(Unprocessable):
        _create_payload({"item_type": "task", "title": "блять"})
