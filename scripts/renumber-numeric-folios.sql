-- One-time, atomic data conversion. Document IDs and all money fields remain intact.
DO $renumber$
DECLARE
  document_row record;
  next_number bigint := 0;
  previous_numbers jsonb;
BEGIN
  PERFORM id FROM han_data.control WHERE id=1 FOR UPDATE;
  PERFORM id FROM han_data.metadata WHERE id=1 FOR UPDATE;
  IF (SELECT body->>'folioNumberingVersion' FROM han_data.metadata WHERE id=1) = '1' THEN
    RETURN;
  END IF;
  LOCK TABLE han_data.document_sequences IN EXCLUSIVE MODE;
  FOR document_row IN SELECT id,body FROM han_data.documents ORDER BY ordinal,id FOR UPDATE LOOP
    next_number := next_number + 1;
    SELECT coalesce(jsonb_agg(DISTINCT old_number), '[]'::jsonb)
      INTO previous_numbers
      FROM jsonb_array_elements_text(
        coalesce(document_row.body->'previousFolioNumbers','[]'::jsonb)
        || jsonb_build_array(document_row.body->>'number')
      ) old_number
      WHERE old_number IS NOT NULL AND old_number <> '';
    UPDATE han_data.documents
      SET body = body || jsonb_build_object('number',next_number::text,'previousFolioNumbers',previous_numbers),
          revision=revision+1,updated_at=clock_timestamp()
      WHERE id=document_row.id;
    UPDATE han_data.document_archives
      SET body=jsonb_set(jsonb_set(body,'{document,number}',to_jsonb(next_number::text)),
                        '{document,previousFolioNumbers}',previous_numbers),
          revision=revision+1,updated_at=clock_timestamp()
      WHERE body->'document'->>'id'=document_row.id;
  END LOOP;
  INSERT INTO han_data.document_sequences(prefix,last_value) VALUES('GLOBAL',next_number)
    ON CONFLICT(prefix) DO UPDATE SET last_value=EXCLUDED.last_value;
  UPDATE han_data.metadata
    SET body=body || jsonb_build_object('folioNumberingVersion',1,'folioRenumberedAt',clock_timestamp()),
        revision=revision+1
    WHERE id=1;
END;
$renumber$;
