import pytest

from tests import postgres_harness as harness


@pytest.mark.parametrize("name", ["aivritm", "postgres", "template1", "app", "Aivritm_test"])
def test_reject_unsafe_database_names(name: str) -> None:
    with pytest.raises(RuntimeError, match="Отказ"):
        harness._reject_application_database(name)


def test_accepts_aivritm_test() -> None:
    harness._reject_application_database("aivritm_test")
