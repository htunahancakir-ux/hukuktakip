-- Campaigns, coupons and free trials. Control plane only, like the rest of han_saas.
--
-- A campaign is a discount the operator applies when selling: a percentage, or an amount in
-- kuruş per month (per unit for one-off products), on chosen products ('users' = the user
-- licence fee; an empty list = everything). `applies` limits monthly discounts to the first
-- month, the first 3 months or the whole term. A coupon code is an optional handle for it.
-- Each office can use a campaign once; the discount is an `adjustment` row in the ledger that
-- carries campaign_id (and module_code), so the cost of every campaign can be read back.
CREATE TABLE han_saas.campaigns (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  product_codes text[] NOT NULL DEFAULT '{}' CHECK (cardinality(product_codes) <= 50),
  discount_type text NOT NULL CHECK (discount_type IN ('percent', 'amount')),
  discount_value bigint NOT NULL CHECK (discount_value > 0 AND discount_value <= 100000000),
  applies text NOT NULL DEFAULT 'whole_term' CHECK (applies IN ('first_month', 'first_3_months', 'whole_term')),
  audience text NOT NULL DEFAULT 'all'
    CHECK (audience IN ('all', 'new_offices', 'without_product', 'trialing', 'selected')),
  tenant_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(tenant_ids) <= 1000),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  coupon_code text UNIQUE CHECK (coupon_code IS NULL OR coupon_code ~ '^[A-Z0-9][A-Z0-9-]{2,29}$'),
  max_uses integer CHECK (max_uses IS NULL OR max_uses BETWEEN 1 AND 100000),
  used_count integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  created_by uuid NOT NULL REFERENCES han_saas.platform_admins(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (ends_at > starts_at),
  CHECK (discount_type <> 'percent' OR discount_value <= 100),
  CHECK (max_uses IS NULL OR used_count <= max_uses),
  CHECK ((audience = 'selected') = (cardinality(tenant_ids) > 0))
);

CREATE TABLE han_saas.campaign_redemptions (
  campaign_id uuid NOT NULL REFERENCES han_saas.campaigns(id),
  tenant_id uuid NOT NULL REFERENCES han_saas.tenants(id),
  discount_kurus bigint NOT NULL CHECK (discount_kurus >= 0),
  created_by uuid NOT NULL REFERENCES han_saas.platform_admins(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (campaign_id, tenant_id)
);

ALTER TABLE han_saas.sales ADD COLUMN campaign_id uuid REFERENCES han_saas.campaigns(id);
CREATE INDEX sales_campaign_idx ON han_saas.sales(campaign_id) WHERE campaign_id IS NOT NULL;

-- Free trial of a monthly module: status 'trial' until trial_until. trial_until is kept after
-- the trial ends or turns into a sale, so an office gets one trial per module.
ALTER TABLE han_saas.tenant_modules DROP CONSTRAINT tenant_modules_status_check;
ALTER TABLE han_saas.tenant_modules
  ADD CONSTRAINT tenant_modules_status_check CHECK (status IN ('active', 'trial', 'removed')),
  ADD COLUMN trial_until timestamptz,
  ADD CONSTRAINT tenant_modules_trial_has_end CHECK (status <> 'trial' OR trial_until IS NOT NULL);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['campaigns', 'campaign_redemptions'] LOOP
    EXECUTE format('ALTER TABLE han_saas.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON han_saas.%I FROM PUBLIC', t);
  END LOOP;
END $$;
