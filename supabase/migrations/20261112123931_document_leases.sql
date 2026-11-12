CREATE TABLE IF NOT EXISTS han_private.document_leases (
  document_id text PRIMARY KEY REFERENCES han_data.documents(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  session_hash text NOT NULL,
  view_id text NOT NULL,
  expires_at bigint NOT NULL
);
ALTER TABLE han_private.document_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON han_private.document_leases FROM PUBLIC;
