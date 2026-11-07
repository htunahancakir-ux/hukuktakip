const { createHash } = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');
const { businessDate } = require('../business-time.cjs');
const { actor } = require('./queries.cjs');
const { refreshBalances, calculationVersion } = require('./balances.cjs');
const failure = (message, status = 400) => Object.assign(Error(message), { status });

async function clientActor(db, req) {
  const user = await actor(db, req);
  if (!['ceo', 'admin'].includes(user.role) && !user.permissions?.includes('clients'))
    throw failure('Müvekkil kayıtlarına erişim yetkiniz yok.', 403);
  return user;
}

function clientFilter({ q = '', limit = 50, after = '' } = {}) {
  limit = Number(limit);
  if (typeof q !== 'string' || q.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw failure('Geçersiz müvekkil araması.');
  q = q.trim();
  const params = [],
    conditions = ['c.active'];
  if (q) {
    params.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%');
    // GIN prefilter plus the same name/identity fields used by the original UI.
    conditions.push("c.search_text LIKE han_data.search_normalize($1) ESCAPE E'\\\\'");
    conditions.push(
      '(' +
        ['name', 'fullName', 'tradeName', 'identity']
          .map(
            (field) =>
              `han_data.search_normalize(c.body->>'${field}') LIKE han_data.search_normalize($1) ESCAPE E'\\\\'`,
          )
          .join(' OR ') +
        ')',
    );
  }
  const signature = createHash('sha256')
    .update(JSON.stringify([q, limit]))
    .digest('hex');
  let cursor = null;
  if (after) {
    try {
      if (typeof after !== 'string' || after.length > 1000) throw Error();
      cursor = JSON.parse(Buffer.from(after, 'base64url').toString());
      if (
        cursor.signature !== signature ||
        typeof cursor.ordinal !== 'string' ||
        !/^\d{1,19}$/.test(cursor.ordinal) ||
        BigInt(cursor.ordinal) > 9223372036854775807n ||
        typeof cursor.id !== 'string' ||
        !cursor.id ||
        cursor.id.length > 200
      )
        throw Error();
    } catch {
      throw failure('Sayfa bilgisi geçersiz; aramayı yenileyin.');
    }
  }
  return { params, conditions, signature, cursor, limit };
}

async function clientSummary(db, today) {
  const {
    rows: [summary],
  } = await db.query(
    `SELECT
    (SELECT count(*)::text FROM han_data.clients WHERE active) AS clients,
    count(*)::text AS documents,
    coalesce(sum(b.principal_cents),0)::text AS "amountCents",
    count(*) FILTER (WHERE d.status='İnfaz')::text AS closed,
    count(*) FILTER (WHERE d.status='İade')::text AS returned,
    coalesce(sum(b.principal_cents) FILTER (WHERE d.status='İnfaz'),0)::text AS "closedCents",
    coalesce(sum(round(coalesce(nullif(d.body->>'clientPaidAmount','')::numeric,0)*100)),0)::text AS "legacyPaidCents",
    count(*) FILTER (WHERE b.document_id IS NULL OR b.source_revision<>d.revision
      OR b.valid_until<$1 OR b.calculation_version<>$2)::int AS stale
    FROM han_data.documents d LEFT JOIN han_data.document_balances b ON b.document_id=d.id WHERE d.active`,
    [today, calculationVersion],
  );
  if (summary.stale) throw failure('Toplamlar güncelleniyor. Tekrar deneyin.', 409);
  const {
    rows: [paid],
  } = await db.query(`SELECT coalesce(sum(e.amount_cents),0)::text AS cents
    FROM han_data.ledger_entries e JOIN han_data.documents d ON d.id=e.document_id AND d.active
    WHERE e.active AND e.kind='clientPayout'`);
  summary.paidCents = String(BigInt(summary.legacyPaidCents) + BigInt(paid.cents));
  delete summary.legacyPaidCents;
  delete summary.stale;
  return summary;
}

async function clientPage(pool, req, input) {
  const f = clientFilter(input);
  const user = await clientActor(pool, req),
    manager = ['ceo', 'admin'].includes(user.role);
  const today = businessDate();
  if (manager) await refreshBalances(pool, today);
  return inTransaction(
    pool,
    async (db) => {
      const current = await clientActor(db, req);
      const {
        rows: [count],
      } = await db.query(
        `SELECT count(*)::text AS count FROM han_data.clients c WHERE ${f.conditions.join(' AND ')}`,
        f.params,
      );
      const params = [...f.params],
        conditions = [...f.conditions];
      if (f.cursor) {
        params.push(f.cursor.ordinal, f.cursor.id);
        conditions.push(`(c.ordinal,c.id)>($${params.length - 1}::bigint,$${params.length}::text)`);
      }
      params.push(f.limit + 1);
      const { rows } = await db.query(
        `SELECT c.id,c.name,c.ordinal::text AS ordinal,
      c.body->>'identity' AS identity,c.body->>'type' AS type,c.body->>'phone' AS phone,
      c.body->>'email' AS email,c.body->>'address' AS address,
      (SELECT count(*)::text FROM han_data.documents d WHERE d.active AND d.client_id=c.id) AS "documentCount"
      FROM han_data.clients c WHERE ${conditions.join(' AND ')} ORDER BY c.ordinal,c.id LIMIT $${params.length}`,
        params,
      );
      const last = rows[f.limit - 1];
      return {
        items: rows.slice(0, f.limit).map(({ ordinal, ...record }) => record),
        count: count.count,
        next:
          rows.length > f.limit
            ? Buffer.from(
                JSON.stringify({ signature: f.signature, ordinal: last.ordinal, id: last.id }),
              ).toString('base64url')
            : null,
        // Summary always covers the whole workspace, never just a page or search.
        summary: manager && ['ceo', 'admin'].includes(current.role) ? await clientSummary(db, today) : null,
      };
    },
    { readOnly: true },
  );
}

async function clientDetail(pool, req, id, { section = 'record', attachmentId = '', revision = '' } = {}) {
  if (typeof id !== 'string' || !id || id.length > 200 || !['record', 'attachment'].includes(section))
    throw failure('Geçersiz müvekkil isteği.');
  return inTransaction(
    pool,
    async (db) => {
      await clientActor(db, req);
      const {
        rows: [client],
      } = await db.query('SELECT body,revision::text FROM han_data.clients WHERE active AND id=$1', [id]);
      if (!client) throw failure('Müvekkil bulunamadı.', 404);
      if (section === 'attachment') {
        if (typeof attachmentId !== 'string' || attachmentId.length > 250) throw failure('Geçersiz ek.');
        const {
          rows: [attachment],
        } = await db.query(
          'SELECT body,revision::text FROM han_data.attachments WHERE active AND client_id=$1 AND id=$2',
          [id, attachmentId],
        );
        if (!attachment) throw failure('Ek bulunamadı.', 404);
        if (revision && revision !== attachment.revision)
          throw failure('Ek değişti. Müvekkili yeniden açın.', 409);
        return attachment.body;
      }
      const { rows: attachments } = await db.query(
        'SELECT id,revision::text FROM han_data.attachments WHERE active AND client_id=$1 ORDER BY ordinal,id',
        [id],
      );
      return { record: client.body, revision: client.revision, attachments };
    },
    { readOnly: true },
  );
}

// Scoped client edits still check identities against every active client/file.
// SERIALIZABLE keeps concurrent new identities from passing the same predicate.
async function assertClientIdentities(db, before, next) {
  const identity = (value) => String(value || '').replace(/\s/g, '');
  const old = new Map(before.data['icrapro-v1'].clients.map((c) => [c.id, c]));
  for (const client of next.data['icrapro-v1'].clients) {
    const key = identity(client.identity);
    if (!/^\d{10,11}$/.test(key) || (old.has(client.id) && identity(old.get(client.id).identity) === key))
      continue;
    const { rows } = await db.query(
      `SELECT 1 FROM han_data.clients
      WHERE active AND id<>$1 AND regexp_replace(coalesce(body->>'identity',''),'[[:space:]]','','g')=$2
      UNION ALL SELECT 1 FROM han_data.documents
      WHERE active AND regexp_replace(coalesce(body->>'identity',''),'[[:space:]]','','g')=$2 LIMIT 1`,
      [client.id, key],
    );
    if (rows.length)
      throw failure(
        'Bu TC kimlik / vergi numarası başka bir müvekkil veya borçluda kayıtlı. Kayıt yapılamadı.',
        409,
      );
  }
}
module.exports = { clientPage, clientDetail, assertClientIdentities };
