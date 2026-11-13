-- Explicit administrative operation. Only the selected tenant is renumbered.
-- Active files come first; archived file numbers remain reserved for restoration.
DO $renumber$
DECLARE
  target_tenant uuid := han_private.current_tenant();
  mapping jsonb;
  document_row record;
  previous_numbers jsonb;
  document_digest text;
  archive_digest text;
  financial_digest text;
  ledger_digest text;
  document_count bigint;
BEGIN
  PERFORM id FROM han_data.control WHERE tenant_id=target_tenant AND id=1 FOR UPDATE;
  PERFORM id FROM han_data.metadata WHERE tenant_id=target_tenant AND id=1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tenant metadata missing'; END IF;
  IF coalesce((SELECT (body->>'folioNumberingVersion')::int FROM han_data.metadata
               WHERE tenant_id=target_tenant AND id=1),0) >= 2 THEN RETURN; END IF;
  LOCK TABLE han_data.document_sequences IN EXCLUSIVE MODE;
  PERFORM id FROM han_data.documents WHERE tenant_id=target_tenant FOR UPDATE;
  PERFORM id FROM han_data.document_archives WHERE tenant_id=target_tenant FOR UPDATE;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'old',number,'number',new_number,
             'previous',coalesce(body->'previousFolioNumbers','[]'::jsonb)) ORDER BY new_number::bigint),'[]'::jsonb),count(*)
    INTO mapping,document_count
    FROM (SELECT id,number,body,(row_number() OVER(ORDER BY active DESC,ordinal,id))::text AS new_number
          FROM han_data.documents WHERE tenant_id=target_tenant) ordered;
  SELECT md5(coalesce(jsonb_agg(jsonb_build_array(id,body-'number'-'previousFolioNumbers') ORDER BY id)::text,''))
    INTO document_digest FROM han_data.documents WHERE tenant_id=target_tenant;
  SELECT md5(coalesce(jsonb_agg(jsonb_build_array(id,body #- '{document,number}' #- '{document,previousFolioNumbers}') ORDER BY id)::text,''))
    INTO archive_digest FROM han_data.document_archives WHERE tenant_id=target_tenant;
  SELECT md5(coalesce(jsonb_agg(jsonb_build_array(id,body) ORDER BY id)::text,''))
    INTO financial_digest FROM han_data.financial_events WHERE tenant_id=target_tenant;
  SELECT md5(coalesce(jsonb_agg(jsonb_build_array(id,body) ORDER BY id)::text,''))
    INTO ledger_digest FROM han_data.ledger_entries WHERE tenant_id=target_tenant;

  -- Two phases allow reordering even when the unique index is already installed.
  UPDATE han_data.documents SET body=jsonb_set(body,'{number}',to_jsonb('__renumber_v2__:'||id))
    WHERE tenant_id=target_tenant;
  FOR document_row IN SELECT * FROM jsonb_to_recordset(mapping) AS m(id text,old text,number text,previous jsonb) LOOP
    SELECT coalesce(jsonb_agg(DISTINCT old_number),'[]'::jsonb) INTO previous_numbers
      FROM jsonb_array_elements_text(document_row.previous||jsonb_build_array(document_row.old)) old_number
      WHERE old_number IS NOT NULL AND old_number<>'';
    UPDATE han_data.documents
      SET body=body||jsonb_build_object('number',document_row.number,'previousFolioNumbers',previous_numbers),
          revision=revision+1,updated_at=clock_timestamp()
      WHERE tenant_id=target_tenant AND id=document_row.id;
    UPDATE han_data.document_archives
      SET body=jsonb_set(jsonb_set(body,'{document,number}',to_jsonb(document_row.number)),
                        '{document,previousFolioNumbers}',previous_numbers),
          revision=revision+1,updated_at=clock_timestamp()
      WHERE tenant_id=target_tenant AND body->'document'->>'id'=document_row.id;
  END LOOP;
  IF document_digest IS DISTINCT FROM (
    SELECT md5(coalesce(jsonb_agg(jsonb_build_array(id,body-'number'-'previousFolioNumbers') ORDER BY id)::text,''))
      FROM han_data.documents WHERE tenant_id=target_tenant)
    OR archive_digest IS DISTINCT FROM (
    SELECT md5(coalesce(jsonb_agg(jsonb_build_array(id,body #- '{document,number}' #- '{document,previousFolioNumbers}') ORDER BY id)::text,''))
      FROM han_data.document_archives WHERE tenant_id=target_tenant)
    OR financial_digest IS DISTINCT FROM (
    SELECT md5(coalesce(jsonb_agg(jsonb_build_array(id,body) ORDER BY id)::text,''))
      FROM han_data.financial_events WHERE tenant_id=target_tenant)
    OR ledger_digest IS DISTINCT FROM (
    SELECT md5(coalesce(jsonb_agg(jsonb_build_array(id,body) ORDER BY id)::text,''))
      FROM han_data.ledger_entries WHERE tenant_id=target_tenant) THEN
    RAISE EXCEPTION 'Renumbering changed unrelated document data';
  END IF;
  INSERT INTO han_data.document_sequences(tenant_id,prefix,last_value) VALUES(target_tenant,'GLOBAL',document_count)
    ON CONFLICT(tenant_id,prefix) DO UPDATE SET last_value=EXCLUDED.last_value;
  UPDATE han_data.metadata
    SET body=body||jsonb_build_object('folioNumberingVersion',2,'folioRenumberedAt',clock_timestamp(),
        'folioRenumberingV2',jsonb_build_object('mapping',mapping,'count',document_count,
          'documentDigest',document_digest,'archiveDigest',archive_digest,
          'financialDigest',financial_digest,'ledgerDigest',ledger_digest)),revision=revision+1
    WHERE tenant_id=target_tenant AND id=1;
  -- Numeric equality also prevents '1' and '01' from coexisting in a tenant.
  SET CONSTRAINTS ALL IMMEDIATE;
  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS documents_tenant_numeric_number_unique
    ON han_data.documents(tenant_id,(number::numeric)) WHERE number ~ ''^[0-9]+$''';
END;
$renumber$;
