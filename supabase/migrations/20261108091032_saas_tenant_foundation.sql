-- Control-plane foundation only: existing single-office data is not tenant-safe yet.
-- No tenant is activated and no legacy data is reassigned by this migration.
CREATE SCHEMA han_saas;
REVOKE ALL ON SCHEMA han_saas FROM PUBLIC;

CREATE TABLE han_saas.tenants (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{1,61}[a-z0-9]$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 160),
  status text NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'enabled', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- user_id is the server-authenticated identity, never a role supplied by the browser.
-- Global identity migration and its FK are deliberately deferred to the next phase.
CREATE TABLE han_saas.memberships (
  tenant_id uuid NOT NULL REFERENCES han_saas.tenants(id),
  user_id text NOT NULL CHECK (length(trim(user_id)) BETWEEN 1 AND 200),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON han_saas.memberships(user_id, tenant_id)
  WHERE status = 'active';

CREATE TABLE han_saas.subscriptions (
  tenant_id uuid PRIMARY KEY REFERENCES han_saas.tenants(id),
  plan_code text NOT NULL DEFAULT 'trial' CHECK (plan_code IN ('trial', 'starter', 'professional')),
  status text NOT NULL DEFAULT 'trialing'
    CHECK (status IN ('trialing', 'active', 'past_due', 'canceled')),
  access_until timestamptz NOT NULL,
  seat_limit integer NOT NULL CHECK (seat_limit BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE han_saas.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE han_saas.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE han_saas.subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA han_saas FROM PUBLIC;
-- The browser/Data API gets no grants or permissive policies. Access is server-only.
