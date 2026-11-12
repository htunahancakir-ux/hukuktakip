-- Announcements shown on offices' home pages, and the sales pipeline. Control plane only:
-- offices read and write them through lib/saas/office-catalog.cjs, always filtered by the
-- office the server serves; no grants to the tenant runtime role.

-- Sales pipeline: prospective offices (new_office) and sales to existing offices (upsell).
-- Requests from an office ("Talep et", "İlgileniyorum") arrive without an operator, so
-- created_by is optional and created_label names the office user.
CREATE TABLE han_saas.prospects (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('new_office', 'upsell')),
  tenant_id uuid REFERENCES han_saas.tenants(id),
  office_name text NOT NULL CHECK (length(trim(office_name)) BETWEEN 2 AND 160),
  contact_name text CHECK (contact_name IS NULL OR length(contact_name) <= 120),
  phone text CHECK (phone IS NULL OR length(phone) <= 40),
  email text CHECK (email IS NULL OR length(email) <= 160),
  city text CHECK (city IS NULL OR length(city) <= 80),
  source text NOT NULL DEFAULT 'other'
    CHECK (source IN ('advertising', 'referral', 'web', 'announcement', 'request', 'other')),
  stage text NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'contacted', 'demo', 'offer', 'won', 'lost')),
  expected_users integer CHECK (expected_users IS NULL OR expected_users BETWEEN 1 AND 10000),
  product_codes text[] NOT NULL DEFAULT '{}' CHECK (cardinality(product_codes) <= 20),
  expected_monthly_kurus bigint NOT NULL DEFAULT 0 CHECK (expected_monthly_kurus BETWEEN 0 AND 1000000000000),
  owner_admin_id uuid REFERENCES han_saas.platform_admins(id),
  next_action_at timestamptz,
  lost_reason text CHECK (lost_reason IS NULL OR length(lost_reason) <= 300),
  won_tenant_id uuid REFERENCES han_saas.tenants(id),
  note text CHECK (note IS NULL OR length(note) <= 2000),
  created_by uuid REFERENCES han_saas.platform_admins(id),
  created_label text CHECK (created_label IS NULL OR length(created_label) <= 160),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  CHECK ((kind = 'upsell') = (tenant_id IS NOT NULL)),
  CHECK (created_by IS NOT NULL OR created_label IS NOT NULL),
  CHECK ((stage IN ('won', 'lost')) = (closed_at IS NOT NULL))
);
CREATE INDEX prospects_stage_idx ON han_saas.prospects(stage, updated_at DESC);
CREATE INDEX prospects_tenant_idx ON han_saas.prospects(tenant_id) WHERE tenant_id IS NOT NULL;
-- An office has at most one open request per product.
CREATE UNIQUE INDEX prospects_open_request_idx ON han_saas.prospects(tenant_id, (product_codes[1]))
  WHERE kind = 'upsell' AND stage NOT IN ('won', 'lost') AND source IN ('announcement', 'request');

CREATE TABLE han_saas.prospect_notes (
  id bigserial PRIMARY KEY,
  prospect_id uuid NOT NULL REFERENCES han_saas.prospects(id) ON DELETE CASCADE,
  admin_id uuid REFERENCES han_saas.platform_admins(id),
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX prospect_notes_idx ON han_saas.prospect_notes(prospect_id, id DESC);

-- Announcements: a new product, a campaign, a price change or planned maintenance. Product and
-- campaign announcements go to the office's CEO and admins only (roles = 'managers');
-- maintenance can go to everyone.
CREATE TABLE han_saas.announcements (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('new_product', 'campaign', 'price_change', 'maintenance')),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 80),
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 400),
  product_code text REFERENCES han_saas.modules(code),
  campaign_id uuid REFERENCES han_saas.campaigns(id),
  audience text NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'without_product', 'trialing', 'selected')),
  tenant_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(tenant_ids) <= 1000),
  roles text NOT NULL DEFAULT 'managers' CHECK (roles IN ('managers', 'everyone')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  dismissible boolean NOT NULL DEFAULT true,
  priority smallint NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_by uuid NOT NULL REFERENCES han_saas.platform_admins(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (ends_at > starts_at),
  CHECK ((audience = 'selected') = (cardinality(tenant_ids) > 0)),
  CHECK (audience NOT IN ('without_product', 'trialing') OR product_code IS NOT NULL),
  CHECK (kind <> 'campaign' OR campaign_id IS NOT NULL)
);
CREATE INDEX announcements_live_idx ON han_saas.announcements(starts_at, ends_at) WHERE status = 'published';

-- Per office user: when the card was first shown, clicked, closed, or "İlgileniyorum" pressed.
CREATE TABLE han_saas.announcement_views (
  announcement_id uuid NOT NULL REFERENCES han_saas.announcements(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES han_saas.tenants(id),
  user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 100),
  shown_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  clicked_at timestamptz,
  dismissed_at timestamptz,
  interested_at timestamptz,
  PRIMARY KEY (announcement_id, tenant_id, user_id)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['prospects', 'prospect_notes', 'announcements', 'announcement_views'] LOOP
    EXECUTE format('ALTER TABLE han_saas.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON han_saas.%I FROM PUBLIC', t);
  END LOOP;
END $$;
DO $$ BEGIN
  EXECUTE 'REVOKE ALL ON SEQUENCE han_saas.prospect_notes_id_seq FROM PUBLIC';
END $$;
