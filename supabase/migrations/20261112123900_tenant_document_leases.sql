-- Folio edit leases (main's 20261112123931_document_leases.sql) belong to one office.
-- On a database where tenant isolation ran first, create the table here with the tenant key,
-- so main's CREATE TABLE IF NOT EXISTS keeps this shape. Where the table already existed when
-- tenant isolation ran, that migration already converted it and this one does nothing.
-- Leases are short-lived edit locks; nothing in them needs to be preserved.
DO $$ BEGIN
  IF to_regclass('han_private.document_leases') IS NULL THEN
    CREATE TABLE han_private.document_leases (
      tenant_id uuid NOT NULL DEFAULT han_private.current_tenant() REFERENCES han_saas.tenants(id),
      document_id text NOT NULL,
      account_id text NOT NULL,
      session_hash text NOT NULL,
      view_id text NOT NULL,
      expires_at bigint NOT NULL,
      CONSTRAINT document_leases_pkey PRIMARY KEY (tenant_id, document_id),
      CONSTRAINT document_leases_document_id_fkey FOREIGN KEY (tenant_id, document_id)
        REFERENCES han_data.documents(tenant_id, id) ON DELETE CASCADE
    );
    ALTER TABLE han_private.document_leases ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON han_private.document_leases FROM PUBLIC;
    CREATE POLICY tenant_isolation ON han_private.document_leases TO han_tenant_runtime
      USING (tenant_id = nullif(current_setting('han.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('han.tenant_id', true), '')::uuid);
    GRANT SELECT, INSERT, UPDATE, DELETE ON han_private.document_leases TO han_tenant_runtime;
  END IF;
END $$;
