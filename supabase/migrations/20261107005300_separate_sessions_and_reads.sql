-- Additive migration. The original payload and legacy security columns are retained.
-- Run with the application writer stopped, then deploy the matching backend.
CREATE TABLE han_private.han_account_index (
  id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  enabled boolean NOT NULL,
  terms_required boolean NOT NULL
);
CREATE TABLE han_private.han_sessions (
  token_hash text PRIMARY KEY,
  account_id text NOT NULL REFERENCES han_private.han_account_index(id) ON DELETE CASCADE,
  device_type text CHECK (device_type IN ('desktop', 'mobile')),
  expires_at bigint NOT NULL,
  seen_at bigint,
  UNIQUE (account_id, device_type)
);
CREATE INDEX han_sessions_expiry_idx ON han_private.han_sessions(expires_at);
CREATE INDEX han_sessions_seen_idx ON han_private.han_sessions(seen_at DESC);
CREATE TABLE han_private.han_login_attempts (
  key text PRIMARY KEY,
  count integer NOT NULL CHECK (count >= 0),
  expires_at bigint NOT NULL
);
CREATE INDEX han_login_attempts_expiry_idx ON han_private.han_login_attempts(expires_at);
CREATE TABLE han_private.han_activity (
  id smallint PRIMARY KEY CHECK (id = 1),
  body jsonb NOT NULL
);
CREATE TABLE han_private.han_jobs (
  name text PRIMARY KEY,
  next_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_success_at timestamptz
);
INSERT INTO han_private.han_jobs(name) VALUES ('workspace-maintenance');

ALTER TABLE han_private.han_account_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE han_private.han_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE han_private.han_login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE han_private.han_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE han_private.han_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON han_private.han_account_index, han_private.han_sessions,
  han_private.han_login_attempts, han_private.han_activity, han_private.han_jobs FROM PUBLIC;

-- Read models, not additional sources of truth. Import/restore/legacy writes all
-- update them in the SAME transaction, even if the application does not call a hook.
CREATE FUNCTION han_private.refresh_access_index(source jsonb) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, han_private AS $$
BEGIN
  INSERT INTO han_private.han_account_index(id, username, body, enabled, terms_required)
  SELECT u->>'id', u->>'username', u,
    coalesce((u->>'active')::boolean, false) AND
      (coalesce(u->>'staffId', '') = '' OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(coalesce(source#>'{data,icrapro-personnel-v1}', '[]')) p
        WHERE p->>'id' = u->>'staffId' AND coalesce((p->>'active')::boolean, true))),
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(coalesce(source#>'{employeeTerms,releases}', '[]')) r
      WHERE r->>'version' = source#>>'{employeeTerms,activeVersion}' AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(coalesce(source#>'{employeeTerms,acceptances}', '[]')) a
        WHERE a->>'accountId' = u->>'id' AND a->>'version' = r->>'version' AND a->>'hash' = r->>'hash'))
  FROM jsonb_array_elements(source->'users') u ORDER BY u->>'id'
  ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, body = EXCLUDED.body,
    enabled = EXCLUDED.enabled, terms_required = EXCLUDED.terms_required
  WHERE (han_account_index.username, han_account_index.body, han_account_index.enabled, han_account_index.terms_required)
    IS DISTINCT FROM (EXCLUDED.username, EXCLUDED.body, EXCLUDED.enabled, EXCLUDED.terms_required);
  DELETE FROM han_private.han_account_index
    WHERE id NOT IN (SELECT u->>'id' FROM jsonb_array_elements(source->'users') u);
  INSERT INTO han_private.han_activity(id, body)
  VALUES (1, jsonb_build_object(
    'messages', coalesce(source->'messages', '[]'),
    'workOrders', coalesce(source->'workOrders', '[]'),
    'workflowNotices', coalesce(source->'workflowNotices', '[]'),
    'scheduledReminders', coalesce(source->'scheduledReminders', '[]'),
    'collectionNotices', coalesce(source->'collectionNotices', '[]'),
    'collectionNoticeSequence', coalesce(source->'collectionNoticeSequence', '0')))
  ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body WHERE han_activity.body IS DISTINCT FROM EXCLUDED.body;
END $$;
REVOKE ALL ON FUNCTION han_private.refresh_access_index(jsonb) FROM PUBLIC;

CREATE FUNCTION han_private.sync_access_index() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, han_private AS $$
BEGIN
  PERFORM han_private.refresh_access_index(NEW.payload);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION han_private.sync_access_index() FROM PUBLIC;
CREATE TRIGGER han_state_access_insert AFTER INSERT ON han_private.han_state
  FOR EACH ROW EXECUTE FUNCTION han_private.sync_access_index();
CREATE TRIGGER han_state_access_update AFTER UPDATE OF payload ON han_private.han_state
  FOR EACH ROW WHEN (OLD.payload IS DISTINCT FROM NEW.payload) EXECUTE FUNCTION han_private.sync_access_index();

SELECT han_private.refresh_access_index(payload) FROM han_private.han_state WHERE id = 1;
-- Legacy sessions lack the new device classification and intentionally require re-login.
INSERT INTO han_private.han_sessions(token_hash, account_id, device_type, expires_at, seen_at)
SELECT s.key, s.value->>'id', null, (s.value->>'until')::bigint,
  CASE WHEN s.value->>'seenAt' ~ '^[0-9]{1,15}$' THEN (s.value->>'seenAt')::bigint END
FROM han_private.han_state st CROSS JOIN LATERAL jsonb_each(st.sessions) s
JOIN han_private.han_account_index a ON a.id = s.value->>'id'
WHERE s.value->>'until' ~ '^[0-9]{1,15}$';
INSERT INTO han_private.han_login_attempts(key, count, expires_at)
SELECT a.key, (a.value->>'count')::integer, (a.value->>'until')::bigint
FROM han_private.han_state st CROSS JOIN LATERAL jsonb_each(st.attempts) a
WHERE a.value->>'count' ~ '^[0-9]{1,8}$' AND a.value->>'until' ~ '^[0-9]{1,15}$';

CREATE INDEX han_audit_category_time_idx ON han_private.han_audit(category, occurred_at DESC);
