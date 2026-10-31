"""Загружает тестовый набор в Postgres.

Повторный запуск удаляет пользователей anna, boris и clara вместе с их записями
и создаёт набор заново. Справочники типов и статусов не трогает.

С хоста, при портах из docker-compose:

    python scripts/testdatagen/seed.py

Другое подключение: переменная DATABASE_URL.
"""

from __future__ import annotations

import hashlib
import sys
from datetime import datetime, timezone

import psycopg
from psycopg.types.json import Json

from dataset import DEFAULT_WORKSPACE, PASSWORD, Item, UserFixture, build
from db import database_url, describe_url

INSERT_ITEM = """
    INSERT INTO planner_items (
        user_id,
        workspace_id,
        item_type_code,
        status_id,
        title,
        description,
        start_at,
        end_at,
        due_on,
        due_at,
        remind_at,
        priority,
        color,
        completed_at,
        deleted_at
    )
    VALUES (
        %s,
        %s,
        %s,
        (
            SELECT id
            FROM item_statuses
            WHERE item_type_code = %s AND code = %s
        ),
        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
    )
    RETURNING id
"""


def _workspace_ids(cur, user_id: int, extra_names: tuple[str, ...]) -> dict[str, int]:
    cur.execute(
        "SELECT id, name FROM workspaces WHERE user_id = %s",
        (user_id,),
    )
    found = {str(name): int(row_id) for row_id, name in cur.fetchall()}
    if DEFAULT_WORKSPACE not in found:
        raise RuntimeError("У пользователя нет пространства по умолчанию")
    for name in extra_names:
        if name in found:
            continue
        cur.execute(
            """
            INSERT INTO workspaces (user_id, name, is_default)
            VALUES (%s, %s, FALSE)
            RETURNING id
            """,
            (user_id, name),
        )
        row = cur.fetchone()
        if row is None:
            raise RuntimeError(f"Не удалось создать пространство {name!r}")
        found[name] = int(row[0])
    return found


def _item_workspace_id(space_ids: dict[str, int], name: str | None) -> int:
    key = name or DEFAULT_WORKSPACE
    workspace_id = space_ids.get(key)
    if workspace_id is None:
        raise RuntimeError(f"Нет пространства {key!r} для записи")
    return workspace_id


def dispatch_row(item: Item, now: datetime) -> tuple[str, int, str | None, datetime | None] | None:
    if item.remind_at is None or item.deleted_at is not None:
        return None
    if item.status_code == "cancelled":
        return "cancelled", 0, None, None
    if item.status_code == "done":
        return "sent", 1, None, item.completed_at or item.remind_at
    if item.remind_at < now:
        return "failed", 3, "временная ошибка доставки", None
    return "pending", 0, None, None


def main() -> None:
    url = database_url()
    now = datetime.now(timezone.utc)
    fixtures = build(now)
    logins = [fixture.user.login for fixture in fixtures]
    password_hash = hashlib.sha256(PASSWORD.encode()).hexdigest()
    print(f"Загрузка в {describe_url(url)}")

    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('public.workspaces')")
            if cur.fetchone()[0] is None:
                raise SystemExit(
                    "Нет таблиц из 004_workspaces.sql. "
                    "Для рабочей базы примените backend/sql/004_workspaces.sql. "
                    "Для изолированной: python scripts/testdatagen/apply_schema.py"
                )

            cur.execute("DELETE FROM users WHERE login = ANY(%s)", (logins,))

            for fixture in fixtures:
                _insert_fixture(cur, fixture, password_hash, now)

            cur.execute(
                """
                SELECT u.login, w.name, p.item_type_code, COUNT(*)
                FROM planner_items AS p
                JOIN users AS u ON u.id = p.user_id
                JOIN workspaces AS w ON w.id = p.workspace_id
                WHERE u.login = ANY(%s) AND p.deleted_at IS NULL
                GROUP BY u.login, w.name, w.is_default, p.item_type_code
                ORDER BY u.login, w.is_default DESC, w.name, p.item_type_code
                """,
                (logins,),
            )
            item_rows = cur.fetchall()
            cur.execute(
                """
                SELECT
                    (SELECT COUNT(*) FROM user_type_colors c JOIN users u ON u.id = c.user_id WHERE u.login = ANY(%s)),
                    (SELECT COUNT(*) FROM reminder_dispatches d JOIN planner_items p ON p.id = d.item_id JOIN users u ON u.id = p.user_id WHERE u.login = ANY(%s)),
                    (SELECT COUNT(*) FROM assistant_conversations c JOIN users u ON u.id = c.user_id WHERE u.login = ANY(%s)),
                    (SELECT COUNT(*) FROM assistant_messages m JOIN assistant_conversations c ON c.id = m.conversation_id JOIN users u ON u.id = c.user_id WHERE u.login = ANY(%s)),
                    (SELECT COUNT(*) FROM assistant_proposals p JOIN assistant_conversations c ON c.id = p.conversation_id JOIN users u ON u.id = c.user_id WHERE u.login = ANY(%s)),
                    (SELECT COUNT(*) FROM planner_items p JOIN users u ON u.id = p.user_id WHERE u.login = ANY(%s) AND p.deleted_at IS NOT NULL),
                    (SELECT COUNT(*) FROM workspaces w JOIN users u ON u.id = w.user_id WHERE u.login = ANY(%s))
                """,
                (logins, logins, logins, logins, logins, logins, logins),
            )
            extras = cur.fetchone()

    print(f"Загружено пользователей: {len(fixtures)}")
    for login, space, type_code, count in item_rows:
        print(f"  {login} / {space} / {type_code}: {count}")
    if extras:
        print(
            "  цвета типов: {0}, отправки: {1}, разговоры: {2}, "
            "сообщения: {3}, предложения: {4}, мягко удалено: {5}, пространства: {6}".format(*extras)
        )


def _insert_fixture(cur, fixture: UserFixture, password_hash: str, now: datetime) -> None:
    user = fixture.user
    cur.execute(
        """
        INSERT INTO users (login, password_hash, email, timezone)
        VALUES (%s, %s, %s, %s)
        RETURNING id
        """,
        (user.login, password_hash, user.email, user.timezone),
    )
    user_id = cur.fetchone()[0]
    space_ids = _workspace_ids(cur, user_id, fixture.extra_workspaces)
    titles: dict[str, int] = {}
    for item in fixture.items:
        cur.execute(
            INSERT_ITEM,
            (
                user_id,
                _item_workspace_id(space_ids, item.workspace),
                item.type_code,
                item.type_code,
                item.status_code,
                item.title,
                item.description,
                item.start_at,
                item.end_at,
                item.due_on,
                item.due_at,
                item.remind_at,
                item.priority,
                item.color,
                item.completed_at,
                item.deleted_at,
            ),
        )
        item_id = cur.fetchone()[0]
        titles[item.title] = item_id
        dispatch = dispatch_row(item, now)
        if dispatch is None:
            continue
        status, attempts, error, sent_at = dispatch
        cur.execute(
            """
            INSERT INTO reminder_dispatches (
                item_id, planned_at, status, attempts, last_error, sent_at
            )
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (item_id, item.remind_at, status, attempts, error, sent_at),
        )

    for type_code, color in fixture.type_colors:
        cur.execute(
            """
            INSERT INTO user_type_colors (user_id, item_type_code, color)
            VALUES (%s, %s, %s)
            """,
            (user_id, type_code, color),
        )

    chat = fixture.conversation
    if chat is None:
        return
    cur.execute(
        """
        INSERT INTO assistant_conversations (user_id, client_session_id)
        VALUES (%s, %s)
        RETURNING id
        """,
        (user_id, chat.client_session_id),
    )
    conversation_id = cur.fetchone()[0]
    for message in chat.messages:
        cur.execute(
            """
            INSERT INTO assistant_messages (
                conversation_id, request_id, role, kind, text
            )
            VALUES (%s, %s, %s, %s, %s)
            """,
            (conversation_id, message.request_id, message.role, message.kind, message.text),
        )
    for proposal in chat.proposals:
        result_item_id = titles.get(proposal.result_title) if proposal.result_title else None
        resolved_at = now if proposal.status != "pending" else None
        cur.execute(
            """
            INSERT INTO assistant_proposals (
                conversation_id, request_id, action, payload, status,
                result_item_id, resolved_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                conversation_id,
                proposal.request_id,
                proposal.action,
                Json(proposal.payload),
                proposal.status,
                result_item_id,
                resolved_at,
            ),
        )


if __name__ == "__main__":
    try:
        main()
    except psycopg.Error as exc:
        print(f"Ошибка базы: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
