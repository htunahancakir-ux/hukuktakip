-- Operator security: two-factor sign-in (TOTP), single-use recovery codes and an audit trail
-- of operator-account changes. Control plane only; office users never see these tables.

ALTER TABLE han_saas.platform_admins
  ADD COLUMN totp_secret_enc text,
  ADD COLUMN totp_pending_enc text,
  ADD COLUMN totp_enabled_at timestamptz,
  ADD COLUMN totp_last_step bigint NOT NULL DEFAULT 0,
  ADD COLUMN recovery_hashes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN password_changed_at timestamptz,
  ADD CONSTRAINT platform_admins_totp_consistent
    CHECK ((totp_secret_enc IS NULL) = (totp_enabled_at IS NULL));

CREATE TABLE han_saas.platform_audit (
  id bigserial PRIMARY KEY,
  admin_id uuid NOT NULL REFERENCES han_saas.platform_admins(id),
  action text NOT NULL CHECK (action ~ '^[a-z_.]{3,60}$'),
  target text CHECK (target IS NULL OR length(target) <= 120),
  detail text CHECK (detail IS NULL OR length(detail) <= 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX platform_audit_recent_idx ON han_saas.platform_audit(id DESC);

ALTER TABLE han_saas.platform_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON han_saas.platform_audit FROM PUBLIC;
