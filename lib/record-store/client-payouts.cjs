const { createHash } = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');
const { actor } = require('./queries.cjs');
const { businessDate, validDate } = require('../business-time.cjs');
const { refreshBalances, calculationVersion } = require('./balances.cjs');
const { payoutCTE, payoutPaid, entitlement } = require('./report-sql.cjs');
const invalid = (message) => Object.assign(Error(message), { status: 400 });
async function manager(db, req) {
  const user = await actor(db, req);
  if (!['ceo', 'admin'].includes(user.role))
    throw Object.assign(Error('Yönetici yetkisi gerekli.'), { status: 403 });
  return user;
}
function filters(input = {}) {
  const f = {};
  for (const key of [
    'client',
    'start',
    'end',
    'debtor',
    'identity',
    'number',
    'type',
    'staff',
    'paymentState',
  ]) {
    f[key] = input[key] ?? '';
    if (typeof f[key] !== 'string' || f[key].length > 200) throw invalid('Geçersiz ödeme filtresi.');
  }
  if (
    (f.start && !validDate(f.start)) ||
    (f.end && !validDate(f.end)) ||
    (f.start && f.end && f.start > f.end)
  )
    throw invalid('Geçerli tarih aralığı seçin.');
  if (!['', 'unpaid', 'partial'].includes(f.paymentState)) throw invalid('Geçersiz ödeme durumu.');
  for (const k of ['minCents', 'maxCents']) {
    f[k] = String(input[k] ?? '');
    if (f[k] && !/^\d{1,30}$/.test(f[k])) throw invalid('Geçersiz tutar.');
  }
  if (f.minCents && f.maxCents && BigInt(f.minCents) > BigInt(f.maxCents))
    throw invalid('Geçerli tutar aralığı seçin.');
  f.limit = Number(input.limit ?? 50);
  if (!Number.isInteger(f.limit) || f.limit < 1 || f.limit > 100) throw invalid('Geçersiz sayfa boyutu.');
  f.signature = createHash('sha256').update(JSON.stringify(f)).digest('hex');
  if (input.after) {
    try {
      if (typeof input.after !== 'string' || input.after.length > 2000) throw Error();
      f.cursor = JSON.parse(Buffer.from(input.after, 'base64url'));
      if (
        f.cursor.signature !== f.signature ||
        typeof f.cursor.id !== 'string' ||
        f.cursor.id.length > 200 ||
        !/^\d+$/.test(f.cursor.ordinal)
      )
        throw Error();
    } catch {
      throw invalid('Sayfa bilgisi geçersiz. İlk sayfadan başlayın.');
    }
  }
  return f;
}
const base = `WITH ${payoutCTE}, candidates AS (
  SELECT d.id,d.ordinal,d.number,d.kind AS type,d.client_id AS client,d.staff_id AS staff,
    d.body->>'debtor' AS debtor,d.body->>'identity' AS identity,c.name AS "clientName",b.closed_on AS "closedDate",
    (${entitlement}) AS entitlement,${payoutPaid} AS paid,b.remaining_cents AS borrower_remaining,
    greatest(0,(${entitlement})-${payoutPaid}) AS remaining
  FROM han_data.documents d JOIN han_data.document_balances b ON b.document_id=d.id
  LEFT JOIN han_data.clients c ON c.id=d.client_id AND c.active LEFT JOIN payouts pay ON pay.document_id=d.id
  WHERE d.active AND d.status='İnfaz')`;
function query(f, id) {
  const params = [],
    where = ['borrower_remaining=0', 'remaining>0'],
    bind = (v) => '$' + params.push(v);
  if (id) where.push('id=' + bind(id));
  for (const key of ['client', 'type']) if (f[key]) where.push(key + '=' + bind(f[key]));
  if (f.staff) where.push(f.staff === 'unassigned' ? 'staff IS NULL' : 'staff=' + bind(f.staff));
  for (const key of ['debtor', 'number'])
    if (f[key])
      where.push(
        `strpos(han_data.search_normalize(coalesce(${key},'')),han_data.search_normalize(${bind(f[key].trim())}))>0`,
      );
  if (f.identity) where.push(`strpos(coalesce(identity,''),${bind(f.identity.trim())})>0`);
  if (f.start || f.end) where.push(`"closedDate"<>''`);
  if (f.start) where.push('"closedDate">=' + bind(f.start));
  if (f.end) where.push('"closedDate"<=' + bind(f.end));
  if (f.minCents) where.push('remaining>=' + bind(f.minCents) + '::numeric');
  if (f.maxCents) where.push('remaining<=' + bind(f.maxCents) + '::numeric');
  if (f.paymentState) where.push(f.paymentState === 'partial' ? 'paid>0' : 'paid=0');
  return { cte: base + `, filtered AS (SELECT * FROM candidates WHERE ${where.join(' AND ')})`, params };
}
async function ready(db, req) {
  await manager(db, req);
  const { rows } = await db.query(
    `SELECT 1 FROM han_data.documents d LEFT JOIN han_data.document_balances b ON b.document_id=d.id
  WHERE d.active AND d.status='İnfaz' AND (b.document_id IS NULL OR b.source_revision<>d.revision OR b.valid_until<$1 OR b.calculation_version<>$2) LIMIT 1`,
    [businessDate(), calculationVersion],
  );
  if (rows.length)
    throw Object.assign(Error('Ödeme toplamları güncelleniyor. Yeniden deneyin.'), { status: 409 });
}
async function payoutPage(pool, req, input = {}) {
  const f = filters(input);
  await manager(pool, req);
  await refreshBalances(pool);
  return inTransaction(
    pool,
    async (db) => {
      await ready(db, req);
      const q = query(f);
      const {
        rows: [totals],
      } = await db.query(
        q.cte +
          ` SELECT count(*)::text AS count,coalesce(sum(entitlement),0)::text AS entitlement,coalesce(sum(paid),0)::text AS paid,coalesce(sum(remaining),0)::text AS remaining FROM filtered`,
        q.params,
      );
      const params = [...q.params],
        cursor = f.cursor
          ? `WHERE (ordinal,id)>($${params.push(f.cursor.ordinal)}::bigint,$${params.push(f.cursor.id)})`
          : '';
      const { rows } = await db.query(
        q.cte +
          ` SELECT id,ordinal::text,number,type,client,"clientName",debtor,"closedDate",entitlement::text,paid::text,remaining::text FROM filtered ${cursor} ORDER BY filtered.ordinal,id LIMIT $${params.push(f.limit + 1)}`,
        params,
      );
      const more = rows.length > f.limit,
        items = rows.slice(0, f.limit),
        last = items.at(-1);
      return {
        items,
        totals,
        next: more
          ? Buffer.from(
              JSON.stringify({ signature: f.signature, id: last.id, ordinal: last.ordinal }),
            ).toString('base64url')
          : null,
      };
    },
    { readOnly: true },
  );
}
async function payoutDetail(pool, req, id) {
  if (typeof id !== 'string' || !id || id.length > 200) throw invalid('Geçersiz dosya.');
  await manager(pool, req);
  await refreshBalances(pool);
  return inTransaction(
    pool,
    async (db) => {
      await ready(db, req);
      const q = query({}, id);
      const {
        rows: [row],
      } = await db.query(
        q.cte +
          ' SELECT id,number,client,"closedDate",entitlement::text,paid::text,remaining::text FROM filtered',
        q.params,
      );
      if (!row)
        throw Object.assign(Error('Bu dosyada ödemesi bekleyen infaz anaparası yok.'), { status: 409 });
      const {
        rows: [client],
      } = await db.query(
        `SELECT id,name,body->>'bankName' AS "bankName",body->>'accountHolder' AS "accountHolder",body->>'iban' AS iban FROM han_data.clients WHERE id=$1 AND active`,
        [row.client],
      );
      const { rows: accounts } = await db.query(
        `SELECT id,body->>'name' AS name FROM han_data.accounts WHERE active ORDER BY ordinal,id`,
      );
      return {
        record: { id: row.id, number: row.number, client: row.client, closedDate: row.closedDate },
        client: client || null,
        totals: { entitlement: row.entitlement, paid: row.paid, remaining: row.remaining, eligible: true },
        accounts,
        accountBalances: await require('./accounts.cjs').accountBalances(db),
      };
    },
    { readOnly: true },
  );
}
async function payoutScope(db, request) {
  await manager(db, request.req);
  let input;
  try {
    input = JSON.parse(request.raw);
  } catch {
    throw invalid('Geçersiz ödeme.');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Geçersiz ödeme.');
  for (const key of ['id', 'documentId', 'clientId', 'accountId'])
    if (typeof input[key] !== 'string' || !input[key] || input[key].length > 200)
      throw invalid('Geçersiz ödeme kimliği.');
  await db.query('SELECT id FROM han_data.documents WHERE id=$1 AND active FOR UPDATE', [input.documentId]);
  await db.query('SELECT id FROM han_data.accounts WHERE id=$1 AND active FOR UPDATE', [input.accountId]);
  const {
    rows: [existing],
  } = await db.query('SELECT active FROM han_data.ledger_entries WHERE id=$1', [input.id]);
  if (existing && !existing.active)
    throw Object.assign(Error('Arşivlenmiş işlem numarası kullanılamaz.'), { status: 409 });
  return {
    tables: ['clients', 'documents', 'financial_events', 'ledger_entries', 'accounts'],
    documentIds: [input.documentId],
    clientIds: [input.clientId],
    payoutId: input.id,
    payoutAccount: input.accountId,
  };
}
module.exports = { payoutPage, payoutDetail, payoutScope, filters, query };
