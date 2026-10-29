"""Загружает тестовый набор в Postgres.

Повторный запуск удаляет пользователей anna, boris и clara вместе с их записями
и создаёт набор заново. Справочники типов и статусов не трогает.

С хоста, при портах из docker-compose:

    python scripts/testdatagen/seed.py

Другое подключение: переменная DATABASE_URL.
"""

import hashlib
import os
import sys
from datetime import datetime, timezone

import psycopg

from dataset import PASSWORD, build

DEFAULT_URL = "postgresql://aivritm:aivritm@127.0.0.1:5435/aivritm"

INSERT_ITEM = """
    INSERT INTO planner_items (
        user_id,
        item_type_code,
        status_id,
        title,
        description,
        start_at,
        end_at,
        due_on,
        due_at,
        remind_at
    )
    VALUES (
        %s,
        %s,
        (
            SELECT id
            FROM item_statuses
            WHERE item_type_code = %s AND code = %s
        ),
        %s,
        %s,
        %s,
        %s,
        %s,
        %s,
        %s
    )
"""


def main() -> None:
    database_url = os.environ.get("DATABASE_URL", DEFAULT_URL)
    now = datetime.now(timezone.utc)
    fixtures = build(now)
    logins = [fixture.user.login for fixture in fixtures]
    password_hash = hashlib.sha256(PASSWORD.encode()).hexdigest()

    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM item_types")
            if cur.fetchone()[0] == 0:
                raise SystemExit(
                    "Справочники пустые. Сначала примените backend/sql/001_init.sql"
                )

            cur.execute("DELETE FROM users WHERE login = ANY(%s)", (logins,))

            for fixture in fixtures:
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
                for item in fixture.items:
                    cur.execute(
                        INSERT_ITEM,
                        (
                            user_id,
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
                        ),
                    )

            cur.execute(
                """
                SELECT u.login, p.item_type_code, COUNT(*)
                FROM planner_items AS p
                JOIN users AS u ON u.id = p.user_id
                WHERE u.login = ANY(%s)
                GROUP BY u.login, p.item_type_code
                ORDER BY u.login, p.item_type_code
                """,
                (logins,),
            )
            rows = cur.fetchall()

    print(f"Загружено пользователей: {len(fixtures)}")
    for login, type_code, count in rows:
        print(f"  {login} {type_code}: {count}")


if __name__ == "__main__":
    try:
        main()
    except psycopg.Error as exc:
        print(f"Ошибка базы: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
