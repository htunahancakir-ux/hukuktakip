const { inTransaction } = require('../db-transaction.cjs');
const { actor } = require('./queries.cjs');
const { validDate } = require('../business-time.cjs');
function range(period, date) {
  if (!['day', 'month', 'year'].includes(period) || !validDate(date || ''))
    throw Object.assign(Error('Geçersiz rapor tarihi.'), { status: 400 });
  const start =
    period === 'year' ? date.slice(0, 4) + '-01-01' : period === 'month' ? date.slice(0, 7) + '-01' : date;
  const d = new Date(start + 'T00:00:00Z');
  if (period === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else if (period === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCDate(d.getUTCDate() + 1);
  return { start, end: d.toISOString().slice(0, 10) };
}
async function dashboard(pool, req, { period = 'day', date } = {}) {
  const { start, end } = range(period, date);
  return inTransaction(
    pool,
    async (db) => {
      const user = await actor(db, req);
      if (!['ceo', 'admin'].includes(user.role))
        throw Object.assign(Error('Yönetici yetkisi gerekli.'), { status: 403 });
      const { rows } = await db.query(
        `WITH relevant AS (
      SELECT * FROM han_data.financial_events WHERE active AND occurred_on >= $1 AND occurred_on < $2
    ), files AS (SELECT DISTINCT document_id FROM relevant WHERE kind='payment'), payments AS (
      SELECT p.document_id,sum(p.amount_cents) AS received,
        (array_agg(p.id ORDER BY p.ordinal DESC,p.id DESC))[1] AS last_id,
        (array_agg(p.id ORDER BY p.ordinal DESC,p.id DESC) FILTER(WHERE p.body->>'closes'='true'))[1] AS last_closing_id,
        sum(coalesce((p.body->>'revenuePart')::numeric,0)) AS legacy_revenue
      FROM han_data.financial_events p JOIN files f ON f.document_id=p.document_id
      WHERE p.active AND p.kind='payment' GROUP BY p.document_id
    ), flows AS (
      SELECT e.occurred_on AS day,
        CASE WHEN e.kind='payment' THEN e.amount_cents ELSE 0 END::numeric AS collected,
        CASE WHEN e.kind<>'payment' THEN 0
          WHEN d.status='İade' THEN e.amount_cents
          WHEN e.id=CASE WHEN d.status='İnfaz' THEN p.last_id ELSE p.last_closing_id END THEN
            CASE WHEN nullif(e.body->>'parkingCommissionRate','') IS NOT NULL OR d.kind='Yediemin Park Ücreti'
              THEN round(p.received*coalesce(nullif(e.body->>'parkingCommissionRate','')::numeric,nullif(d.body->>'parkingCommissionRate','')::numeric,0)/100)
              WHEN e.body->>'principalAtCollection' IS NOT NULL OR d.id IS NOT NULL THEN
                greatest(0,p.received-coalesce((e.body->>'principalAtCollection')::numeric,round(coalesce((d.body->>'amount')::numeric,0)*100)))+coalesce((d.body->>'mixedParkingCommissionCents')::numeric,0)
              ELSE p.legacy_revenue END
          ELSE 0 END::numeric AS revenue,
        CASE WHEN e.kind IN ('expense','costOnly') AND coalesce(e.body->>'expensePoolAllocation','false') <> 'true' THEN e.amount_cents ELSE 0 END::numeric AS expenses,
        CASE WHEN e.kind='payment' AND e.body->>'closes'='true' THEN 1 ELSE 0 END AS closed_count,
        CASE WHEN e.kind='payment' AND e.body->>'closes'='true' THEN coalesce((e.body->>'closedAmount')::numeric,0) ELSE 0 END::numeric AS closed_amount
      FROM relevant e LEFT JOIN han_data.documents d ON d.id=e.document_id LEFT JOIN payments p ON p.document_id=e.document_id
      UNION ALL
      SELECT occurred_on,0,
        CASE WHEN kind='in' AND body->>'entryKind'='external' AND body->>'includeInProfit'='true' THEN amount_cents ELSE 0 END,
        CASE WHEN kind='out' AND nullif(body->>'financeEventId','') IS NULL THEN amount_cents ELSE 0 END,0,0
      FROM han_data.ledger_entries WHERE active AND occurred_on >= $1 AND occurred_on < $2
    ) SELECT CASE WHEN $3='year' THEN left(day,7) ELSE day END AS key,
      sum(collected)::text AS collected,sum(revenue)::text AS revenue,sum(expenses)::text AS expenses,
      (sum(revenue)-sum(expenses))::text AS profit,sum(closed_count)::text AS "closedCount",sum(closed_amount)::text AS "closedAmount"
      FROM flows GROUP BY 1 ORDER BY 1`,
        [start, end, period],
      );
      const byKey = new Map(rows.map((r) => [r.key, r])),
        buckets = [];
      const cursor = new Date(start + 'T00:00:00Z');
      while (cursor.toISOString().slice(0, 10) < end) {
        const day = cursor.toISOString().slice(0, 10),
          key = period === 'year' ? day.slice(0, 7) : day;
        const row = byKey.get(key) || {
          key,
          collected: '0',
          revenue: '0',
          expenses: '0',
          profit: '0',
          closedCount: '0',
          closedAmount: '0',
        };
        buckets.push(row);
        if (period === 'year') cursor.setUTCMonth(cursor.getUTCMonth() + 1);
        else cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      return { buckets, start, end };
    },
    { readOnly: true },
  );
}
module.exports = { dashboard, range };
