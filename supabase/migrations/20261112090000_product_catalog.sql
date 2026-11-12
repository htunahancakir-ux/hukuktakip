-- Product catalog: the add-on "modules" table becomes the platform's product list.
--
-- kind     module      monthly add-on that switches a feature on (price = per month)
--          usage_pack  one-off package, e.g. 1000 SMS or 500 AI requests (price = per package)
--          service     one-off service, e.g. setup, data import, training (price = per unit)
-- status   draft → soon (announced, not sold) → selling → retired
-- monthly_price_kurus keeps its name; for packages and services it is the one-off price.
-- `active` stays for existing queries and always equals status = 'selling'.
ALTER TABLE han_saas.modules
  ADD COLUMN kind text NOT NULL DEFAULT 'module' CHECK (kind IN ('module', 'usage_pack', 'service')),
  ADD COLUMN status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'soon', 'selling', 'retired')),
  ADD COLUMN features jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(features) = 'array' AND jsonb_array_length(features) <= 12),
  ADD COLUMN trial_days smallint NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 60),
  ADD COLUMN pack_quantity integer CHECK (pack_quantity IS NULL OR pack_quantity BETWEEN 1 AND 100000000),
  ADD COLUMN pack_unit text CHECK (pack_unit IS NULL OR length(trim(pack_unit)) BETWEEN 1 AND 30),
  ADD COLUMN sort_order smallint NOT NULL DEFAULT 100 CHECK (sort_order BETWEEN 0 AND 1000),
  ADD COLUMN updated_by uuid REFERENCES han_saas.platform_admins(id),
  ADD COLUMN updated_at timestamptz;

UPDATE han_saas.modules SET status = CASE WHEN active THEN 'selling' ELSE 'draft' END;

ALTER TABLE han_saas.modules
  ADD CONSTRAINT modules_active_is_selling CHECK (active = (status = 'selling')),
  ADD CONSTRAINT modules_pack_fields CHECK ((kind = 'usage_pack') = (pack_quantity IS NOT NULL AND pack_unit IS NOT NULL)),
  ADD CONSTRAINT modules_trial_only_modules CHECK (kind = 'module' OR trial_days = 0);

-- One-off product sales in the ledger: services and usage packages, with a quantity.
ALTER TABLE han_saas.sales DROP CONSTRAINT sales_kind_check;
ALTER TABLE han_saas.sales
  ADD CONSTRAINT sales_kind_check
    CHECK (kind IN ('new_office', 'users', 'module', 'renewal', 'adjustment', 'refund', 'service', 'usage_pack')),
  ADD COLUMN quantity integer CHECK (quantity IS NULL OR quantity BETWEEN 1 AND 10000);
