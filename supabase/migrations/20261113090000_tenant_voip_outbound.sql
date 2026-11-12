-- migrations/003-voip.sql (run before this directory) replaced the active-call indexes with
-- outbound-only ones. On a database where it ran before tenant isolation they cover the phone or
-- user across every office; rebuild them within one office. Later runs of 003-voip.sql keep these
-- names and, seeing the tenant key, never recreate a cross-office index.
DO $$ BEGIN
  DROP INDEX IF EXISTS han_private.voip_active_phone;
  DROP INDEX IF EXISTS han_private.voip_active_user;
  DROP INDEX IF EXISTS han_private.voip_active_outbound_phone;
  DROP INDEX IF EXISTS han_private.voip_active_outbound_user;
  CREATE UNIQUE INDEX voip_active_outbound_phone ON han_private.voip_calls(tenant_id, phone)
    WHERE status IN ('starting','ringing','answered','unknown') AND COALESCE(body->>'direction','')<>'inbound';
  CREATE UNIQUE INDEX voip_active_outbound_user ON han_private.voip_calls(tenant_id, user_id)
    WHERE status IN ('starting','ringing','answered','unknown') AND COALESCE(body->>'direction','')<>'inbound';
END $$;
