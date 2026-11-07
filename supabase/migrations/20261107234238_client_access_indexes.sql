-- Additive indexes only: no data rewrite/deletion and no uniqueness constraint
-- on historical identities. New edits validate identities in a serializable transaction.
CREATE INDEX clients_order_idx ON han_data.clients(ordinal,id) WHERE active;
CREATE INDEX clients_identity_idx ON han_data.clients
  ((regexp_replace(coalesce(body->>'identity',''),'[[:space:]]','','g'))) WHERE active;
CREATE INDEX documents_identity_idx ON han_data.documents
  ((regexp_replace(coalesce(body->>'identity',''),'[[:space:]]','','g'))) WHERE active;
