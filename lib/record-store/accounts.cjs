async function accountBalances(db, ids = null) {
  const { rows } = await db.query(
    `WITH movements AS (
    SELECT account_id, CASE WHEN kind='payment' THEN amount_cents ELSE -amount_cents END AS signed
    FROM han_data.financial_events WHERE active AND ($1::text[] IS NULL OR account_id=ANY($1))
    UNION ALL
    SELECT account_id, CASE WHEN kind='in' THEN amount_cents ELSE -amount_cents END
    FROM han_data.ledger_entries WHERE active AND ($1::text[] IS NULL OR account_id=ANY($1))
    UNION ALL
    SELECT body->>'destination',amount_cents FROM han_data.ledger_entries
    WHERE active AND kind='transfer' AND ($1::text[] IS NULL OR body->>'destination'=ANY($1))
  ) SELECT a.id,coalesce(sum(m.signed),0)::text AS cents FROM han_data.accounts a
    LEFT JOIN movements m ON m.account_id=a.id
    WHERE a.active AND ($1::text[] IS NULL OR a.id=ANY($1)) GROUP BY a.id`,
    [ids],
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.cents]));
}
module.exports = { accountBalances };
