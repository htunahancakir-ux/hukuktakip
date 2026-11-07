-- Operational release checkpoint. Run in the same transaction as the stage-one
-- migration, with application writers paused and han_state locked first.
-- This file is deliberately outside the automatic migration directory.
CREATE TABLE IF NOT EXISTS han_private.han_release_checkpoints (
  name text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  state_revision bigint NOT NULL,
  state_payload jsonb NOT NULL,
  payload_md5 text NOT NULL,
  audit_rows jsonb NOT NULL
);
ALTER TABLE han_private.han_release_checkpoints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON han_private.han_release_checkpoints FROM PUBLIC;
INSERT INTO han_private.han_release_checkpoints
  (name, state_revision, state_payload, payload_md5, audit_rows)
SELECT 'stage1-20261107', revision, payload, md5(payload::text),
  coalesce((SELECT jsonb_agg(a ORDER BY id) FROM han_private.han_audit a), '[]'::jsonb)
FROM han_private.han_state WHERE id = 1;
