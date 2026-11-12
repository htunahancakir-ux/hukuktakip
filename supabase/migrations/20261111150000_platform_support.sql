-- Platform console: customer support tickets. Control plane only, like the sales ledger:
-- no grants to the tenant runtime role or the browser/Data API. Tickets are written by
-- platform operators (a request that arrived by phone, WhatsApp or e-mail is recorded
-- here); offices cannot read or write this table.

CREATE TABLE han_saas.support_tickets (
  id uuid PRIMARY KEY,
  ticket_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  tenant_id uuid NOT NULL REFERENCES han_saas.tenants(id),
  subject text NOT NULL CHECK (length(trim(subject)) BETWEEN 3 AND 160),
  category text NOT NULL DEFAULT 'other'
    CHECK (category IN ('technical', 'billing', 'how_to', 'feature_request', 'other')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_customer', 'resolved', 'closed')),
  channel text NOT NULL DEFAULT 'other' CHECK (channel IN ('phone', 'email', 'whatsapp', 'portal', 'other')),
  contact_name text CHECK (contact_name IS NULL OR length(contact_name) <= 120),
  contact_info text CHECK (contact_info IS NULL OR length(contact_info) <= 160),
  assigned_to uuid REFERENCES han_saas.platform_admins(id),
  created_by uuid NOT NULL REFERENCES han_saas.platform_admins(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- First-response target, derived from the priority when the ticket is opened.
  response_due_at timestamptz NOT NULL,
  first_response_at timestamptz,
  resolved_at timestamptz,
  CHECK ((status IN ('resolved', 'closed')) = (resolved_at IS NOT NULL))
);
CREATE INDEX support_tickets_tenant_idx ON han_saas.support_tickets(tenant_id, created_at DESC);
CREATE INDEX support_tickets_open_idx ON han_saas.support_tickets(updated_at DESC)
  WHERE status IN ('open', 'waiting_customer');

-- operator: reply the customer can see; customer: what the customer said, recorded by an
-- operator; internal: operator-only note; system: status/priority/assignment audit line.
CREATE TABLE han_saas.support_messages (
  id bigserial PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES han_saas.support_tickets(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('operator', 'customer', 'internal', 'system')),
  author_id uuid REFERENCES han_saas.platform_admins(id),
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'customer') OR author_id IS NOT NULL)
);
CREATE INDEX support_messages_ticket_idx ON han_saas.support_messages(ticket_id, id);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['support_tickets', 'support_messages'] LOOP
    EXECUTE format('ALTER TABLE han_saas.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON han_saas.%I FROM PUBLIC', t);
  END LOOP;
END $$;
