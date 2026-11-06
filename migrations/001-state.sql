CREATE SCHEMA IF NOT EXISTS han_private;
REVOKE ALL ON SCHEMA han_private FROM PUBLIC;
CREATE TABLE IF NOT EXISTS han_private.han_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  sessions jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE han_private.han_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON han_private.han_state FROM PUBLIC;
