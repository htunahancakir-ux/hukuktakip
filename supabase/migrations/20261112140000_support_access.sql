-- Remote support access. An office's CEO or admin lets the platform's support team into the
-- office for 15, 30 or 60 minutes, counted from the moment an operator first connects. The
-- operator may add 15 minutes once on their own; anything more is asked of the office, which
-- approves or refuses. Control plane only, like the support desk itself.
CREATE TABLE han_saas.support_access (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES han_saas.tenants(id),
  ticket_id uuid NOT NULL REFERENCES han_saas.support_tickets(id),
  granted_by_user text NOT NULL CHECK (length(granted_by_user) BETWEEN 1 AND 100),
  granted_by_label text NOT NULL CHECK (length(granted_by_label) BETWEEN 1 AND 160),
  allow_edit boolean NOT NULL DEFAULT false,
  minutes smallint NOT NULL CHECK (minutes IN (15, 30, 60)),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'ended', 'revoked', 'expired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Not connected by then: the grant lapses.
  offer_until timestamptz NOT NULL,
  started_at timestamptz,
  deadline timestamptz,
  connected_admin_id uuid REFERENCES han_saas.platform_admins(id),
  self_extended boolean NOT NULL DEFAULT false,
  extension_requested_minutes smallint CHECK (extension_requested_minutes IS NULL OR extension_requested_minutes IN (15, 30, 60)),
  extension_requested_at timestamptz,
  extension_note text CHECK (extension_note IS NULL OR length(extension_note) <= 300),
  ended_at timestamptz,
  ended_by_label text CHECK (ended_by_label IS NULL OR length(ended_by_label) <= 160),
  -- Waiting grants have not started; connected ones have. A lapsed offer never started.
  CHECK (status <> 'pending' OR started_at IS NULL),
  CHECK (status <> 'active' OR started_at IS NOT NULL),
  CHECK ((started_at IS NULL) = (deadline IS NULL)),
  CHECK ((status IN ('ended', 'revoked', 'expired')) = (ended_at IS NOT NULL))
);
-- One open grant per office at a time.
CREATE UNIQUE INDEX support_access_open_idx ON han_saas.support_access(tenant_id) WHERE status IN ('pending', 'active');
CREATE INDEX support_access_ticket_idx ON han_saas.support_access(ticket_id, created_at DESC);

-- One-time entry codes: the console opens <office>/api/support-access/enter?code=… in a new
-- tab. Only the SHA-256 of the code is kept; a code lives 2 minutes and works once.
CREATE TABLE han_saas.support_access_codes (
  code_hash text PRIMARY KEY CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  access_id uuid NOT NULL REFERENCES han_saas.support_access(id),
  admin_id uuid NOT NULL REFERENCES han_saas.platform_admins(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

-- Access events are system lines on the ticket; those decided in the office (granted, extension
-- approved, ended) have no operator author, only the office user's name.
ALTER TABLE han_saas.support_messages DROP CONSTRAINT support_messages_check;
ALTER TABLE han_saas.support_messages
  ADD CONSTRAINT support_messages_check CHECK (kind = 'customer' OR author_id IS NOT NULL OR (kind = 'system' AND author_label IS NOT NULL));

-- Office staff may open tickets too; they see only their own.
ALTER TABLE han_saas.support_tickets
  ADD COLUMN opened_by_user text CHECK (opened_by_user IS NULL OR length(opened_by_user) <= 100);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['support_access', 'support_access_codes'] LOOP
    EXECUTE format('ALTER TABLE han_saas.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON han_saas.%I FROM PUBLIC', t);
  END LOOP;
END $$;
