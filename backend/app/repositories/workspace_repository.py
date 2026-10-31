from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.workspace import Workspace

DEFAULT_WORKSPACE_NAME = "Общее пространство"


async def list_for_user(session: AsyncSession, user_id: int) -> list[Workspace]:
    rows = await session.execute(
        select(Workspace)
        .where(Workspace.user_id == user_id)
        .order_by(Workspace.is_default.desc(), Workspace.id)
    )
    return list(rows.scalars().all())


async def get_owned(session: AsyncSession, user_id: int, workspace_id: int) -> Workspace | None:
    return await session.scalar(
        select(Workspace).where(Workspace.id == workspace_id, Workspace.user_id == user_id)
    )


async def get_default(session: AsyncSession, user_id: int) -> Workspace | None:
    return await session.scalar(
        select(Workspace).where(Workspace.user_id == user_id, Workspace.is_default.is_(True))
    )


async def name_taken(
    session: AsyncSession, user_id: int, name: str, *, except_id: int | None = None
) -> bool:
    stmt = select(Workspace.id).where(
        Workspace.user_id == user_id,
        func.lower(Workspace.name) == name.lower(),
    )
    if except_id is not None:
        stmt = stmt.where(Workspace.id != except_id)
    return await session.scalar(stmt) is not None


def add(session: AsyncSession, workspace: Workspace) -> None:
    session.add(workspace)
