-- VoIP tables come from migrations/003-voip.sql, which migrate() runs before this
-- directory. On a database where tenant isolation was applied before VoIP existed,
-- give those tables the same tenant key, foreign key, RLS policy and runtime grant.
DO $$ DECLARE t text; r record; BEGIN
  FOREACH t IN ARRAY ARRAY['voip_config','voip_calls','voip_recording_access'] LOOP
    IF to_regclass('han_private.' || t) IS NULL OR EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = ('han_private.' || t)::regclass AND attname = 'tenant_id' AND NOT attisdropped
    ) THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE han_private.%I ADD COLUMN tenant_id uuid NOT NULL DEFAULT han_private.current_tenant()', t);
    FOR r IN SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = ('han_private.' || t)::regclass AND contype IN ('p','u') LOOP
      EXECUTE format('ALTER TABLE han_private.%I DROP CONSTRAINT %I', t, r.conname);
      EXECUTE format('ALTER TABLE han_private.%I ADD CONSTRAINT %I %s', t, r.conname,
        regexp_replace(r.definition, '\(', '(tenant_id, '));
    END LOOP;
    EXECUTE format('ALTER TABLE han_private.%I ADD CONSTRAINT tenant_fk FOREIGN KEY(tenant_id) REFERENCES han_saas.tenants(id)', t);
    EXECUTE format('ALTER TABLE han_private.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON han_private.%I TO han_tenant_runtime
      USING (tenant_id = nullif(current_setting(''han.tenant_id'',true),'''')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting(''han.tenant_id'',true),'''')::uuid)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON han_private.%I TO han_tenant_runtime', t);
  END LOOP;
END $$;

-- One active call per phone and per user applies within an office, not across
-- offices. The names stay the same so 003-voip.sql's IF NOT EXISTS keeps these.
DROP INDEX IF EXISTS han_private.voip_active_phone;
CREATE UNIQUE INDEX voip_active_phone ON han_private.voip_calls(tenant_id, phone)
  WHERE status IN ('starting','ringing','answered','unknown');
DROP INDEX IF EXISTS han_private.voip_active_user;
CREATE UNIQUE INDEX voip_active_user ON han_private.voip_calls(tenant_id, user_id)
  WHERE status IN ('starting','ringing','answered','unknown');
-- Call history pages are always filtered to one office by RLS.
CREATE INDEX IF NOT EXISTS voip_tenant_history ON han_private.voip_calls(tenant_id, created_at DESC, id);
