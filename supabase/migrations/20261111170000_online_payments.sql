-- Online collection of pending sales through iyzico (Checkout Form). Control plane only.
-- A payment covers the pending ledger rows listed in sale_ids at the KDV-inclusive total
-- recorded when the link was created; it is applied only if iyzico confirms exactly that amount
-- and every row is still pending, otherwise it is parked for review (never half applied).
CREATE TABLE han_saas.online_payments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES han_saas.tenants(id),
  provider text NOT NULL DEFAULT 'iyzico' CHECK (provider IN ('iyzico')),
  status text NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated', 'paid', 'failed', 'review', 'superseded')),
  amount_kurus bigint NOT NULL CHECK (amount_kurus BETWEEN 1 AND 1000000000000),
  sale_ids uuid[] NOT NULL CHECK (cardinality(sale_ids) BETWEEN 1 AND 100),
  token text UNIQUE CHECK (token IS NULL OR length(token) BETWEEN 8 AND 200),
  payment_url text CHECK (payment_url IS NULL OR length(payment_url) <= 600),
  provider_payment_id text CHECK (provider_payment_id IS NULL OR length(provider_payment_id) <= 100),
  note text CHECK (note IS NULL OR length(note) <= 300),
  created_by uuid NOT NULL REFERENCES han_saas.platform_admins(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK (status NOT IN ('paid', 'review') OR completed_at IS NOT NULL)
);
CREATE INDEX online_payments_tenant_idx ON han_saas.online_payments(tenant_id, created_at DESC);

ALTER TABLE han_saas.online_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON han_saas.online_payments FROM PUBLIC;
