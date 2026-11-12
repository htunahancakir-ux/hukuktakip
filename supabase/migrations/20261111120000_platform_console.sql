-- Platform (super admin) console: sales ledger, add-on modules, operator accounts.
-- Control plane only. No grants to the tenant runtime role or the browser/Data API.
-- All money is stored as integer kuruş (TRY) and computed on the server.

-- Pricing is per user: each office buys a user count at its own monthly unit price.
ALTER TABLE han_saas.subscriptions
  ADD COLUMN user_price_kurus bigint NOT NULL DEFAULT 0 CHECK (user_price_kurus BETWEEN 0 AND 100000000);
ALTER TABLE han_saas.subscriptions DROP CONSTRAINT subscriptions_plan_code_check;
ALTER TABLE han_saas.subscriptions
  ADD CONSTRAINT subscriptions_plan_code_check CHECK (plan_code IN ('trial', 'paid', 'starter', 'professional'));

CREATE TABLE han_saas.platform_admins (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE CHECK (username = lower(username) AND length(username) BETWEEN 1 AND 60),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  salt text NOT NULL CHECK (salt ~ '^[a-f0-9]+$'),
  hash text NOT NULL CHECK (hash ~ '^[a-f0-9]{128}$'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE han_saas.platform_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  admin_id uuid NOT NULL REFERENCES han_saas.platform_admins(id) ON DELETE CASCADE,
  expires_at bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX platform_sessions_admin_idx ON han_saas.platform_sessions(admin_id);
CREATE TABLE han_saas.platform_login_attempts (
  key text PRIMARY KEY,
  count integer NOT NULL,
  expires_at bigint NOT NULL
);

-- Add-on catalog. Prices are entered by the operator; nothing is priced by default.
CREATE TABLE han_saas.modules (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9-]{1,40}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  monthly_price_kurus bigint NOT NULL DEFAULT 0 CHECK (monthly_price_kurus BETWEEN 0 AND 100000000),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO han_saas.modules(code, name, description) VALUES
  ('voip', 'Çağrı merkezi ve kayıt', 'Santral entegrasyonu, web telefon, çağrı kaydı ve raporları'),
  ('whatsapp', 'WhatsApp Business', 'Müvekkil ve borçlulara WhatsApp mesajı gönderimi'),
  ('ai-assistant', 'Yapay zekâ asistanı', 'Görüşme özeti, öneri ve rapor üretimi'),
  ('marketing-routes', 'Pazarlama ve rota', 'Harita tabanlı potansiyel müvekkil araması ve rota planı');

-- Price per month at the time of sale: renewals keep the agreed price.
CREATE TABLE han_saas.tenant_modules (
  tenant_id uuid NOT NULL REFERENCES han_saas.tenants(id),
  module_code text NOT NULL REFERENCES han_saas.modules(code),
  price_kurus bigint NOT NULL CHECK (price_kurus BETWEEN 0 AND 100000000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  added_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  removed_at timestamptz,
  PRIMARY KEY (tenant_id, module_code),
  CHECK ((status = 'removed') = (removed_at IS NOT NULL))
);

-- Revenue ledger. Revenue is recognised when a sale is marked paid; voided rows are
-- kept for the audit trail and never deleted.
CREATE TABLE han_saas.sales (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES han_saas.tenants(id),
  kind text NOT NULL CHECK (kind IN ('new_office', 'users', 'module', 'renewal', 'adjustment', 'refund')),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  amount_kurus bigint NOT NULL CHECK (amount_kurus BETWEEN -1000000000000 AND 1000000000000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'void')),
  term_months integer CHECK (term_months BETWEEN 1 AND 36),
  user_count integer CHECK (user_count BETWEEN 1 AND 10000),
  module_code text REFERENCES han_saas.modules(code),
  invoice_no text CHECK (invoice_no IS NULL OR length(invoice_no) BETWEEN 1 AND 60),
  created_by uuid NOT NULL REFERENCES han_saas.platform_admins(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  paid_at timestamptz,
  voided_at timestamptz,
  void_reason text CHECK (void_reason IS NULL OR length(void_reason) <= 300),
  CHECK ((kind = 'refund' AND amount_kurus < 0)
      OR (kind = 'adjustment' AND amount_kurus <> 0)
      OR (kind NOT IN ('refund', 'adjustment') AND amount_kurus >= 0)),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
  CHECK ((status = 'void') = (voided_at IS NOT NULL))
);
CREATE INDEX sales_tenant_idx ON han_saas.sales(tenant_id, created_at DESC);
CREATE INDEX sales_paid_idx ON han_saas.sales(paid_at) WHERE status = 'paid';
CREATE INDEX sales_pending_idx ON han_saas.sales(created_at) WHERE status = 'pending';

CREATE TABLE han_saas.tenant_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES han_saas.tenants(id),
  admin_id uuid NOT NULL REFERENCES han_saas.platform_admins(id),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 60),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tenant_events_tenant_idx ON han_saas.tenant_events(tenant_id, id DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['platform_admins', 'platform_sessions', 'platform_login_attempts', 'modules',
    'tenant_modules', 'sales', 'tenant_events'] LOOP
    EXECUTE format('ALTER TABLE han_saas.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON han_saas.%I FROM PUBLIC', t);
  END LOOP;
END $$;
