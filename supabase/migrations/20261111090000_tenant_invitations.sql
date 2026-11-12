-- Single-use, expiring invitations. Only a SHA-256 hash of the token is stored, so a
-- database read cannot be turned into a working invite link. Control plane only:
-- no grants to the tenant runtime role or to the browser/Data API.
CREATE TABLE han_saas.invitations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES han_saas.tenants(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  -- Application roles. Ownership (ceo) is only ever granted at office provisioning.
  role text NOT NULL CHECK (role IN ('admin', 'staff')),
  invited_by text NOT NULL CHECK (length(trim(invited_by)) BETWEEN 1 AND 200),
  note text CHECK (note IS NULL OR length(note) <= 160),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_user_id text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL),
  CHECK ((accepted_at IS NULL) = (accepted_user_id IS NULL))
);
CREATE INDEX invitations_tenant_idx ON han_saas.invitations(tenant_id, created_at DESC);
ALTER TABLE han_saas.invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON han_saas.invitations FROM PUBLIC;
