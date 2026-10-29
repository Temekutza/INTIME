BEGIN;

-- Пользователи

CREATE TABLE users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    login TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    email TEXT,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_login
        CHECK (login = BTRIM(login) AND LENGTH(login) > 0),

    CONSTRAINT valid_email
        CHECK (
            email IS NULL
            OR (email = BTRIM(email) AND LENGTH(email) > 0)
        )
);

CREATE UNIQUE INDEX users_login_unique
    ON users (LOWER(login));

CREATE UNIQUE INDEX users_email_unique
    ON users (LOWER(email))
    WHERE email IS NOT NULL;


-- Типы записей. Код — стабильный ключ, его же проверяют ограничения ниже.

CREATE TABLE item_types (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,

    CONSTRAINT valid_item_type_code
        CHECK (code = LOWER(code) AND code = BTRIM(code) AND LENGTH(code) > 0),

    CONSTRAINT valid_item_type_name
        CHECK (LENGTH(BTRIM(name)) > 0)
);


-- Статусы записей

CREATE TABLE item_statuses (
    id SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    item_type_code TEXT NOT NULL
        REFERENCES item_types (code),

    code TEXT NOT NULL,
    name TEXT NOT NULL,

    CONSTRAINT valid_status_code
        CHECK (code = LOWER(code) AND code = BTRIM(code) AND LENGTH(code) > 0),

    CONSTRAINT valid_status_name
        CHECK (LENGTH(BTRIM(name)) > 0),

    CONSTRAINT unique_type_status
        UNIQUE (item_type_code, code),

    CONSTRAINT unique_type_status_id
        UNIQUE (item_type_code, id)
);


-- Задачи, встречи, напоминания

CREATE TABLE planner_items (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    user_id BIGINT NOT NULL
        REFERENCES users (id) ON DELETE CASCADE,

    item_type_code TEXT NOT NULL
        REFERENCES item_types (code),

    status_id SMALLINT NOT NULL,

    title TEXT NOT NULL,
    description TEXT,

    start_at TIMESTAMPTZ,
    end_at TIMESTAMPTZ,

    due_on DATE,
    due_at TIMESTAMPTZ,
    remind_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_title
        CHECK (LENGTH(BTRIM(title)) > 0),

    CONSTRAINT valid_interval
        CHECK (
            end_at IS NULL
            OR (start_at IS NOT NULL AND end_at > start_at)
        ),

    CONSTRAINT valid_deadline
        CHECK (due_on IS NULL OR due_at IS NULL),

    CONSTRAINT known_item_type
        CHECK (item_type_code IN ('task', 'meeting', 'reminder')),

    CONSTRAINT fk_item_status
        FOREIGN KEY (item_type_code, status_id)
        REFERENCES item_statuses (item_type_code, id),

    CONSTRAINT meeting_requires_start
        CHECK (item_type_code <> 'meeting' OR start_at IS NOT NULL),

    CONSTRAINT reminder_requires_time
        CHECK (item_type_code <> 'reminder' OR remind_at IS NOT NULL)
);

CREATE INDEX planner_items_user_start_idx
    ON planner_items (user_id, start_at)
    WHERE start_at IS NOT NULL;

CREATE INDEX planner_items_user_due_at_idx
    ON planner_items (user_id, due_at)
    WHERE due_at IS NOT NULL;

CREATE INDEX planner_items_user_due_on_idx
    ON planner_items (user_id, due_on)
    WHERE due_on IS NOT NULL;

CREATE INDEX planner_items_remind_at_idx
    ON planner_items (remind_at)
    WHERE remind_at IS NOT NULL;


CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = statement_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER planner_items_set_updated_at
    BEFORE UPDATE ON planner_items
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();


INSERT INTO item_types (code, name) VALUES
    ('task', 'Задача'),
    ('meeting', 'Встреча'),
    ('reminder', 'Напоминание');

INSERT INTO item_statuses (item_type_code, code, name) VALUES
    ('task', 'todo', 'К выполнению'),
    ('task', 'in_progress', 'В работе'),
    ('task', 'done', 'Готово'),
    ('task', 'cancelled', 'Отменено'),
    ('meeting', 'scheduled', 'Запланировано'),
    ('meeting', 'done', 'Прошло'),
    ('meeting', 'cancelled', 'Отменено'),
    ('reminder', 'pending', 'Ожидает'),
    ('reminder', 'done', 'Сработало'),
    ('reminder', 'cancelled', 'Отменено');

COMMIT;
