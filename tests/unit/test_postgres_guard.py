import pytest

from tests import postgres_harness as harness


@pytest.mark.parametrize("name", ["intime", "postgres", "template1", "app", "intime_test"])
def test_reject_unsafe_database_names(name: str) -> None:
    with pytest.raises(RuntimeError, match="Отказ"):
        harness._reject_application_database(name)


def test_accepts_intime_test() -> None:
    harness._reject_application_database("intime_test")
