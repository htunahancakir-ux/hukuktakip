-- Read-only report helpers. Business rows and historical amounts are unchanged.
CREATE FUNCTION han_data.report_date(value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SECURITY INVOKER
SET search_path=pg_catalog SET timezone='Asia/Baghdad' SET datestyle='ISO, YMD' AS $$
BEGIN
  IF value IS NULL OR value='' THEN RETURN ''; END IF;
  IF value ~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN value; END IF;
  RETURN to_char(value::timestamptz AT TIME ZONE 'Asia/Baghdad','YYYY-MM-DD');
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN '';
END $$;
REVOKE ALL ON FUNCTION han_data.report_date(text) FROM PUBLIC;
CREATE INDEX documents_report_date_idx ON han_data.documents(han_data.report_date(body->>'created') DESC,id DESC) WHERE active;
CREATE INDEX conversations_report_date_idx ON han_data.conversations(han_data.report_date(body->'value'->>'date') DESC,id DESC) WHERE active;
CREATE INDEX finance_payment_order_idx ON han_data.financial_events(document_id,ordinal DESC,id DESC) WHERE active AND kind='payment';
