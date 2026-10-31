BEGIN;

-- Пространства пользователя. У каждого есть одно пространство по умолчанию.

CREATE TABLE workspaces (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL
        REFERENCES users (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_workspace_name
        CHECK (
            name = BTRIM(name)
            AND LENGTH(name) > 0
            AND LENGTH(name) <= 80
        ),

    CONSTRAINT workspaces_user_id_key
        UNIQUE (user_id, id)
);

CREATE UNIQUE INDEX workspaces_user_name_unique
    ON workspaces (user_id, LOWER(name));

CREATE UNIQUE INDEX workspaces_user_default_uidx
    ON workspaces (user_id)
    WHERE is_default;

CREATE INDEX workspaces_user_idx
    ON workspaces (user_id, id);

CREATE TRIGGER workspaces_set_updated_at
    BEFORE UPDATE ON workspaces
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();


CREATE OR REPLACE FUNCTION create_default_workspace()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO workspaces (user_id, name, is_default)
    VALUES (NEW.id, 'Общее пространство', TRUE);
    RETURN NEW;
END;
$$;

CREATE TRIGGER users_create_default_workspace
    AFTER INSERT ON users
    FOR EACH ROW
    EXECUTE FUNCTION create_default_workspace();


INSERT INTO workspaces (user_id, name, is_default)
SELECT id, 'Общее пространство', TRUE
FROM users u
WHERE NOT EXISTS (
    SELECT 1 FROM workspaces w WHERE w.user_id = u.id AND w.is_default
);


ALTER TABLE planner_items
    ADD COLUMN workspace_id BIGINT;

UPDATE planner_items AS item
SET workspace_id = space.id
FROM workspaces AS space
WHERE item.user_id = space.user_id
  AND space.is_default
  AND item.workspace_id IS NULL;


CREATE OR REPLACE FUNCTION assign_default_workspace()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.workspace_id IS NULL THEN
        SELECT id INTO NEW.workspace_id
        FROM workspaces
        WHERE user_id = NEW.user_id AND is_default
        LIMIT 1;
        IF NEW.workspace_id IS NULL THEN
            RAISE EXCEPTION 'У пользователя нет пространства по умолчанию'
                USING ERRCODE = '23502';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER planner_items_assign_workspace
    BEFORE INSERT ON planner_items
    FOR EACH ROW
    EXECUTE FUNCTION assign_default_workspace();


ALTER TABLE planner_items
    ADD CONSTRAINT planner_items_workspace_fk
        FOREIGN KEY (user_id, workspace_id)
        REFERENCES workspaces (user_id, id)
        ON DELETE RESTRICT;

ALTER TABLE planner_items
    ALTER COLUMN workspace_id SET NOT NULL;

CREATE INDEX planner_items_user_workspace_idx
    ON planner_items (user_id, workspace_id)
    WHERE deleted_at IS NULL;

COMMIT;
