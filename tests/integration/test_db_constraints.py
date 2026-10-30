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
    assert names == ["001_init.sql", "002_sessions.sql"]
    tables = {
        row[0]
        for row in pg.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
        ).fetchall()
    }
    assert tables >= {"users", "sessions", "item_types", "item_statuses", "planner_items"}


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
    pg.execute("DELETE FROM users WHERE id = %s", (user_id,))
    items = pg.execute("SELECT COUNT(*) FROM planner_items").fetchone()
    sessions = pg.execute("SELECT COUNT(*) FROM sessions").fetchone()
    assert items is not None and items[0] == 0
    assert sessions is not None and sessions[0] == 0
