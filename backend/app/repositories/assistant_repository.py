from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.assistant import AssistantConversation, AssistantMessage, AssistantProposal


async def get_or_create_conversation(
    session: AsyncSession, user_id: int, client_session_id: str
) -> AssistantConversation:
    found = await session.scalar(
        select(AssistantConversation).where(
            AssistantConversation.user_id == user_id,
            AssistantConversation.client_session_id == client_session_id,
        )
    )
    if found is not None:
        return found
    row = AssistantConversation(user_id=user_id, client_session_id=client_session_id)
    session.add(row)
    await session.flush()
    return row


async def get_conversation(
    session: AsyncSession, user_id: int, client_session_id: str
) -> AssistantConversation | None:
    return await session.scalar(
        select(AssistantConversation).where(
            AssistantConversation.user_id == user_id,
            AssistantConversation.client_session_id == client_session_id,
        )
    )


async def add_message(
    session: AsyncSession,
    conversation_id: int,
    *,
    role: str,
    text: str,
    kind: str | None = None,
    request_id: str | None = None,
) -> AssistantMessage:
    row = AssistantMessage(
        conversation_id=conversation_id,
        role=role,
        text=text,
        kind=kind,
        request_id=request_id,
    )
    session.add(row)
    await session.flush()
    return row


async def list_messages(
    session: AsyncSession, conversation_id: int, limit: int
) -> list[AssistantMessage]:
    result = await session.scalars(
        select(AssistantMessage)
        .where(AssistantMessage.conversation_id == conversation_id)
        .order_by(AssistantMessage.created_at.desc(), AssistantMessage.id.desc())
        .limit(limit)
    )
    rows = list(result)
    rows.reverse()
    return rows


async def list_proposals(
    session: AsyncSession, conversation_id: int
) -> list[AssistantProposal]:
    result = await session.scalars(
        select(AssistantProposal).where(AssistantProposal.conversation_id == conversation_id)
    )
    return list(result)


async def reject_open(
    session: AsyncSession,
    conversation_id: int,
    *,
    keep_request_id: str | None = None,
) -> None:
    result = await session.scalars(
        select(AssistantProposal).where(
            AssistantProposal.conversation_id == conversation_id,
            AssistantProposal.status == "pending",
        )
    )
    now = datetime.now(timezone.utc)
    for row in result:
        if keep_request_id and row.request_id == keep_request_id:
            continue
        row.status = "rejected"
        row.resolved_at = now


async def user_message_for_request(
    session: AsyncSession, conversation_id: int, request_id: str
) -> AssistantMessage | None:
    return await session.scalar(
        select(AssistantMessage)
        .where(
            AssistantMessage.conversation_id == conversation_id,
            AssistantMessage.request_id == request_id,
            AssistantMessage.role == "user",
        )
        .order_by(AssistantMessage.id)
        .limit(1)
    )


async def last_assistant_for_request(
    session: AsyncSession, conversation_id: int, request_id: str
) -> AssistantMessage | None:
    return await session.scalar(
        select(AssistantMessage)
        .where(
            AssistantMessage.conversation_id == conversation_id,
            AssistantMessage.request_id == request_id,
            AssistantMessage.role == "assistant",
        )
        .order_by(AssistantMessage.id.desc())
        .limit(1)
    )


async def get_proposal(
    session: AsyncSession, conversation_id: int, request_id: str
) -> AssistantProposal | None:
    return await session.scalar(
        select(AssistantProposal).where(
            AssistantProposal.conversation_id == conversation_id,
            AssistantProposal.request_id == request_id,
        )
    )


async def latest_pending(
    session: AsyncSession, conversation_id: int
) -> AssistantProposal | None:
    return await session.scalar(
        select(AssistantProposal)
        .where(
            AssistantProposal.conversation_id == conversation_id,
            AssistantProposal.status == "pending",
        )
        .order_by(AssistantProposal.created_at.desc(), AssistantProposal.id.desc())
        .limit(1)
    )


async def add_proposal(
    session: AsyncSession,
    conversation_id: int,
    *,
    request_id: str,
    action: str,
    payload: dict,
    status: str = "pending",
    result_item_id: int | None = None,
) -> AssistantProposal:
    row = AssistantProposal(
        conversation_id=conversation_id,
        request_id=request_id,
        action=action,
        payload=payload,
        status=status,
        result_item_id=result_item_id,
        resolved_at=None if status == "pending" else datetime.now(timezone.utc),
    )
    session.add(row)
    await session.flush()
    return row
