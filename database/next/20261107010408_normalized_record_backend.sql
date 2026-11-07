-- NEXT-PHASE schema. Rehearse independently; not applied by db:migrate.
-- All tables are private. No browser/PostgREST grants or SECURITY DEFINER RPCs.
CREATE SCHEMA han_core;
REVOKE ALL ON SCHEMA han_core FROM PUBLIC;

CREATE TABLE han_core.migration_checkpoint (
  id smallint PRIMARY KEY CHECK (id = 1),
  source_revision bigint NOT NULL,
  source_payload jsonb NOT NULL,
  source_sha256 text NOT NULL CHECK (length(source_sha256) = 64),
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE han_core.personnel (
  id text PRIMARY KEY, name text NOT NULL, active boolean NOT NULL,
  extras jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE han_core.parties (
  id text PRIMARY KEY, name text NOT NULL CHECK (length(name) BETWEEN 1 AND 250),
  identity_no text UNIQUE, kind text NOT NULL DEFAULT '',
  extras jsonb NOT NULL DEFAULT '{}',
  search_vector tsvector GENERATED ALWAYS AS
    (to_tsvector('simple'::regconfig, coalesce(name,'') || ' ' || coalesce(identity_no,''))) STORED
);
CREATE INDEX parties_search_idx ON han_core.parties USING gin(search_vector);
CREATE TABLE han_core.party_contacts (
  party_id text NOT NULL REFERENCES han_core.parties(id), kind text NOT NULL, label text NOT NULL,
  value text NOT NULL, PRIMARY KEY(party_id, kind, label, value)
);
CREATE INDEX party_contact_value_idx ON han_core.party_contacts(kind, value, party_id);
CREATE TABLE han_core.clients (
  id text PRIMARY KEY, party_id text NOT NULL UNIQUE REFERENCES han_core.parties(id),
  deleted_at timestamptz, revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  extras jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX clients_live_id_idx ON han_core.clients(id) WHERE deleted_at IS NULL;
CREATE TABLE han_core.documents (
  id text PRIMARY KEY, number text NOT NULL UNIQUE, client_id text REFERENCES han_core.clients(id),
  assigned_staff_id text REFERENCES han_core.personnel(id), debtor_id text NOT NULL REFERENCES han_core.parties(id),
  kind text NOT NULL, status text NOT NULL, principal_cents bigint NOT NULL CHECK (principal_cents BETWEEN 0 AND 9007199254740991),
  interest_cents bigint NOT NULL DEFAULT 0 CHECK (interest_cents BETWEEN 0 AND 9007199254740991),
  fee_cents bigint NOT NULL DEFAULT 0 CHECK (fee_cents BETWEEN 0 AND 9007199254740991),
  discount_cents bigint NOT NULL DEFAULT 0 CHECK (discount_cents BETWEEN 0 AND 9007199254740991),
  due_on date, enforcement_number text, deleted_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0), extras jsonb NOT NULL DEFAULT '{}',
  search_vector tsvector GENERATED ALWAYS AS
    (to_tsvector('simple'::regconfig, number || ' ' || coalesce(enforcement_number,''))) STORED
);
CREATE INDEX documents_client_idx ON han_core.documents(client_id, id);
CREATE INDEX documents_debtor_idx ON han_core.documents(debtor_id, id);
CREATE INDEX documents_owner_live_idx ON han_core.documents(assigned_staff_id, id) WHERE deleted_at IS NULL;
CREATE INDEX documents_live_idx ON han_core.documents(id) WHERE deleted_at IS NULL;
CREATE INDEX documents_due_idx ON han_core.documents(due_on, id) WHERE deleted_at IS NULL;
CREATE INDEX documents_search_idx ON han_core.documents USING gin(search_vector);
CREATE TABLE han_core.conversations (
  document_id text NOT NULL REFERENCES han_core.documents(id), id text NOT NULL,
  occurred_on date NOT NULL, at_time time NOT NULL, note text NOT NULL DEFAULT '',
  result text NOT NULL, operator_id text REFERENCES han_private.han_account_index(id),
  extras jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(document_id, id)
);
CREATE INDEX conversations_timeline_idx ON han_core.conversations(document_id, occurred_on DESC, at_time DESC, id);
CREATE INDEX conversations_operator_idx ON han_core.conversations(operator_id);
CREATE TABLE han_core.document_links (
  document_id text NOT NULL REFERENCES han_core.documents(id),
  linked_id text NOT NULL REFERENCES han_core.documents(id),
  PRIMARY KEY(document_id, linked_id), CHECK (document_id <> linked_id)
);
CREATE INDEX document_links_reverse_idx ON han_core.document_links(linked_id);
CREATE TABLE han_core.document_archives (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id text NOT NULL REFERENCES han_core.documents(id), snapshot jsonb NOT NULL
);
CREATE INDEX document_archives_document_idx ON han_core.document_archives(document_id, sequence DESC);
CREATE TABLE han_core.attachments (
  id text PRIMARY KEY, document_id text REFERENCES han_core.documents(id), client_id text REFERENCES han_core.clients(id),
  name text NOT NULL, mime text NOT NULL, sha256 text NOT NULL, size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  content bytea, object_key text, extras jsonb NOT NULL DEFAULT '{}',
  CHECK ((document_id IS NOT NULL) <> (client_id IS NOT NULL)),
  CHECK ((content IS NOT NULL) <> (object_key IS NOT NULL))
);
CREATE INDEX attachments_document_idx ON han_core.attachments(document_id, id);
CREATE INDEX attachments_client_idx ON han_core.attachments(client_id, id);

CREATE TABLE han_core.accounts (
  id text PRIMARY KEY, name text NOT NULL, kind text NOT NULL, extras jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE han_core.financial_events (
  id text PRIMARY KEY, document_id text NOT NULL REFERENCES han_core.documents(id),
  account_id text REFERENCES han_core.accounts(id),
  kind text NOT NULL CHECK (kind IN ('payment', 'expense', 'costOnly')),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  occurred_on date NOT NULL, operator_id text REFERENCES han_private.han_account_index(id),
  note text NOT NULL DEFAULT '', extras jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX financial_document_idx ON han_core.financial_events(document_id, occurred_on DESC, id);
CREATE INDEX financial_account_idx ON han_core.financial_events(account_id, occurred_on DESC, id);
CREATE INDEX financial_operator_idx ON han_core.financial_events(operator_id);
CREATE TABLE han_core.ledger_entries (
  id text PRIMARY KEY, account_id text NOT NULL REFERENCES han_core.accounts(id),
  destination_id text REFERENCES han_core.accounts(id),
  document_id text REFERENCES han_core.documents(id),
  kind text NOT NULL CHECK (kind IN ('in', 'out', 'advance', 'transfer', 'clientPayout')),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  occurred_on date NOT NULL, operator_id text REFERENCES han_private.han_account_index(id),
  note text NOT NULL DEFAULT '', extras jsonb NOT NULL DEFAULT '{}',
  CHECK ((kind = 'transfer' AND destination_id IS NOT NULL AND destination_id <> account_id)
     OR (kind <> 'transfer' AND destination_id IS NULL))
);
CREATE INDEX ledger_account_idx ON han_core.ledger_entries(account_id, occurred_on DESC, id);
CREATE INDEX ledger_destination_idx ON han_core.ledger_entries(destination_id);
CREATE INDEX ledger_document_idx ON han_core.ledger_entries(document_id);
CREATE INDEX ledger_operator_idx ON han_core.ledger_entries(operator_id);

CREATE TABLE han_core.messages (
  id text PRIMARY KEY, sender_id text NOT NULL REFERENCES han_private.han_account_index(id),
  subject text NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL,
  extras jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX messages_sender_idx ON han_core.messages(sender_id, created_at DESC, id);
CREATE TABLE han_core.message_recipients (
  message_id text NOT NULL REFERENCES han_core.messages(id),
  account_id text NOT NULL REFERENCES han_private.han_account_index(id),
  read_at timestamptz, label_at_send text, PRIMARY KEY (account_id, message_id)
);
CREATE INDEX message_recipients_message_idx ON han_core.message_recipients(message_id);
CREATE INDEX message_unread_idx ON han_core.message_recipients(account_id, message_id) WHERE read_at IS NULL;
CREATE TABLE han_core.work_orders (
  id text PRIMARY KEY, assigner_id text NOT NULL REFERENCES han_private.han_account_index(id),
  assignee_id text NOT NULL REFERENCES han_private.han_account_index(id),
  title text NOT NULL, description text NOT NULL, status text NOT NULL CHECK (status IN ('pending', 'done')),
  due_on date, created_at timestamptz NOT NULL, extras jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX work_orders_assignee_idx ON han_core.work_orders(assignee_id, status, created_at DESC, id);
CREATE INDEX work_orders_assigner_idx ON han_core.work_orders(assigner_id, created_at DESC, id);
CREATE TABLE han_core.reminders (
  id text PRIMARY KEY, account_id text NOT NULL REFERENCES han_private.han_account_index(id),
  client_id text REFERENCES han_core.clients(id), document_id text REFERENCES han_core.documents(id),
  due_at timestamptz NOT NULL, note text NOT NULL, closed_at timestamptz, extras jsonb NOT NULL DEFAULT '{}',
  CHECK (client_id IS NULL OR document_id IS NULL)
);
CREATE INDEX reminders_due_idx ON han_core.reminders(account_id, due_at, id) WHERE closed_at IS NULL;
CREATE INDEX reminders_dispatch_idx ON han_core.reminders(due_at, id) WHERE closed_at IS NULL;
CREATE INDEX reminders_client_idx ON han_core.reminders(client_id);
CREATE INDEX reminders_document_idx ON han_core.reminders(document_id);
CREATE TABLE han_core.terms_releases (
  version text PRIMARY KEY, hash text NOT NULL, document jsonb NOT NULL, UNIQUE(version, hash)
);
CREATE TABLE han_core.terms_acceptances (
  account_id text NOT NULL REFERENCES han_private.han_account_index(id),
  version text NOT NULL, hash text NOT NULL, accepted_at timestamptz NOT NULL, snapshot jsonb NOT NULL,
  PRIMARY KEY(account_id, version), FOREIGN KEY(version, hash) REFERENCES han_core.terms_releases(version, hash)
);
CREATE INDEX terms_acceptances_version_idx ON han_core.terms_acceptances(version, hash);
-- Notices and consent are deliberately separate from contract acceptance.
CREATE TABLE han_core.notice_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, account_id text NOT NULL REFERENCES han_private.han_account_index(id),
  body jsonb NOT NULL
);
CREATE INDEX notice_events_account_idx ON han_core.notice_events(account_id, sequence);
CREATE TABLE han_core.consent_events (
  id text PRIMARY KEY, account_id text NOT NULL REFERENCES han_private.han_account_index(id),
  purpose text NOT NULL, granted boolean NOT NULL, recorded_at timestamptz NOT NULL, evidence jsonb NOT NULL
);
CREATE INDEX consent_events_account_idx ON han_core.consent_events(account_id, purpose, recorded_at DESC);
CREATE TABLE han_core.payroll_periods (
  month text PRIMARY KEY CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'), closed boolean NOT NULL, extras jsonb NOT NULL
);
CREATE TABLE han_core.payroll_rows (
  month text NOT NULL REFERENCES han_core.payroll_periods(month), staff_id text NOT NULL REFERENCES han_core.personnel(id),
  snapshot jsonb NOT NULL, PRIMARY KEY(month, staff_id)
);
CREATE INDEX payroll_staff_idx ON han_core.payroll_rows(staff_id, month);
CREATE TABLE han_core.daily_bonuses (
  id text PRIMARY KEY, staff_id text NOT NULL REFERENCES han_core.personnel(id),
  occurred_on date NOT NULL, amount_cents bigint NOT NULL CHECK (amount_cents > 0), extras jsonb NOT NULL
);
CREATE INDEX daily_bonus_staff_idx ON han_core.daily_bonuses(staff_id, occurred_on);
CREATE TABLE han_core.cases (
  id text PRIMARY KEY, body jsonb NOT NULL, revision bigint NOT NULL DEFAULT 1
);
CREATE TABLE han_core.settings (key text PRIMARY KEY, value jsonb NOT NULL);

-- One durable operation key per account. Reusing a key with a different payload is an error.
CREATE TABLE han_core.commands (
  actor_id text NOT NULL REFERENCES han_private.han_account_index(id), key text NOT NULL,
  request_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_id, key)
);
CREATE TABLE han_core.outbox (
  id text PRIMARY KEY, dedupe_key text NOT NULL UNIQUE, topic text NOT NULL,
  body jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','accepted','failed','unknown')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(), lease_token text, lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0, provider_id text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX outbox_pending_idx ON han_core.outbox(available_at, id) WHERE status = 'pending';
CREATE INDEX outbox_lease_idx ON han_core.outbox(lease_until) WHERE status = 'sending';

-- Protect append-only evidence and financial entries. Corrections require a new,
-- explicitly reviewed compensating operation, not in-place erasure.
CREATE FUNCTION han_core.reject_history_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Historical records are append-only' USING ERRCODE = '55000'; END $$;
REVOKE ALL ON FUNCTION han_core.reject_history_mutation() FROM PUBLIC;
CREATE TRIGGER immutable_financial BEFORE UPDATE OR DELETE ON han_core.financial_events FOR EACH ROW EXECUTE FUNCTION han_core.reject_history_mutation();
CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE ON han_core.ledger_entries FOR EACH ROW EXECUTE FUNCTION han_core.reject_history_mutation();
CREATE TRIGGER immutable_acceptances BEFORE UPDATE OR DELETE ON han_core.terms_acceptances FOR EACH ROW EXECUTE FUNCTION han_core.reject_history_mutation();
CREATE TRIGGER immutable_releases BEFORE UPDATE OR DELETE ON han_core.terms_releases FOR EACH ROW EXECUTE FUNCTION han_core.reject_history_mutation();
CREATE TRIGGER immutable_consents BEFORE UPDATE OR DELETE ON han_core.consent_events FOR EACH ROW EXECUTE FUNCTION han_core.reject_history_mutation();
CREATE TRIGGER immutable_checkpoint BEFORE UPDATE OR DELETE ON han_core.migration_checkpoint FOR EACH ROW EXECUTE FUNCTION han_core.reject_history_mutation();

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'han_core' LOOP
    EXECUTE format('ALTER TABLE han_core.%I ENABLE ROW LEVEL SECURITY', r.tablename);
    EXECUTE format('REVOKE ALL ON han_core.%I FROM PUBLIC', r.tablename);
  END LOOP;
END $$;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA han_core FROM PUBLIC;
