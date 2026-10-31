from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import persist
from app.core.errors import Conflict, NotFound
from app.models.user import User
from app.models.workspace import Workspace
from app.repositories import workspace_repository
from app.repositories.workspace_repository import DEFAULT_WORKSPACE_NAME
from app.schemas.workspace import WorkspaceCreate, WorkspaceList, WorkspaceRead, WorkspaceUpdate


def to_read(workspace: Workspace) -> WorkspaceRead:
    return WorkspaceRead(id=workspace.id, name=workspace.name, is_default=workspace.is_default)


async def ensure_default(session: AsyncSession, user: User) -> Workspace:
    found = await workspace_repository.get_default(session, user.id)
    if found is not None:
        return found
    workspace = Workspace(user_id=user.id, name=DEFAULT_WORKSPACE_NAME, is_default=True)
    workspace_repository.add(session, workspace)
    await persist(session)
    await session.refresh(workspace)
    return workspace


async def list_workspaces(session: AsyncSession, user: User) -> WorkspaceList:
    await ensure_default(session, user)
    rows = await workspace_repository.list_for_user(session, user.id)
    return WorkspaceList(workspaces=[to_read(row) for row in rows])


async def get_owned(session: AsyncSession, user: User, workspace_id: int) -> Workspace:
    found = await workspace_repository.get_owned(session, user.id, workspace_id)
    if found is None:
        raise NotFound("Пространство не найдено")
    return found


async def resolve_id(session: AsyncSession, user: User, workspace_id: int | None) -> int:
    if workspace_id is None:
        return (await ensure_default(session, user)).id
    return (await get_owned(session, user, workspace_id)).id


async def create_workspace(session: AsyncSession, user: User, data: WorkspaceCreate) -> WorkspaceRead:
    await ensure_default(session, user)
    if await workspace_repository.name_taken(session, user.id, data.name):
        raise Conflict("Пространство с таким названием уже есть")
    workspace = Workspace(user_id=user.id, name=data.name, is_default=False)
    workspace_repository.add(session, workspace)
    await persist(session)
    await session.refresh(workspace)
    return to_read(workspace)


async def rename_workspace(
    session: AsyncSession, user: User, workspace_id: int, data: WorkspaceUpdate
) -> WorkspaceRead:
    workspace = await get_owned(session, user, workspace_id)
    if await workspace_repository.name_taken(session, user.id, data.name, except_id=workspace.id):
        raise Conflict("Пространство с таким названием уже есть")
    workspace.name = data.name
    await persist(session)
    await session.refresh(workspace)
    return to_read(workspace)
