CREATE TABLE IF NOT EXISTS han_private.voip_config (
  id integer PRIMARY KEY CHECK (id=1), body jsonb NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO han_private.voip_config(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS han_private.voip_calls (
  id text PRIMARY KEY,
  document_id text NOT NULL, phone text NOT NULL, user_id text NOT NULL,
  request_id text NOT NULL, created_at timestamptz NOT NULL,
  status text NOT NULL, body jsonb NOT NULL,
  search_text text NOT NULL,
  UNIQUE(user_id,request_id)
);
CREATE INDEX IF NOT EXISTS voip_phone_history ON han_private.voip_calls(phone,created_at DESC);
CREATE INDEX IF NOT EXISTS voip_document_history ON han_private.voip_calls(document_id,created_at DESC);
CREATE INDEX IF NOT EXISTS voip_history ON han_private.voip_calls(created_at DESC,id);
CREATE INDEX IF NOT EXISTS voip_transcription_pending ON han_private.voip_calls(created_at,id) WHERE body->'transcription'->>'status' IN ('queued','processing');
CREATE INDEX IF NOT EXISTS voip_status_history ON han_private.voip_calls(status,created_at DESC,id);
CREATE INDEX IF NOT EXISTS voip_result_history ON han_private.voip_calls((body->>'result'),created_at DESC,id);
-- One active call per number and per user applies to calls the office dials. Calls from outside
-- (direction 'inbound') are recorded as they happen and never block or collide with dialing.
DROP INDEX IF EXISTS han_private.voip_active_phone;
DROP INDEX IF EXISTS han_private.voip_active_user;
CREATE UNIQUE INDEX IF NOT EXISTS voip_active_outbound_phone ON han_private.voip_calls(phone)
  WHERE status IN ('starting','ringing','answered','unknown') AND COALESCE(body->>'direction','')<>'inbound';
CREATE UNIQUE INDEX IF NOT EXISTS voip_active_outbound_user ON han_private.voip_calls(user_id)
  WHERE status IN ('starting','ringing','answered','unknown') AND COALESCE(body->>'direction','')<>'inbound';
CREATE INDEX IF NOT EXISTS voip_inbound_history ON han_private.voip_calls(created_at DESC)
  WHERE body->>'direction'='inbound';
CREATE INDEX IF NOT EXISTS voip_provider_call ON han_private.voip_calls((body->>'providerId'));
CREATE INDEX IF NOT EXISTS voip_archive_pending ON han_private.voip_calls(created_at)
  WHERE body->>'archivedAt' IS NULL AND body->>'recordingMissing' IS NULL AND (body->>'recordingPresent'='true' OR status='completed');
REVOKE ALL ON han_private.voip_calls, han_private.voip_config FROM PUBLIC;
CREATE TABLE IF NOT EXISTS han_private.voip_recording_access (
  user_id text PRIMARY KEY, body jsonb NOT NULL
);
REVOKE ALL ON han_private.voip_recording_access FROM PUBLIC;
-- Last check-in of each user's always-connected web phone; decides who can take a call now.
CREATE TABLE IF NOT EXISTS han_private.voip_presence (
  user_id text PRIMARY KEY, seen_at timestamptz NOT NULL
);
REVOKE ALL ON han_private.voip_presence FROM PUBLIC;
ALTER TABLE han_private.voip_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE han_private.voip_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE han_private.voip_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE han_private.voip_recording_access ENABLE ROW LEVEL SECURITY;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
DO $$ DECLARE extension_schema text; BEGIN
  SELECT n.nspname INTO extension_schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm';
  EXECUTE format('CREATE INDEX IF NOT EXISTS voip_search_idx ON han_private.voip_calls USING gin(search_text %I.gin_trgm_ops)',extension_schema);
END $$;
