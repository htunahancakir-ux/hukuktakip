-- Preserve the indexed status column, its indexes and row-level policies.
SET LOCAL lock_timeout = '5s';
ALTER TABLE han_data.documents ALTER COLUMN status SET EXPRESSION AS (
  CASE WHEN body->>'status' IN ('Derdest','İnfaz','Bekleme','İade','İcra')
  THEN body->>'status' ELSE 'Derdest' END
);
CREATE INDEX IF NOT EXISTS documents_parking_waiting_date_idx
  ON han_data.documents ((body->>'parkingProcessOn'),id)
  WHERE active AND status='Bekleme';
