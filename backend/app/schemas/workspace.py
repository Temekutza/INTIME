from pydantic import BaseModel, ConfigDict, Field, field_validator


def normalize_workspace_name(value: str) -> str:
    text = value.strip()
    if not text:
        raise ValueError("Название пространства не может быть пустым")
    if len(text) > 80:
        raise ValueError("Название пространства не длиннее 80 символов")
    return text


class WorkspaceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)

    @field_validator("name")
    @classmethod
    def name_ok(cls, value: str) -> str:
        return normalize_workspace_name(value)


class WorkspaceUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)

    @field_validator("name")
    @classmethod
    def name_ok(cls, value: str) -> str:
        return normalize_workspace_name(value)


class WorkspaceRead(BaseModel):
    id: int
    name: str
    is_default: bool


class WorkspaceList(BaseModel):
    workspaces: list[WorkspaceRead]
