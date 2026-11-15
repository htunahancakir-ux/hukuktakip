-- Platform-provided e-mail (the selling company's own Brevo account, settings in
-- han_saas.platform_settings key 'email'). Offices use it for "Şifremi unuttum" codes, e-mail
-- address verification and a password a manager sends to a locked-out user. Control plane
-- only: offices never read this table.

-- Every e-mail the platform sends, for abuse limits and the console's usage view. The address
-- is stored masked; the message text is never stored (it can contain a one-time code).
CREATE TABLE han_saas.email_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid REFERENCES han_saas.tenants(id),
  purpose text NOT NULL CHECK (purpose IN ('password_recovery', 'email_verification', 'password_delivery', 'test')),
  dest_masked text NOT NULL CHECK (length(dest_masked) <= 120),
  status text NOT NULL CHECK (status IN ('sent', 'failed', 'blocked')),
  provider_ref text CHECK (provider_ref IS NULL OR length(provider_ref) <= 200),
  error text CHECK (error IS NULL OR length(error) <= 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX email_log_tenant_idx ON han_saas.email_log(tenant_id, created_at DESC);
CREATE INDEX email_log_recent_idx ON han_saas.email_log(created_at DESC);

ALTER TABLE han_saas.email_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON han_saas.email_log FROM PUBLIC;
