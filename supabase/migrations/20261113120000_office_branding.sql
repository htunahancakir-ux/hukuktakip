-- What an office puts on its login screen: the picture ("login-art") and the texts placed on it
-- ("login-texts", JSON). Both are shown before sign-in, so they are not secret, but each office
-- sees and changes only its own.
CREATE TABLE IF NOT EXISTS han_private.office_branding (
  tenant_id uuid NOT NULL DEFAULT han_private.current_tenant() REFERENCES han_saas.tenants(id),
  key text NOT NULL CHECK (key IN ('login-art', 'login-texts')),
  content_type text NOT NULL
    CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/json')),
  body bytea NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 2097152),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text,
  CONSTRAINT office_branding_pkey PRIMARY KEY (tenant_id, key)
);
ALTER TABLE han_private.office_branding ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON han_private.office_branding FROM PUBLIC;
DROP POLICY IF EXISTS tenant_isolation ON han_private.office_branding;
CREATE POLICY tenant_isolation ON han_private.office_branding TO han_tenant_runtime
  USING (tenant_id = nullif(current_setting('han.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('han.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON han_private.office_branding TO han_tenant_runtime;
