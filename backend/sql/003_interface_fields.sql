BEGIN;

-- Поля записи для интерфейса. Не входит: пространства, календари, центр уведомлений.

ALTER TABLE planner_items
    ADD COLUMN priority TEXT,
    ADD COLUMN color TEXT,
    ADD COLUMN completed_at TIMESTAMPTZ,
    ADD COLUMN deleted_at TIMESTAMPTZ;

ALTER TABLE planner_items
    ADD CONSTRAINT planner_items_priority_check
        CHECK (
            priority IS NULL
            OR priority IN ('urgent', 'important', 'medium', 'low')
        ),
    ADD CONSTRAINT planner_items_color_check
        CHECK (color IS NULL OR color ~ '^#[0-9a-f]{6}$');

CREATE INDEX planner_items_user_active_idx
    ON planner_items (user_id)
    WHERE deleted_at IS NULL;

CREATE INDEX planner_items_remind_active_idx
    ON planner_items (remind_at)
    WHERE remind_at IS NOT NULL AND deleted_at IS NULL;


-- Стандартный цвет типа у пользователя. Строки нет — наследование.

CREATE TABLE user_type_colors (
    user_id BIGINT NOT NULL
        REFERENCES users (id) ON DELETE CASCADE,
    item_type_code TEXT NOT NULL
        REFERENCES item_types (code),
    color TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (user_id, item_type_code),

    CONSTRAINT user_type_colors_color_check
        CHECK (color ~ '^#[0-9a-f]{6}$')
);

CREATE TRIGGER user_type_colors_set_updated_at
    BEFORE UPDATE ON user_type_colors
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();


-- Очередь отправки одного remind_at. Не inbox уведомлений.

CREATE TABLE reminder_dispatches (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    item_id BIGINT NOT NULL
        REFERENCES planner_items (id) ON DELETE CASCADE,

    planned_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT reminder_dispatches_status_check
        CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),

    CONSTRAINT reminder_dispatches_attempts_check
        CHECK (attempts >= 0)
);

CREATE UNIQUE INDEX reminder_dispatches_item_pending_uidx
    ON reminder_dispatches (item_id)
    WHERE status = 'pending';

CREATE INDEX reminder_dispatches_due_idx
    ON reminder_dispatches (planned_at)
    WHERE status = 'pending';

CREATE TRIGGER reminder_dispatches_set_updated_at
    BEFORE UPDATE ON reminder_dispatches
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();


-- Диалог ассистента. Это не sessions логина.

CREATE TABLE assistant_conversations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL
        REFERENCES users (id) ON DELETE CASCADE,
    client_session_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT assistant_conversations_session_not_blank
        CHECK (
            client_session_id IS NULL
            OR LENGTH(BTRIM(client_session_id)) > 0
        )
);

CREATE UNIQUE INDEX assistant_conversations_user_session_uidx
    ON assistant_conversations (user_id, client_session_id)
    WHERE client_session_id IS NOT NULL;

CREATE INDEX assistant_conversations_user_idx
    ON assistant_conversations (user_id, updated_at DESC);

CREATE TRIGGER assistant_conversations_set_updated_at
    BEFORE UPDATE ON assistant_conversations
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();


CREATE TABLE assistant_messages (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id BIGINT NOT NULL
        REFERENCES assistant_conversations (id) ON DELETE CASCADE,
    request_id TEXT,
    role TEXT NOT NULL,
    kind TEXT,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT assistant_messages_role_check
        CHECK (role IN ('user', 'assistant')),

    CONSTRAINT assistant_messages_text_not_blank
        CHECK (LENGTH(BTRIM(text)) > 0),

    CONSTRAINT assistant_messages_request_id_not_blank
        CHECK (request_id IS NULL OR LENGTH(BTRIM(request_id)) > 0)
);

CREATE INDEX assistant_messages_conversation_idx
    ON assistant_messages (conversation_id, created_at, id);


CREATE TABLE assistant_proposals (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id BIGINT NOT NULL
        REFERENCES assistant_conversations (id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    action TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending',
    result_item_id BIGINT
        REFERENCES planner_items (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,

    CONSTRAINT assistant_proposals_request_id_not_blank
        CHECK (LENGTH(BTRIM(request_id)) > 0),

    CONSTRAINT assistant_proposals_action_check
        CHECK (action IN ('create', 'update', 'delete')),

    CONSTRAINT assistant_proposals_status_check
        CHECK (status IN ('pending', 'confirmed', 'rejected')),

    CONSTRAINT assistant_proposals_payload_object
        CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX assistant_proposals_request_uidx
    ON assistant_proposals (conversation_id, request_id);

CREATE INDEX assistant_proposals_pending_idx
    ON assistant_proposals (conversation_id)
    WHERE status = 'pending';

COMMIT;
