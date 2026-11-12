-- KDV (VAT) on the sales ledger and the platform expense ledger. Control plane only.
--
-- sales.amount_kurus is the amount EXCLUDING KDV. The rate is stored per sale so a later rate
-- change never rewrites history. KDV is derived per row: round(amount * vat_rate / 100),
-- half away from zero, so a refund reverses exactly the KDV of an equal sale.
ALTER TABLE han_saas.sales
  ADD COLUMN vat_rate smallint NOT NULL DEFAULT 20 CHECK (vat_rate BETWEEN 0 AND 100);

-- Costs of running and selling the product (advertising, servers, AI usage, telephony…).
-- amount_kurus is KDV-exclusive, vat_rate the deductible input KDV of the invoice. A cost can
-- be attributed to one office (for example its AI usage) to see what that office really earns.
-- Rows are voided, never deleted, like the sales ledger.
CREATE TABLE han_saas.expenses (
  id uuid PRIMARY KEY,
  spent_on date NOT NULL,
  category text NOT NULL CHECK (category IN ('advertising', 'marketing', 'server', 'ai', 'telephony', 'software', 'personnel', 'other')),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 2 AND 300),
  vendor text CHECK (vendor IS NULL OR length(vendor) <= 120),
  amount_kurus bigint NOT NULL CHECK (amount_kurus BETWEEN 1 AND 1000000000000),
  vat_rate smallint NOT NULL DEFAULT 20 CHECK (vat_rate BETWEEN 0 AND 100),
  tenant_id uuid REFERENCES han_saas.tenants(id),
  invoice_no text CHECK (invoice_no IS NULL OR length(invoice_no) BETWEEN 1 AND 60),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  created_by uuid NOT NULL REFERENCES han_saas.platform_admins(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  voided_at timestamptz,
  void_reason text CHECK (void_reason IS NULL OR length(void_reason) <= 300),
  CHECK ((status = 'void') = (voided_at IS NOT NULL))
);
CREATE INDEX expenses_month_idx ON han_saas.expenses(spent_on) WHERE status = 'active';
CREATE INDEX expenses_tenant_idx ON han_saas.expenses(tenant_id) WHERE tenant_id IS NOT NULL;

ALTER TABLE han_saas.expenses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON han_saas.expenses FROM PUBLIC;
