-- Usage cost and profitability. Control plane only.

-- Daily AI usage per office (requests and tokens), written by lib/saas/usage-meter.cjs.
-- SMS and telephone usage are read from han_saas.sms_log and han_private.voip_calls.
CREATE TABLE han_saas.usage_daily (
  tenant_id uuid NOT NULL REFERENCES han_saas.tenants(id),
  day date NOT NULL,
  metric text NOT NULL CHECK (metric IN ('ai_requests', 'ai_input_tokens', 'ai_output_tokens')),
  quantity bigint NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  PRIMARY KEY (tenant_id, day, metric)
);

-- Expenses that repeat every month (server, software, salaries…). Entered once; the month's
-- expense row is written on `day_of_month` (1–28) from starts_on until ends_on.
CREATE TABLE han_saas.recurring_expenses (
  id uuid PRIMARY KEY,
  category text NOT NULL
    CHECK (category IN ('advertising', 'marketing', 'server', 'ai', 'telephony', 'software', 'personnel', 'other')),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 2 AND 300),
  vendor text CHECK (vendor IS NULL OR length(vendor) <= 120),
  amount_kurus bigint NOT NULL CHECK (amount_kurus BETWEEN 1 AND 1000000000000),
  vat_rate smallint NOT NULL DEFAULT 20 CHECK (vat_rate BETWEEN 0 AND 100),
  tenant_id uuid REFERENCES han_saas.tenants(id),
  module_code text REFERENCES han_saas.modules(code),
  day_of_month smallint NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
  starts_on date NOT NULL,
  ends_on date,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES han_saas.platform_admins(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

-- An expense can belong to a product (cost of that product) and come from a recurring entry
-- (one row per month at most).
ALTER TABLE han_saas.expenses
  ADD COLUMN module_code text REFERENCES han_saas.modules(code),
  ADD COLUMN recurring_id uuid REFERENCES han_saas.recurring_expenses(id),
  ADD COLUMN period text CHECK (period IS NULL OR period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  ADD CONSTRAINT expenses_recurring_period CHECK ((recurring_id IS NULL) = (period IS NULL));
CREATE UNIQUE INDEX expenses_recurring_once ON han_saas.expenses(recurring_id, period) WHERE recurring_id IS NOT NULL;

-- A renewal is one ledger row for users and modules together; `breakdown` keeps what each
-- product contributed ([{ "code": "users" | <module>, "amount": kuruş }]) for per-product profit.
ALTER TABLE han_saas.sales
  ADD COLUMN breakdown jsonb CHECK (breakdown IS NULL OR jsonb_typeof(breakdown) = 'array');

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['usage_daily', 'recurring_expenses'] LOOP
    EXECUTE format('ALTER TABLE han_saas.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON han_saas.%I FROM PUBLIC', t);
  END LOOP;
END $$;
