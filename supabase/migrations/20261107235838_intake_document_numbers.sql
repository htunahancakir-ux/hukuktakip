-- Derived number high-water marks. Existing document bodies are never changed.
SET LOCAL lock_timeout = '10s';
LOCK TABLE han_data.documents, han_data.metadata IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE han_data.document_sequences (
  prefix text PRIMARY KEY, last_value bigint NOT NULL CHECK (last_value >= 0)
);
ALTER TABLE han_data.document_sequences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON han_data.document_sequences FROM PUBLIC;
INSERT INTO han_data.document_sequences(prefix,last_value)
SELECT upper(translate(split_part(number,'-',1),'iı','İI')), max(split_part(number,'-',2)::bigint)
FROM (
  SELECT number FROM han_data.documents
  UNION ALL SELECT body->'document'->>'number' FROM han_data.document_archives
  UNION ALL SELECT jsonb_array_elements_text(coalesce(body#>'{data,icrapro-v1,archivedNumbers}','[]'::jsonb)) FROM han_data.metadata
) existing
WHERE number ~ '^[^-]+-[0-9]{1,18}$'
GROUP BY upper(translate(split_part(number,'-',1),'iı','İI'));

-- Imports/restores and compatibility writes must also advance the high-water
-- mark. GREATEST keeps historical duplicate numbers and never reuses a number.
CREATE FUNCTION han_data.track_document_number() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,han_data AS $$
DECLARE n text;
BEGIN
  FOR n IN SELECT upper(translate(value,'iı','İI')) FROM jsonb_array_elements_text(
    CASE WHEN TG_TABLE_NAME='metadata' THEN coalesce(NEW.body#>'{data,icrapro-v1,archivedNumbers}','[]'::jsonb)
      ELSE jsonb_build_array(NEW.body->>'number') END
  ) AS numbers(value) LOOP
  IF n ~ '^[^-]+-[0-9]{1,18}$' THEN
    INSERT INTO han_data.document_sequences(prefix,last_value)
    VALUES (split_part(n,'-',1),split_part(n,'-',2)::bigint)
    ON CONFLICT(prefix) DO UPDATE SET last_value=greatest(document_sequences.last_value,excluded.last_value);
  END IF;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION han_data.track_document_number() FROM PUBLIC;
CREATE TRIGGER track_document_number_insert AFTER INSERT ON han_data.documents
  FOR EACH ROW EXECUTE FUNCTION han_data.track_document_number();
CREATE TRIGGER track_document_number_update AFTER UPDATE OF body ON han_data.documents
  FOR EACH ROW WHEN (OLD.body->>'number' IS DISTINCT FROM NEW.body->>'number')
  EXECUTE FUNCTION han_data.track_document_number();
CREATE TRIGGER track_archived_numbers_insert AFTER INSERT ON han_data.metadata
  FOR EACH ROW EXECUTE FUNCTION han_data.track_document_number();
CREATE TRIGGER track_archived_numbers_update AFTER UPDATE OF body ON han_data.metadata
  FOR EACH ROW WHEN (OLD.body#>'{data,icrapro-v1,archivedNumbers}' IS DISTINCT FROM NEW.body#>'{data,icrapro-v1,archivedNumbers}')
  EXECUTE FUNCTION han_data.track_document_number();
