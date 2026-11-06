CREATE TABLE IF NOT EXISTS han_private.han_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  category text NOT NULL CHECK (category IN ('changes', 'login', 'logout', 'failed')),
  action text NOT NULL,
  area text NOT NULL,
  actor_id text,
  actor_name text,
  actor_username text,
  record_ref text,
  fields text[] NOT NULL DEFAULT '{}'
);

ALTER TABLE han_private.han_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON han_private.han_audit FROM PUBLIC;
CREATE INDEX IF NOT EXISTS han_audit_category_id_idx ON han_private.han_audit (category, id DESC);
