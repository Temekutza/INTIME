import pytest
from pydantic import ValidationError

from app.schemas.workspace import WorkspaceCreate, WorkspaceUpdate, normalize_workspace_name


def test_workspace_name_is_trimmed() -> None:
    assert normalize_workspace_name("  Работа  ") == "Работа"
    created = WorkspaceCreate(name="  Личное  ")
    assert created.name == "Личное"
    updated = WorkspaceUpdate(name=" Офис ")
    assert updated.name == "Офис"


@pytest.mark.parametrize("name", ["", "   ", "x" * 81])
def test_workspace_name_rejects_empty_and_too_long(name: str) -> None:
    with pytest.raises(ValidationError):
        WorkspaceCreate(name=name)
