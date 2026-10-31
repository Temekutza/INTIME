import pytest
import psycopg
from psycopg.errors import CheckViolation, ForeignKeyViolation, UniqueViolation

from tests.postgres_harness import PostgresTarget, connect_test, delete_all_users


@pytest.fixture
def pg(test_database: PostgresTarget):
    conn = connect_test(test_database)
    yield conn
    conn.close()
    delete_all_users(test_database)


def _user_id(pg: psycopg.Connection, login: str = "dbuser") -> int:
    row = pg.execute(
        "INSERT INTO users (login, password_hash) VALUES (%s, %s) RETURNING id",
        (login, "hash"),
    ).fetchone()
    assert row is not None
    return int(row[0])


def _status_id(pg: psycopg.Connection, item_type: str, code: str) -> int:
    row = pg.execute(
        "SELECT id FROM item_statuses WHERE item_type_code = %s AND code = %s",
        (item_type, code),
    ).fetchone()
    assert row is not None
    return int(row[0])


def test_schema_sql_files_applied(test_database: PostgresTarget, pg: psycopg.Connection) -> None:
    names = [path.name for path in test_database.sql_files]
    assert names == [
        "001_init.sql",
        "002_sessions.sql",
        "003_interface_fields.sql",
        "004_workspaces.sql",
    ]
    tables = {
        row[0]
        for row in pg.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
        ).fetchall()
    }
    assert tables >= {
        "users",
        "sessions",
        "item_types",
        "item_statuses",
        "planner_items",
        "user_type_colors",
        "reminder_dispatches",
        "assistant_conversations",
        "assistant_messages",
        "assistant_proposals",
        "workspaces",
    }


def test_unique_login_is_case_insensitive(pg: psycopg.Connection) -> None:
    _user_id(pg, "Anna")
    with pytest.raises(UniqueViolation):
        _user_id(pg, "anna")


def test_unique_email_is_case_insensitive(pg: psycopg.Connection) -> None:
    pg.execute(
        "INSERT INTO users (login, password_hash, email) VALUES (%s, %s, %s)",
        ("one", "hash", "Mail@example.com"),
    )
    with pytest.raises(UniqueViolation):
        pg.execute(
            "INSERT INTO users (login, password_hash, email) VALUES (%s, %s, %s)",
            ("two", "hash", "mail@example.com"),
        )


def test_blank_title_check(pg: psycopg.Connection) -> None:
    user_id = _user_id(pg)
    status_id = _status_id(pg, "task", "todo")
    with pytest.raises(CheckViolation):
        pg.execute(
            """
            INSERT INTO planner_items (user_id, item_type_code, status_id, title)
            VALUES (%s, 'task', %s, '   ')
            """,
            (user_id, status_id),
        )


def test_meeting_requires_start(pg: psycopg.Connection) -> None:
    user_id = _user_id(pg)
    status_id = _status_id(pg, "meeting", "scheduled")
    with pytest.raises(CheckViolation):
        pg.execute(
            """
            INSERT INTO planner_items (user_id, item_type_code, status_id, title)
            VALUES (%s, 'meeting', %s, 'Стендап')
            """,
            (user_id, status_id),
        )


def test_reminder_requires_time(pg: psycopg.Connection) -> None:
    user_id = _user_id(pg)
    status_id = _status_id(pg, "reminder", "pending")
    with pytest.raises(CheckViolation):
        pg.execute(
            """
            INSERT INTO planner_items (user_id, item_type_code, status_id, title)
            VALUES (%s, 'reminder', %s, 'Вода')
            """,
            (user_id, status_id),
        )


def test_due_on_and_due_at_forbidden_together(pg: psycopg.Connection) -> None:
    user_id = _user_id(pg)
    status_id = _status_id(pg, "task", "todo")
    with pytest.raises(CheckViolation):
        pg.execute(
            """
            INSERT INTO planner_items (
                user_id, item_type_code, status_id, title, due_on, due_at
            )
            VALUES (%s, 'task', %s, 'Отчёт', '2026-10-30', '2026-10-30 12:00:00+03')
            """,
            (user_id, status_id),
        )


def test_end_must_follow_start(pg: psycopg.Connection) -> None:
    user_id = _user_id(pg)
    status_id = _status_id(pg, "meeting", "scheduled")
    with pytest.raises(CheckViolation):
        pg.execute(
            """
            INSERT INTO planner_items (
                user_id, item_type_code, status_id, title, start_at, end_at
            )
            VALUES (
                %s, 'meeting', %s, 'Стендап',
                '2026-10-30 12:00:00+03', '2026-10-30 11:00:00+03'
            )
            """,
            (user_id, status_id),
        )


def test_status_must_match_item_type(pg: psycopg.Connection) -> None:
    user_id = _user_id(pg)
    meeting_status = _status_id(pg, "meeting", "scheduled")
    with pytest.raises(ForeignKeyViolation):
        pg.execute(
            """
            INSERT INTO planner_items (user_id, item_type_code, status_id, title)
            VALUES (%s, 'task', %s, 'Не тот статус')
            """,
            (user_id, meeting_status),
        )


def test_unknown_item_type_rejected(pg: psycopg.Connection) -> None:
    user_id = _user_id(pg)
    status_id = _status_id(pg, "task", "todo")
    with pytest.raises((CheckViolation, ForeignKeyViolation)):
        pg.execute(
            """
            INSERT INTO planner_items (user_id, item_type_code, status_id, title)
            VALUES (%s, 'event', %s, 'Чужой тип')
            """,
            (user_id, status_id),
        )


def test_deleting_user_cascades_items_and_sessions(pg: psycopg.Connection) -> None:
    user_id = _user_id(pg, "cascade-user")
    status_id = _status_id(pg, "task", "todo")
    pg.execute(
        """
        INSERT INTO planner_items (user_id, item_type_code, status_id, title)
        VALUES (%s, 'task', %s, 'Исчезнет')
        """,
        (user_id, status_id),
    )
    pg.execute(
        """
        INSERT INTO sessions (user_id, token_hash, expires_at)
        VALUES (%s, 'token-hash', NOW() + INTERVAL '1 day')
        """,
        (user_id,),
    )
    pg.execute(
        """
        INSERT INTO user_type_colors (user_id, item_type_code, color)
        VALUES (%s, 'task', '#847cce')
        """,
        (user_id,),
    )
    pg.execute(
        """
        INSERT INTO assistant_conversations (user_id, client_session_id)
        VALUES (%s, 'sess-1')
        """,
        (user_id,),
    )
    pg.execute("DELETE FROM users WHERE id = %s", (user_id,))
    items = pg.execute("SELECT COUNT(*) FROM planner_items").fetchone()
    sessions = pg.execute("SELECT COUNT(*) FROM sessions").fetchone()
    colors = pg.execute("SELECT COUNT(*) FROM user_type_colors").fetchone()
    chats = pg.execute("SELECT COUNT(*) FROM assistant_conversations").fetchone()
    assert items is not None and items[0] == 0
    assert sessions is not None and sessions[0] == 0
    assert colors is not None and colors[0] == 0
    assert chats is not None and chats[0] == 0


def test_invalid_priority_rejected(pg: psycopg.Connection) -> None:
    user_id = _user_id(pg)
    status_id = _status_id(pg, "task", "todo")
    with pytest.raises(CheckViolation):
        pg.execute(
            """
            INSERT INTO planner_items (
                user_id, item_type_code, status_id, title, priority
            )
            VALUES (%s, 'task', %s, 'Срочно', 'high')
            """,
            (user_id, status_id),
        )


def test_invalid_item_color_rejected(pg: psycopg.Connection) -> None:
    user_id = _user_id(pg)
    status_id = _status_id(pg, "task", "todo")
    with pytest.raises(CheckViolation):
        pg.execute(
            """
            INSERT INTO planner_items (
                user_id, item_type_code, status_id, title, color
            )
            VALUES (%s, 'task', %s, 'Цвет', '#FFF')
            """,
            (user_id, status_id),
        )


def test_item_accepts_priority_and_color(pg: psycopg.Connection) -> None:
    user_id = _user_id(pg)
    status_id = _status_id(pg, "task", "todo")
    row = pg.execute(
        """
        INSERT INTO planner_items (
            user_id, item_type_code, status_id, title, priority, color
        )
        VALUES (%s, 'task', %s, 'Важно', 'urgent', '#be5766')
        RETURNING priority, color, completed_at, deleted_at
        """,
        (user_id, status_id),
    ).fetchone()
    assert row == ("urgent", "#be5766", None, None)


def test_user_type_color_unique_and_valid(pg: psycopg.Connection) -> None:
    user_id = _user_id(pg)
    pg.execute(
        """
        INSERT INTO user_type_colors (user_id, item_type_code, color)
        VALUES (%s, 'meeting', '#77a08d')
        """,
        (user_id,),
    )
    with pytest.raises(UniqueViolation):
        pg.execute(
            """
            INSERT INTO user_type_colors (user_id, item_type_code, color)
            VALUES (%s, 'meeting', '#123456')
            """,
            (user_id,),
        )
    with pytest.raises(CheckViolation):
        pg.execute(
            """
            INSERT INTO user_type_colors (user_id, item_type_code, color)
            VALUES (%s, 'task', 'red')
            """,
            (user_id,),
        )


def test_one_pending_dispatch_per_item(pg: psycopg.Connection) -> None:
    user_id = _user_id(pg)
    status_id = _status_id(pg, "reminder", "pending")
    item = pg.execute(
        """
        INSERT INTO planner_items (
            user_id, item_type_code, status_id, title, remind_at
        )
        VALUES (%s, 'reminder', %s, 'Вода', '2026-10-31 09:00:00+03')
        RETURNING id
        """,
        (user_id, status_id),
    ).fetchone()
    assert item is not None
    item_id = int(item[0])
    pg.execute(
        """
        INSERT INTO reminder_dispatches (item_id, planned_at)
        VALUES (%s, '2026-10-31 09:00:00+03')
        """,
        (item_id,),
    )
    with pytest.raises(UniqueViolation):
        pg.execute(
            """
            INSERT INTO reminder_dispatches (item_id, planned_at)
            VALUES (%s, '2026-10-31 09:00:00+03')
            """,
            (item_id,),
        )


def test_proposal_request_id_unique_in_conversation(pg: psycopg.Connection) -> None:
    user_id = _user_id(pg)
    conversation = pg.execute(
        """
        INSERT INTO assistant_conversations (user_id)
        VALUES (%s)
        RETURNING id
        """,
        (user_id,),
    ).fetchone()
    assert conversation is not None
    conversation_id = int(conversation[0])
    pg.execute(
        """
        INSERT INTO assistant_proposals (conversation_id, request_id, action, payload)
        VALUES (%s, 'req-1', 'create', '{"title": "Молоко"}'::jsonb)
        """,
        (conversation_id,),
    )
    with pytest.raises(UniqueViolation):
        pg.execute(
            """
            INSERT INTO assistant_proposals (conversation_id, request_id, action)
            VALUES (%s, 'req-1', 'create')
            """,
            (conversation_id,),
        )


def _default_workspace_id(pg: psycopg.Connection, user_id: int) -> int:
    row = pg.execute(
        "SELECT id, name, is_default FROM workspaces WHERE user_id = %s",
        (user_id,),
    ).fetchone()
    assert row is not None
    assert row[1] == "Общее пространство"
    assert row[2] is True
    return int(row[0])


def test_new_user_gets_default_workspace(pg: psycopg.Connection) -> None:
    user_id = _user_id(pg, "space-user")
    workspace_id = _default_workspace_id(pg, user_id)
    count = pg.execute(
        "SELECT COUNT(*) FROM workspaces WHERE user_id = %s",
        (user_id,),
    ).fetchone()
    assert count is not None and count[0] == 1
    assert workspace_id >= 1


def test_workspace_name_unique_per_user(pg: psycopg.Connection) -> None:
    user_id = _user_id(pg, "space-one")
    pg.execute(
        "INSERT INTO workspaces (user_id, name) VALUES (%s, %s)",
        (user_id, "Работа"),
    )
    with pytest.raises(UniqueViolation):
        pg.execute(
            "INSERT INTO workspaces (user_id, name) VALUES (%s, %s)",
            (user_id, "работа"),
        )
    other = _user_id(pg, "space-two")
    pg.execute(
        "INSERT INTO workspaces (user_id, name) VALUES (%s, %s)",
        (other, "Работа"),
    )


def test_item_gets_default_workspace_and_rejects_foreign(pg: psycopg.Connection) -> None:
    owner = _user_id(pg, "space-owner")
    other = _user_id(pg, "space-other")
    status_id = _status_id(pg, "task", "todo")
    default_id = _default_workspace_id(pg, owner)
    other_space = _default_workspace_id(pg, other)
    row = pg.execute(
        """
        INSERT INTO planner_items (user_id, item_type_code, status_id, title)
        VALUES (%s, 'task', %s, 'Без пространства')
        RETURNING workspace_id
        """,
        (owner, status_id),
    ).fetchone()
    assert row is not None and int(row[0]) == default_id
    with pytest.raises(ForeignKeyViolation):
        pg.execute(
            """
            INSERT INTO planner_items (
                user_id, workspace_id, item_type_code, status_id, title
            )
            VALUES (%s, %s, 'task', %s, 'Чужое пространство')
            """,
            (owner, other_space, status_id),
        )


def test_cannot_delete_workspace_with_items(pg: psycopg.Connection) -> None:
    user_id = _user_id(pg, "space-keep")
    status_id = _status_id(pg, "task", "todo")
    space = pg.execute(
        """
        INSERT INTO workspaces (user_id, name) VALUES (%s, %s) RETURNING id
        """,
        (user_id, "Работа"),
    ).fetchone()
    assert space is not None
    workspace_id = int(space[0])
    pg.execute(
        """
        INSERT INTO planner_items (
            user_id, workspace_id, item_type_code, status_id, title
        )
        VALUES (%s, %s, 'task', %s, 'Отчёт')
        """,
        (user_id, workspace_id, status_id),
    )
    with pytest.raises(ForeignKeyViolation):
        pg.execute("DELETE FROM workspaces WHERE id = %s", (workspace_id,))
