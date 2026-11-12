-- Platform-provided SMS (the selling company's own Verimor account). Offices use it for
-- critical messages such as password recovery until they set up their own WhatsApp
-- integration. Control plane only: offices never read these tables.

-- Platform-wide settings, one row per key. Secrets inside `value` are sealed by the server.
CREATE TABLE han_saas.platform_settings (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  value jsonb NOT NULL,
  updated_by uuid REFERENCES han_saas.platform_admins(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Every SMS the platform sends, for cost tracking and abuse limits. The number is stored
-- masked; the message text is never stored (it can contain a one-time password).
CREATE TABLE han_saas.sms_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid REFERENCES han_saas.tenants(id),
  purpose text NOT NULL CHECK (purpose IN ('password_recovery', 'operator_reset', 'test')),
  dest_masked text NOT NULL CHECK (length(dest_masked) <= 20),
  status text NOT NULL CHECK (status IN ('sent', 'failed', 'blocked')),
  provider_ref text CHECK (provider_ref IS NULL OR length(provider_ref) <= 64),
  error text CHECK (error IS NULL OR length(error) <= 200),
  segments smallint NOT NULL DEFAULT 1 CHECK (segments BETWEEN 0 AND 10),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX sms_log_tenant_idx ON han_saas.sms_log(tenant_id, created_at DESC);
CREATE INDEX sms_log_recent_idx ON han_saas.sms_log(created_at DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['platform_settings', 'sms_log'] LOOP
    EXECUTE format('ALTER TABLE han_saas.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON han_saas.%I FROM PUBLIC', t);
  END LOOP;
END $$;
