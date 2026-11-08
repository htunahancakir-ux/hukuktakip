async function accountBalances(db, ids = null) {
  const { rows } = await db.query(
    `WITH ${require('./account-movements.cjs').movementCTE}
    SELECT a.id,coalesce(sum(m.signed),0)::text AS cents FROM han_data.accounts a
    LEFT JOIN movements m ON m.account_id=a.id
    WHERE a.active AND ($1::text[] IS NULL OR a.id=ANY($1)) GROUP BY a.id`,
    [ids],
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.cents]));
}
module.exports = { accountBalances };
