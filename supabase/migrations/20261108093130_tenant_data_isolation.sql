-- Requires a maintenance window and the matching backend. Test on a clone first.
-- Historical records belong only to the explicitly named legacy office.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class source ON source.oid=c.conrelid
    JOIN pg_class target ON target.oid=c.confrelid
    WHERE c.contype='f'
      AND target.relnamespace IN ('han_private'::regnamespace,'han_data'::regnamespace)
      AND source.relnamespace NOT IN ('han_private'::regnamespace,'han_data'::regnamespace)
  ) THEN
    RAISE EXCEPTION 'External foreign keys require a separate tenant migration plan (including experimental han_core)';
  END IF;
END $$;
INSERT INTO han_saas.tenants(id, slug, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'existing-office', 'Mevcut Büro');

CREATE FUNCTION han_private.current_tenant() RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT coalesce(nullif(current_setting('han.tenant_id', true), ''),
    '00000000-0000-0000-0000-000000000001')::uuid
$$;
REVOKE ALL ON FUNCTION han_private.current_tenant() FROM PUBLIC;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='han_tenant_runtime') THEN
    CREATE ROLE han_tenant_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='han_tenant_runtime' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'han_tenant_runtime must be a restricted NOLOGIN role';
  END IF;
  EXECUTE format('GRANT han_tenant_runtime TO %I', current_user);
END $$;

CREATE TEMP TABLE tenant_keys ON COMMIT DROP AS
SELECT c.conrelid::regclass::text AS tbl, c.conname AS name, c.contype AS kind,
       pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
WHERE r.relnamespace IN ('han_private'::regnamespace, 'han_data'::regnamespace)
  AND r.relname <> 'han_migrations' AND c.contype IN ('p','u','f');

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT oid::regclass AS tbl FROM pg_class
    WHERE relnamespace IN ('han_private'::regnamespace, 'han_data'::regnamespace)
      AND relkind='r' AND relname<>'han_migrations' LOOP
    EXECUTE format('ALTER TABLE %s ADD COLUMN tenant_id uuid NOT NULL DEFAULT han_private.current_tenant()', r.tbl);
  END LOOP;
  FOR r IN SELECT * FROM tenant_keys WHERE kind='f' LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',r.tbl,r.name);
  END LOOP;
  FOR r IN SELECT * FROM tenant_keys WHERE kind IN ('p','u') LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',r.tbl,r.name);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',r.tbl,r.name,
      regexp_replace(r.definition, '\(', '(tenant_id, '));
  END LOOP;
  FOR r IN SELECT * FROM tenant_keys WHERE kind='f' LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',r.tbl,r.name,
      regexp_replace(replace(r.definition,'FOREIGN KEY (','FOREIGN KEY (tenant_id, '),
        '(REFERENCES [^(]+)\(', '\1(tenant_id, '));
  END LOOP;
  FOR r IN SELECT oid::regclass AS tbl FROM pg_class
    WHERE relnamespace IN ('han_private'::regnamespace, 'han_data'::regnamespace)
      AND relkind='r' AND relname<>'han_migrations' LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT tenant_fk FOREIGN KEY(tenant_id) REFERENCES han_saas.tenants(id)',r.tbl);
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',r.tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s TO han_tenant_runtime
      USING (tenant_id = nullif(current_setting(''han.tenant_id'',true),'''')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting(''han.tenant_id'',true),'''')::uuid)',r.tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO han_tenant_runtime',r.tbl);
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA han_private, han_data TO han_tenant_runtime;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA han_private, han_data TO han_tenant_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA han_private, han_data TO han_tenant_runtime;
CREATE OR REPLACE FUNCTION han_data.guard_legacy_write() RETURNS trigger LANGUAGE plpgsql
SECURITY INVOKER SET search_path=pg_catalog,han_data AS $$
BEGIN
  PERFORM id FROM han_data.control WHERE tenant_id=NEW.tenant_id AND id=1 FOR SHARE;
  IF EXISTS(SELECT 1 FROM han_data.control WHERE tenant_id=NEW.tenant_id AND id=1 AND mode='active') THEN
    RAISE EXCEPTION 'Record store is active; legacy writes are disabled' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
-- No TRUNCATE, schema creation, migration/control-plane access, or RLS bypass.

CREATE OR REPLACE FUNCTION han_private.refresh_access_index(source jsonb) RETURNS void
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
  ON CONFLICT (tenant_id, id) DO UPDATE SET username = EXCLUDED.username, body = EXCLUDED.body,
    enabled = EXCLUDED.enabled, terms_required = EXCLUDED.terms_required
  WHERE (han_account_index.username, han_account_index.body, han_account_index.enabled, han_account_index.terms_required)
    IS DISTINCT FROM (EXCLUDED.username, EXCLUDED.body, EXCLUDED.enabled, EXCLUDED.terms_required);
  DELETE FROM han_private.han_account_index
    WHERE tenant_id=han_private.current_tenant() AND id NOT IN (SELECT u->>'id' FROM jsonb_array_elements(source->'users') u);
  INSERT INTO han_private.han_activity(id, body)
  VALUES (1, jsonb_build_object(
    'messages', coalesce(source->'messages', '[]'),
    'workOrders', coalesce(source->'workOrders', '[]'),
    'workflowNotices', coalesce(source->'workflowNotices', '[]'),
    'scheduledReminders', coalesce(source->'scheduledReminders', '[]'),
    'collectionNotices', coalesce(source->'collectionNotices', '[]'),
    'collectionNoticeSequence', coalesce(source->'collectionNoticeSequence', '0')))
  ON CONFLICT (tenant_id, id) DO UPDATE SET body = EXCLUDED.body WHERE han_activity.body IS DISTINCT FROM EXCLUDED.body;
END $$;
REVOKE ALL ON FUNCTION han_private.refresh_access_index(jsonb) FROM PUBLIC;

-- Administrative imports can explicitly name a tenant too. The row, rather
-- than a stale connection setting, determines its derived security index.
CREATE OR REPLACE FUNCTION han_private.sync_access_index() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,han_private AS $$
DECLARE previous_tenant text;
BEGIN
  previous_tenant := current_setting('han.tenant_id', true);
  PERFORM set_config('han.tenant_id', NEW.tenant_id::text, true);
  PERFORM han_private.refresh_access_index(NEW.payload);
  PERFORM set_config('han.tenant_id', coalesce(previous_tenant,''), true);
  RETURN NEW;
END $$;


CREATE OR REPLACE FUNCTION han_data.track_document_number() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,han_data AS $$
DECLARE n text;
BEGIN
  FOR n IN SELECT upper(translate(value,'iı','İI')) FROM jsonb_array_elements_text(
    CASE WHEN TG_TABLE_NAME='metadata' THEN coalesce(NEW.body#>'{data,icrapro-v1,archivedNumbers}','[]'::jsonb)
      ELSE jsonb_build_array(NEW.body->>'number') END
  ) AS numbers(value) LOOP
  IF n ~ '^[^-]+-[0-9]{1,18}$' THEN
    INSERT INTO han_data.document_sequences(tenant_id,prefix,last_value)
    VALUES (NEW.tenant_id,split_part(n,'-',1),split_part(n,'-',2)::bigint)
    ON CONFLICT(tenant_id,prefix) DO UPDATE SET last_value=greatest(document_sequences.last_value,excluded.last_value);
  END IF;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION han_data.track_document_number() FROM PUBLIC;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA han_private, han_data TO han_tenant_runtime;
