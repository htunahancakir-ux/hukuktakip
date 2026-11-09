const { createHash } = require('node:crypto');
const { actor } = require('./queries.cjs');
const { inTransaction } = require('../db-transaction.cjs');
const { validDate } = require('../business-time.cjs');
const { movementCTE } = require('./account-movements.cjs');
const { accountBalances } = require('./accounts.cjs');
const invalid = () => Object.assign(Error('Geçersiz muhasebe filtresi veya sayfa bilgisi.'), { status: 400 });
function accountingFilter(input = {}) {
  const f = {};
  for (const key of ['account', 'start', 'end', 'type', 'operator', 'category', 'query']) {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > 200) throw invalid();
    f[key] = value;
  }
  if (
    (f.start && !validDate(f.start)) ||
    (f.end && !validDate(f.end)) ||
    (f.start && f.end && f.start > f.end)
  )
    throw invalid();
  if (
    ![
      '',
      'in',
      'external',
      'out',
      'advance',
      'transfer',
      'payment',
      'expense',
      'costOnly',
      'clientPayout',
    ].includes(f.type)
  )
    throw invalid();
  f.limit = Number(input.limit ?? 50);
  if (!Number.isInteger(f.limit) || f.limit < 1 || f.limit > 100) throw invalid();
  f.signature = createHash('sha256').update(JSON.stringify(f)).digest('hex');
  if (input.after) {
    try {
      if (typeof input.after !== 'string' || input.after.length > 2500) throw invalid();
      f.cursor = JSON.parse(Buffer.from(input.after, 'base64url'));
      if (
        f.cursor.signature !== f.signature ||
        ['date', 'created', 'id'].some((k) => typeof f.cursor[k] !== 'string' || f.cursor[k].length > 500)
      )
        throw invalid();
    } catch {
      throw invalid();
    }
  }
  return f;
}
async function accountingPage(pool, req, input = {}) {
  const f = accountingFilter(input);
  return inTransaction(
    pool,
    async (db) => {
      const user = await actor(db, req);
      if (!['ceo', 'admin'].includes(user.role))
        throw Object.assign(Error('Muhasebe hareketlerini yalnız yöneticiler görüntüleyebilir.'), {
          status: 403,
        });
      const params = [],
        conditions = [];
      const bind = (value) => '$' + params.push(value);
      for (const [key, column] of [
        ['account', 'account_id'],
        ['operator', "body->>'operatorName'"],
        ['category', "body->>'expenseCategory'"],
      ])
        if (f[key]) conditions.push(`${column}=${bind(f[key])}`);
      if (f.category) conditions.push("body->>'type'='out'");
      if (f.start) conditions.push('occurred_on>=' + bind(f.start));
      if (f.end) conditions.push('occurred_on<=' + bind(f.end));
      if (f.type === 'external') conditions.push("body->>'type'='in' AND body->>'entryKind'='external'");
      else if (f.type === 'in')
        conditions.push("body->>'type'='in' AND coalesce(body->>'entryKind','')<>'external'");
      else if (f.type) conditions.push("body->>'type'=" + bind(f.type));
      if (f.query) {
        const q = bind(f.query);
        conditions.push(
          '(' +
            ["body->>'note'", 'label', "body->>'operatorName'", "body->>'expenseCategory'"]
              .map(
                (v) =>
                  `strpos(han_data.search_normalize(coalesce(${v},'')),han_data.search_normalize(${q}))>0`,
              )
              .join(' OR ') +
            ')',
        );
      }
      const cte = `WITH ${movementCTE}, ledger AS (
        SELECT *,coalesce(body->>'createdAt','') AS created,
          sum(signed) OVER (PARTITION BY account_id ORDER BY occurred_on,coalesce(body->>'createdAt',''),id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance
        FROM movements
      ), filtered AS (SELECT * FROM ledger ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''})`;
      const {
        rows: [totals],
      } = await db.query(
        cte +
          ` SELECT count(*)::text AS count,coalesce(sum(greatest(signed,0)),0)::text AS incoming,coalesce(sum(greatest(-signed,0)),0)::text AS outgoing,coalesce(sum(signed),0)::text AS net FROM filtered`,
        params,
      );
      const pageParams = [...params];
      const cursor = f.cursor
        ? `WHERE (occurred_on,created,id)<($${pageParams.push(f.cursor.date)},$${pageParams.push(f.cursor.created)},$${pageParams.push(f.cursor.id)})`
        : '';
      const { rows } = await db.query(
        cte +
          ` SELECT id,occurred_on AS date,created,account_id AS "accountId",label,body->>'type' AS type,body->>'operatorName' AS "operatorName",body->>'expenseCategory' AS "expenseCategory",body->>'note' AS note,signed::text AS signed,running_balance::text AS balance FROM filtered ${cursor} ORDER BY occurred_on DESC,created DESC,id DESC LIMIT $${pageParams.push(f.limit + 1)}`,
        pageParams,
      );
      const more = rows.length > f.limit,
        items = rows.slice(0, f.limit),
        last = items.at(-1);
      const { rows: accounts } = await db.query(
        'SELECT body FROM han_data.accounts WHERE active ORDER BY ordinal,id',
      );
      const { rows: summaries } = await db.query(
        `WITH ${movementCTE} SELECT account_id AS id,
          sum(greatest(signed,0))::text AS incoming,
          sum(greatest(-signed,0))::text AS outgoing,
          sum(signed)::text AS balance FROM movements GROUP BY account_id`,
      );
      const { rows: operators } = await db.query(
        `WITH ${movementCTE} SELECT DISTINCT body->>'operatorName' AS name FROM movements WHERE coalesce(body->>'operatorName','')<>'' ORDER BY name LIMIT 200`,
      );
      const {
        rows: [legacy],
      } = await db.query(
        "SELECT EXISTS(SELECT 1 FROM han_data.financial_events WHERE active AND kind='payment' AND account_id IS NULL) AS unassigned",
      );
      return {
        items,
        totals,
        accounts: accounts.map((a) => a.body),
        accountSummaries: Object.fromEntries(summaries.map((s) => [s.id, s])),
        balances: await accountBalances(db),
        operators: operators.map((o) => o.name),
        unassigned: legacy.unassigned,
        next: more
          ? Buffer.from(
              JSON.stringify({ signature: f.signature, date: last.date, created: last.created, id: last.id }),
            ).toString('base64url')
          : null,
      };
    },
    { readOnly: true },
  );
}
module.exports = { accountingPage, accountingFilter };
