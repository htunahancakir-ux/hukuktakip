-- Additive preparation only. No live state is changed or switched by this migration.
CREATE SCHEMA han_data;
REVOKE ALL ON SCHEMA han_data FROM PUBLIC;
CREATE TABLE han_data.control (
  id smallint PRIMARY KEY CHECK (id = 1),
  mode text NOT NULL CHECK (mode IN ('shadow','active')),
  source_revision bigint NOT NULL,
  source_digest text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE han_data.metadata (
  id smallint PRIMARY KEY CHECK (id = 1), body jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1
);
-- Core values have typed/indexed columns. Per-record body preserves legacy and
-- document-type-specific fields without flattening unrelated records together.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['clients','documents','personnel','accounts','financial_events',
    'ledger_entries','cases','messages','work_orders','reminders','document_archives',
    'operation_archives','daily_bonuses','staff_breaks','workflow_notices','collection_notices',
    'conversations','attachments'] LOOP
    EXECUTE format('CREATE TABLE han_data.%I (
      id text PRIMARY KEY, body jsonb NOT NULL CHECK (jsonb_typeof(body) = ''object''),
      ordinal bigint NOT NULL, revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
      active boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp())', t);
    EXECUTE format('ALTER TABLE han_data.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON han_data.%I FROM PUBLIC',t);
  END LOOP;
END $$;
ALTER TABLE han_data.control ENABLE ROW LEVEL SECURITY;
ALTER TABLE han_data.metadata ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA han_data FROM PUBLIC;

ALTER TABLE han_data.clients ADD COLUMN name text GENERATED ALWAYS AS (body->>'name') STORED;
ALTER TABLE han_data.documents
  ADD COLUMN client_id text GENERATED ALWAYS AS (nullif(coalesce(body->>'client',body->>'clientId'),'')) STORED,
  ADD COLUMN staff_id text GENERATED ALWAYS AS (nullif(body->>'relatedStaff','')) STORED,
  ADD COLUMN number text GENERATED ALWAYS AS (body->>'number') STORED,
  ADD COLUMN status text GENERATED ALWAYS AS (CASE WHEN body->>'status' IN ('Derdest','İnfaz','İade','İcra') THEN body->>'status' ELSE 'Derdest' END) STORED,
  ADD COLUMN kind text GENERATED ALWAYS AS (CASE WHEN body->>'docType' IN ('Senet','Çek','Sözleşme','Cari Ekstre','Yediemin Park Ücreti','İlam','Fatura','Diğer') THEN body->>'docType' ELSE 'Senet' END) STORED,
  ADD COLUMN due_on text GENERATED ALWAYS AS (body->>'due') STORED,
  ADD COLUMN tracking_on text GENERATED ALWAYS AS (coalesce(body->>'trackingDate',left(body->>'created',10))) STORED,
  ADD CONSTRAINT documents_client_fk FOREIGN KEY (client_id) REFERENCES han_data.clients(id) DEFERRABLE INITIALLY DEFERRED;
-- Historical and archived files may share a display number. The immutable id is
-- the identity; importing records must never rename or discard existing numbers.
CREATE INDEX documents_number_idx ON han_data.documents(number) WHERE number IS NOT NULL;
CREATE INDEX documents_client_idx ON han_data.documents(client_id,id) WHERE active;
CREATE INDEX documents_status_idx ON han_data.documents(status,id) WHERE active;
CREATE INDEX documents_staff_idx ON han_data.documents(staff_id,status,id) WHERE active;
CREATE INDEX documents_due_idx ON han_data.documents(due_on,id) WHERE active;
CREATE INDEX documents_tracking_idx ON han_data.documents(tracking_on,id) WHERE active;
CREATE INDEX documents_order_idx ON han_data.documents(ordinal,id) WHERE active;
CREATE INDEX clients_name_idx ON han_data.clients(name,id) WHERE active;

ALTER TABLE han_data.financial_events
  ADD COLUMN document_id text GENERATED ALWAYS AS (body->>'documentId') STORED,
  ADD COLUMN account_id text GENERATED ALWAYS AS (nullif(body->>'accountId','')) STORED,
  ADD COLUMN kind text GENERATED ALWAYS AS (body->>'type') STORED,
  ADD COLUMN amount_cents bigint GENERATED ALWAYS AS ((body->>'amount')::bigint) STORED,
  ADD COLUMN occurred_on text GENERATED ALWAYS AS (body->>'date') STORED,
  ADD CONSTRAINT finance_document_fk FOREIGN KEY(document_id) REFERENCES han_data.documents(id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT finance_account_fk FOREIGN KEY(account_id) REFERENCES han_data.accounts(id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX finance_document_idx ON han_data.financial_events(document_id,kind,id) WHERE active;
CREATE INDEX finance_account_date_idx ON han_data.financial_events(account_id,occurred_on,id) WHERE active;
CREATE INDEX finance_date_idx ON han_data.financial_events(occurred_on,id) WHERE active;
ALTER TABLE han_data.ledger_entries
  ADD COLUMN document_id text GENERATED ALWAYS AS (nullif(body->>'documentId','')) STORED,
  ADD COLUMN account_id text GENERATED ALWAYS AS (nullif(body->>'accountId','')) STORED,
  ADD COLUMN kind text GENERATED ALWAYS AS (body->>'type') STORED,
  ADD COLUMN amount_cents bigint GENERATED ALWAYS AS ((body->>'amount')::bigint) STORED,
  ADD COLUMN occurred_on text GENERATED ALWAYS AS (body->>'date') STORED,
  ADD CONSTRAINT ledger_account_fk FOREIGN KEY(account_id) REFERENCES han_data.accounts(id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT ledger_document_fk FOREIGN KEY(document_id) REFERENCES han_data.documents(id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX ledger_document_idx ON han_data.ledger_entries(document_id,id) WHERE active;
CREATE INDEX ledger_account_date_idx ON han_data.ledger_entries(account_id,occurred_on,id) WHERE active;
CREATE INDEX ledger_date_idx ON han_data.ledger_entries(occurred_on,id) WHERE active;
ALTER TABLE han_data.conversations
  ADD COLUMN document_id text GENERATED ALWAYS AS (body->>'documentId') STORED,
  ADD CONSTRAINT conversations_document_fk FOREIGN KEY(document_id) REFERENCES han_data.documents(id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX conversations_document_idx ON han_data.conversations(document_id,ordinal,id) WHERE active;
ALTER TABLE han_data.attachments
  ADD COLUMN document_id text GENERATED ALWAYS AS (body->>'documentId') STORED,
  ADD COLUMN client_id text GENERATED ALWAYS AS (body->>'clientId') STORED,
  ADD CONSTRAINT attachments_document_fk FOREIGN KEY(document_id) REFERENCES han_data.documents(id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT attachments_client_fk FOREIGN KEY(client_id) REFERENCES han_data.clients(id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX attachments_document_idx ON han_data.attachments(document_id,id) WHERE active;
CREATE INDEX attachments_client_idx ON han_data.attachments(client_id,id) WHERE active;

-- Search derived from each record: no duplicate editable source. Normalize Turkish
-- letters before matching; user values remain bound parameters in the API.
CREATE FUNCTION han_data.search_normalize(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
  SELECT trim(regexp_replace(normalize(translate(lower(translate(coalesce(value,''),'Iİ','ıi')),'ı','i'),NFD),U&'[\0300-\036f]','','g'))
$$;
CREATE FUNCTION han_data.search_text(record jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,han_data AS $$
  SELECT han_data.search_normalize(coalesce(string_agg((value #>> '{}') ||
    CASE WHEN key ~* 'date|due|issued|created|period' AND value #>> '{}' ~ '^\d{4}-\d{2}-\d{2}'
    THEN ' ' || substring(value #>> '{}' FROM 9 FOR 2) || '.' || substring(value #>> '{}' FROM 6 FOR 2) || '.' || left(value #>> '{}',4)
      || ' ' || substring(value #>> '{}' FROM 9 FOR 2) || '/' || substring(value #>> '{}' FROM 6 FOR 2) || '/' || left(value #>> '{}',4)
    ELSE '' END, ' '),'') || CASE WHEN jsonb_typeof(record->'amount')='number'
    THEN ' ' || translate(to_char((record->>'amount')::numeric,'FM999,999,999,999,990.00'),',.','.,') ELSE '' END)
  FROM jsonb_each(record) WHERE key NOT IN ('id','client','fileData','photoData') AND jsonb_typeof(value) IN ('string','number')
$$;
CREATE FUNCTION han_data.phone_values(record jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
  SELECT coalesce(array_agg(regexp_replace(value,'[^0-9]','','g')),ARRAY[]::text[])
  FROM jsonb_array_elements_text(jsonb_build_array(record->>'phone1',record->>'phone2',record->>'referencePhone1',
    record->>'referencePhone2',record->>'officePhone1',record->>'officePhone2') ||
    CASE WHEN jsonb_typeof(record->'additionalPhones')='array' THEN record->'additionalPhones' ELSE '[]'::jsonb END) p(value)
  WHERE value IS NOT NULL
$$;
ALTER TABLE han_data.clients ADD COLUMN search_text text GENERATED ALWAYS AS (han_data.search_text(body)) STORED;
ALTER TABLE han_data.documents
  ADD COLUMN search_text text GENERATED ALWAYS AS (han_data.search_text(body)) STORED,
  ADD COLUMN phone_values text[] GENERATED ALWAYS AS (han_data.phone_values(body)) STORED;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
-- Supabase may already have pg_trgm in another schema; use its actual namespace.
DO $$ DECLARE extension_schema text; BEGIN
  SELECT n.nspname INTO extension_schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm';
  EXECUTE format('CREATE INDEX documents_search_idx ON han_data.documents USING gin(search_text %I.gin_trgm_ops) WHERE active',extension_schema);
  EXECUTE format('CREATE INDEX clients_search_idx ON han_data.clients USING gin(search_text %I.gin_trgm_ops) WHERE active',extension_schema);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA han_data FROM PUBLIC;

-- One row per file account; totals never depend on a page LIMIT.
CREATE TABLE han_data.document_balances (
  document_id text PRIMARY KEY REFERENCES han_data.documents(id) DEFERRABLE INITIALLY DEFERRED,
  principal_cents bigint NOT NULL, target_cents bigint NOT NULL, received_cents bigint NOT NULL,
  remaining_cents bigint NOT NULL, expenses_cents bigint NOT NULL,
  calculated_on text NOT NULL, source_revision bigint NOT NULL, closed_on text NOT NULL DEFAULT '',
  valid_until text NOT NULL, calculation_version text NOT NULL
);
CREATE INDEX document_balances_expiry_idx ON han_data.document_balances(valid_until,document_id);
CREATE INDEX daily_bonuses_date_idx ON han_data.daily_bonuses((body->>'date'),(body->>'staffId')) WHERE active;
ALTER TABLE han_data.document_balances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON han_data.document_balances FROM PUBLIC;

-- An older deployment must fail rather than silently write to a frozen source.
CREATE FUNCTION han_data.guard_legacy_write() RETURNS trigger LANGUAGE plpgsql
SECURITY INVOKER SET search_path=pg_catalog,han_data AS $$
BEGIN
  PERFORM id FROM han_data.control WHERE id=1 FOR SHARE;
  IF EXISTS(SELECT 1 FROM han_data.control WHERE id=1 AND mode='active') THEN
    RAISE EXCEPTION 'Record store is active; legacy writes are disabled' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION han_data.guard_legacy_write() FROM PUBLIC;
CREATE TRIGGER record_store_legacy_guard BEFORE UPDATE OF payload ON han_private.han_state
  FOR EACH ROW WHEN(OLD.payload IS DISTINCT FROM NEW.payload) EXECUTE FUNCTION han_data.guard_legacy_write();
