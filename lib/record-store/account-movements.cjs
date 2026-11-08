// Shared by accounting pages, reports and authoritative account balances.
const movementCTE = `movements AS (
      SELECT 'ledger:'||e.id||':'||v.direction AS id,e.document_id,e.body,e.occurred_on,v.account_id,v.signed,v.label FROM han_data.ledger_entries e
      CROSS JOIN LATERAL (
        SELECT 'out' AS direction,e.account_id,CASE WHEN e.kind='in' THEN e.amount_cents ELSE -e.amount_cents END AS signed,
          CASE WHEN e.kind='transfer' THEN 'Hesaplar arası çıkış' WHEN e.kind='in' THEN CASE WHEN e.body->>'entryKind'='external' THEN 'Haricen para girişi ('||CASE WHEN e.body->>'includeInProfit'='true' THEN 'kâra eklendi' ELSE 'kâra eklenmedi' END||')' ELSE 'Para girişi' END WHEN e.kind='clientPayout' THEN 'Müvekkile anapara ödemesi' WHEN e.kind='advance' THEN 'Avans çıkışı · '||coalesce(e.body->>'advanceType','') ELSE 'Para çıkışı' END AS label
        UNION ALL SELECT 'in',e.body->>'destination',e.amount_cents,'Hesaplar arası giriş' WHERE e.kind='transfer'
      ) v WHERE e.active
      UNION ALL SELECT 'finance:'||e.id,e.document_id,jsonb_set(e.body,'{note}',to_jsonb(coalesce(d.number,'Evrak')||' · '||coalesce(e.body->>'note','undefined'))),e.occurred_on,e.account_id,
        CASE WHEN e.kind='payment' THEN e.amount_cents ELSE -e.amount_cents END,
        CASE WHEN e.kind='payment' THEN 'Borçlu tahsilatı' WHEN e.kind='expense' THEN 'Borçlu masrafı' ELSE 'Masraf (borca eklenmedi)' END
        FROM han_data.financial_events e LEFT JOIN han_data.documents d ON d.id=e.document_id AND d.active
        WHERE e.active AND e.kind IN ('payment','expense','costOnly') AND e.account_id IS NOT NULL
        AND NOT coalesce((SELECT body->'data'->'hanhukuk-accounting-v1'->'excludedFinanceIds' FROM han_data.metadata WHERE id=1),'[]'::jsonb) ? e.id
    )`;
module.exports = { movementCTE };
