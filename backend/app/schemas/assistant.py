from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.item import ItemRead

AssistantAction = Literal["create", "list", "update", "delete", "none"]


class AssistantMessageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=4000)

    @field_validator("text")
    @classmethod
    def not_blank(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("Пустой запрос")
        return text


class AssistantCommand(BaseModel):
    model_config = ConfigDict(extra="ignore")

    action: AssistantAction
    reply: str = ""
    item: dict | None = None
    item_id: int | None = None
    filters: dict | None = None


class AssistantMessageResponse(BaseModel):
    reply: str
    action: AssistantAction
    items: list[ItemRead]


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=4000)
    voice: str | None = Field(default=None, max_length=64)

    @field_validator("text")
    @classmethod
    def not_blank(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("Пустой текст")
        return text


class TranscriptionResponse(BaseModel):
    text: str
