-- The call panel's "Numara ekle" used to append every new number to additionalPhones, even when
-- the debtor's own Tel-1 / Tel-2 were empty, so those numbers never showed in the borrower form.
-- Move them up in order: Tel-1, Tel-2, then Tel-3, Tel-4… (additionalPhones). Repeated numbers
-- (same digits, with or without 0 / 90 prefix) keep their first position. Reference and office
-- numbers are left alone. Same rule as borrowerPhoneSlots() in outputs/icrapro/phone-format.js.
WITH ordered AS (
  SELECT d.ctid AS row_ref, d.body,
    (SELECT coalesce(jsonb_agg(to_jsonb(u.value) ORDER BY u.pos), '[]'::jsonb)
     FROM (
       SELECT DISTINCT ON (x.key) x.value, x.pos
       FROM (
         SELECT btrim(e.value) AS value, e.pos,
           regexp_replace(regexp_replace(btrim(e.value), '\D', '', 'g'), '^(90|0)(?=[1-9]\d{9}$)', '') AS key
         FROM jsonb_array_elements_text(
           jsonb_build_array(coalesce(d.body->>'phone1', ''), coalesce(d.body->>'phone2', ''))
             || (d.body->'additionalPhones')) WITH ORDINALITY e(value, pos)
         WHERE btrim(e.value) <> ''
       ) x
       ORDER BY x.key, x.pos
     ) u) AS list
  FROM han_data.documents d
  WHERE jsonb_typeof(d.body->'additionalPhones') = 'array'
    AND jsonb_array_length(d.body->'additionalPhones') > 0
    AND (coalesce(btrim(d.body->>'phone1'), '') = '' OR coalesce(btrim(d.body->>'phone2'), '') = '')
), slotted AS (
  SELECT row_ref, body || jsonb_build_object(
      'phone1', coalesce(list->>0, ''),
      'phone2', coalesce(list->>1, ''),
      'additionalPhones', coalesce((SELECT jsonb_agg(v ORDER BY o) FROM jsonb_array_elements(list) WITH ORDINALITY a(v, o) WHERE o > 2), '[]'::jsonb)
    ) AS body
  FROM ordered
)
UPDATE han_data.documents d
SET body = s.body, revision = d.revision + 1, updated_at = clock_timestamp()
FROM slotted s
WHERE d.ctid = s.row_ref AND d.body IS DISTINCT FROM s.body;
