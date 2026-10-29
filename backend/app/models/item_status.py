from sqlalchemy import ForeignKey, Identity, SmallInteger, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ItemStatus(Base):
    __tablename__ = "item_statuses"
    __table_args__ = (UniqueConstraint("item_type_code", "code"),)

    id: Mapped[int] = mapped_column(SmallInteger, Identity(always=True), primary_key=True)
    item_type_code: Mapped[str] = mapped_column(Text, ForeignKey("item_types.code"))
    code: Mapped[str] = mapped_column(Text)
    name: Mapped[str] = mapped_column(Text)
