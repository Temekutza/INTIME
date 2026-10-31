"""Заполняет пространство «Тестовые данные» записями из CSV голосового набора.

Повторный запуск заменяет только записи этого пространства.

    python scripts/testdatagen/import_voice_events.py
"""

from __future__ import annotations

import csv
import sys
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from db import database_url, describe_url

ROOT = Path(__file__).resolve().parents[2]
CSV_PATH = ROOT / "voice_assistant_events_1000_77e927b5d2.csv"
WORKSPACE_NAME = "Тестовые данные"
LOGIN = "anna"
MEETING_MINUTES = 60
STATUS = {
    "task": "todo",
    "meeting": "scheduled",
    "reminder": "pending",
}


def classify(title: str) -> str:
    if title.startswith("Напомнить"):
        return "reminder"
    if title.startswith(
        ("Встреча", "Созвон", "Демо", "Провести планёрку", "Обсудить")
    ):
        return "meeting"
    return "task"


def read_rows(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        raise FileNotFoundError(f"Нет файла {path}")
    with path.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    if not rows:
        raise RuntimeError(f"Пустой CSV: {path}")
    required = {"date", "time", "text"}
    missing = required - set(rows[0].keys())
    if missing:
        raise RuntimeError(f"В CSV нет колонок: {', '.join(sorted(missing))}")
    return rows


def fill_workspace(cur, *, login: str = LOGIN, workspace: str = WORKSPACE_NAME, csv_path: Path = CSV_PATH) -> Counter:
    rows = read_rows(csv_path)
    cur.execute("SELECT id, timezone FROM users WHERE login = %s", (login,))
    user = cur.fetchone()
    if user is None:
        raise RuntimeError(f"Нет пользователя {login!r}. Сначала запустите seed.py")
    user_id, timezone_name = int(user[0]), str(user[1] or "UTC")
    zone = ZoneInfo(timezone_name)

    cur.execute(
        "SELECT id FROM workspaces WHERE user_id = %s AND LOWER(name) = LOWER(%s)",
        (user_id, workspace),
    )
    found = cur.fetchone()
    if found is None:
        cur.execute(
            """
            INSERT INTO workspaces (user_id, name, is_default)
            VALUES (%s, %s, FALSE)
            RETURNING id
            """,
            (user_id, workspace),
        )
        row = cur.fetchone()
        if row is None:
            raise RuntimeError(f"Не удалось создать пространство {workspace!r}")
        workspace_id = int(row[0])
    else:
        workspace_id = int(found[0])

    cur.execute(
        """
        SELECT item_type_code, id
        FROM item_statuses
        WHERE (item_type_code, code) IN (
            ('task', 'todo'),
            ('meeting', 'scheduled'),
            ('reminder', 'pending')
        )
        """
    )
    status_ids = {str(kind): int(status_id) for kind, status_id in cur.fetchall()}
    if set(status_ids) != {"task", "meeting", "reminder"}:
        raise RuntimeError("Нет статусов todo/scheduled/pending")

    cur.execute(
        "DELETE FROM planner_items WHERE user_id = %s AND workspace_id = %s",
        (user_id, workspace_id),
    )

    payload = []
    counts: Counter[str] = Counter()
    for row in rows:
        title = (row.get("text") or "").strip()
        day = (row.get("date") or "").strip()
        clock = (row.get("time") or "").strip()
        if not title or not day or not clock:
            raise RuntimeError(f"Пустые поля в строке CSV: {row}")
        kind = classify(title)
        moment = datetime.fromisoformat(f"{day}T{clock}").replace(tzinfo=zone)
        start_at = end_at = due_at = remind_at = None
        if kind == "meeting":
            start_at = moment
            end_at = moment + timedelta(minutes=MEETING_MINUTES)
        elif kind == "reminder":
            remind_at = moment
        else:
            due_at = moment
        payload.append(
            (
                user_id,
                workspace_id,
                kind,
                status_ids[kind],
                title,
                start_at,
                end_at,
                due_at,
                remind_at,
            )
        )
        counts[kind] += 1

    cur.executemany(
        """
        INSERT INTO planner_items (
            user_id, workspace_id, item_type_code, status_id, title,
            start_at, end_at, due_at, remind_at
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        payload,
    )
    counts["workspace_id"] = workspace_id
    counts["total"] = len(payload)
    return counts


def main() -> None:
    import psycopg

    url = database_url()
    print(f"CSV {CSV_PATH.name} → {describe_url(url)} / {LOGIN} / {WORKSPACE_NAME}")
    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            counts = fill_workspace(cur)
    print(
        f"Пространство id={counts['workspace_id']}: "
        f"{counts['total']} записей "
        f"(task {counts['task']}, meeting {counts['meeting']}, reminder {counts['reminder']})"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
