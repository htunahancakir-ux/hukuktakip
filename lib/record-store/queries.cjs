const { inTransaction } = require('../db-transaction.cjs');
const { sessionKey } = require('../session-policy.cjs');
const { businessDate } = require('../business-time.cjs');
const { refreshBalances, calculationVersion } = require('./balances.cjs');
const invalid = (message) => Object.assign(Error(message), { status: 400 });
async function actor(db, req, { allowBreak = false } = {}) {
  const active = await db.query("SELECT id FROM han_data.control WHERE id=1 AND mode='active'");
  if (!active.rows.length)
    throw Object.assign(Error('Kayıt deposu henüz etkinleştirilmedi.'), { status: 503 });
  const { rows } = await db.query(
    `SELECT a.body,a.terms_required,EXISTS(SELECT 1 FROM han_data.personnel p WHERE p.id=a.body->>'staffId' AND p.active AND lower(trim(p.body->>'department'))='muhasebe') AS accounting_access FROM han_private.han_account_index a
    JOIN han_private.han_sessions s ON s.account_id=a.id
    WHERE s.token_hash=$1 AND s.expires_at>$2 AND s.device_type IN ('desktop','mobile') AND a.enabled`,
    [sessionKey(req), Date.now()],
  );
  if (!rows.length) throw Object.assign(Error('Oturum açmanız gerekiyor.'), { status: 401 });
  if (rows[0].terms_required && rows[0].body.role !== 'ceo')
    throw Object.assign(Error('Güncel sözleşmeyi kabul edin.'), {
      status: 428,
      code: 'employee_terms_required',
    });
  if (rows[0].body.activeBreak && rows[0].body.role !== 'ceo' && !allowBreak)
    throw Object.assign(Error('İşlem için molayı bitirin.'), { status: 423, code: 'staff_on_break' });
  return { ...rows[0].body, accountingAccess: rows[0].accounting_access === true };
}
const { filter, pageOrder, nextCursor } = require('./document-filter.cjs');
const from = ` FROM han_data.documents d LEFT JOIN han_data.clients c ON c.id=d.client_id
  LEFT JOIN han_data.document_balances b ON b.document_id=d.id
  LEFT JOIN han_data.personnel p ON p.id=d.staff_id `;
async function documentPage(pool, req, input = {}) {
  // Authorize before doing expensive work, then recheck in the read snapshot.
  const user = await actor(pool, req);
  const f = filter(input, { manager: ['ceo', 'admin'].includes(user.role) });
  const today = businessDate();
  await require('./parking-waiting.cjs').refreshParkingWaiting(pool, today);
  await refreshBalances(pool, today);
  return inTransaction(
    pool,
    async (db) => {
      await actor(db, req);
      // Check before applying monetary filters: a missing balance must never be
      // filtered out and silently disappear from the count or total.
      const stale = await db.query(
        `SELECT 1 FROM han_data.documents d LEFT JOIN han_data.document_balances b ON b.document_id=d.id
        WHERE d.active AND (b.document_id IS NULL OR b.source_revision<>d.revision OR b.valid_until<$1 OR b.calculation_version<>$2) LIMIT 1`,
        [today, calculationVersion],
      );
      if (stale.rows.length)
        throw Object.assign(Error('Toplamlar güncelleniyor. Tekrar deneyin.'), { status: 409 });
      const where = ' WHERE ' + f.conditions.join(' AND ');
      const {
        rows: [totals],
      } = await db.query(
        `SELECT count(*)::text AS count,
      coalesce(sum(b.principal_cents),0)::text AS principalCents,coalesce(sum(b.target_cents),0)::text AS targetCents,
      coalesce(sum(b.received_cents),0)::text AS receivedCents,coalesce(sum(b.remaining_cents),0)::text AS remainingCents,
      count(*) FILTER(WHERE b.document_id IS NULL OR b.source_revision<>d.revision OR b.valid_until<$${f.params.length + 1} OR b.calculation_version<>$${f.params.length + 2})::int AS stale
      ${from}${where}`,
        [...f.params, today, calculationVersion],
      );
      if (totals.stale)
        throw Object.assign(Error('Toplamlar güncelleniyor. Tekrar deneyin.'), { status: 409 });
      const pageParams = [...f.params],
        pageConditions = [...f.conditions];
      const { rows: counts } = await db.query(
        `SELECT d.status,count(*)::text AS count ${from} WHERE ${f.statusConditions.join(' AND ')} GROUP BY d.status`,
        f.statusParams,
      );
      const order = pageOrder(f, pageParams, pageConditions);
      pageParams.push(f.limit + 1);
      const { rows } = await db.query(
        `SELECT d.id,d.number,d.status,CASE WHEN jsonb_typeof(d.body->'receivables')='array' THEN 'Alacak Föyü' ELSE d.kind END AS kind,d.client_id AS "clientId",c.name AS "clientName",
      d.body->>'debtor' AS debtor,d.body->>'identity' AS identity,d.body->'testRecord' AS "testRecord",d.staff_id AS "staffId",d.due_on AS due,d.tracking_on AS "trackingDate",
      d.body->>'relatedStaffName' AS "relatedStaffName",p.body->>'name' AS "staffName",b.closed_on AS "closedDate",
      (${order.expression})::text AS "sortValue",d.revision::text AS revision,b.principal_cents::text AS "principalCents",b.target_cents::text AS "targetCents",
      b.received_cents::text AS "receivedCents",b.remaining_cents::text AS "remainingCents"
      ${from} WHERE ${pageConditions.join(' AND ')} ORDER BY ${order.order} LIMIT $${pageParams.length}`,
        pageParams,
      );
      return {
        items: rows.slice(0, f.limit),
        next: rows.length > f.limit ? nextCursor(f, rows[f.limit - 1]) : null,
        totals: {
          count: totals.count,
          principalCents: totals.principalcents,
          targetCents: totals.targetcents,
          receivedCents: totals.receivedcents,
          remainingCents: totals.remainingcents,
        },
        calculatedOn: today,
        statusCounts: Object.fromEntries(counts.map((r) => [r.status, r.count])),
      };
    },
    { readOnly: true },
  );
}
async function documentDetail(
  pool,
  req,
  id,
  { section = 'record', after = '', limit = 50, attachmentId = '' } = {},
) {
  if (
    typeof id !== 'string' ||
    id.length > 160 ||
    !['record', 'context', 'conversations', 'attachments', 'attachment', 'finance'].includes(section)
  )
    throw invalid('Geçersiz dosya isteği.');
  limit = Number(limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('Geçersiz sayfa boyutu.');
  return inTransaction(
    pool,
    async (db) => {
      await actor(db, req);
      const {
        rows: [row],
      } = await db.query('SELECT body,revision::text FROM han_data.documents WHERE id=$1 AND active', [id]);
      if (!row) throw Object.assign(Error('Dosya bulunamadı.'), { status: 404 });
      if (section === 'record') return { record: row.body, revision: row.revision };
      if (section === 'attachment') {
        if (typeof attachmentId !== 'string' || attachmentId.length > 250) throw invalid('Geçersiz ek.');
        const {
          rows: [attachment],
        } = await db.query(
          'SELECT body FROM han_data.attachments WHERE active AND document_id=$1 AND id=$2',
          [id, attachmentId],
        );
        if (!attachment) throw Object.assign(Error('Ek bulunamadı.'), { status: 404 });
        return attachment.body;
      }
      if (section === 'context') {
        const clientId = row.body.client || row.body.clientId;
        const data = await require('./storage.cjs').load(db, {
          tables: ['clients', 'documents', 'financial_events', 'ledger_entries', 'conversations'],
          documentIds: [id],
          clientIds: clientId ? [clientId] : [],
        });
        const state = require('./codec.cjs').join(data.metadata, data.rows);
        return {
          record: state.data['icrapro-v1'].docs[0],
          client: state.data['icrapro-v1'].clients[0] || null,
          financialEvents: state.data['hanhukuk-finance-v1'],
          ledgerEntries: state.data['hanhukuk-accounting-v1'].entries,
          accountBalances: await require('./accounts.cjs').accountBalances(db),
          attachments: (
            await db.query(
              "SELECT id,body->>'field' AS field FROM han_data.attachments WHERE active AND document_id=$1 ORDER BY id",
              [id],
            )
          ).rows,
          revision: row.revision,
        };
      }
      const table = {
        conversations: 'conversations',
        attachments: 'attachments',
        finance: 'financial_events',
      }[section];
      const { rows } = await db.query(
        'SELECT id,body FROM han_data.' +
          table +
          ' WHERE active AND document_id=$1 AND id>$2 ORDER BY id LIMIT $3',
        [id, String(after), limit + 1],
      );
      return {
        items: rows.slice(0, limit).map((r) => (section === 'finance' ? r.body : { id: r.id, ...r.body })),
        next: rows.length > limit ? rows[limit - 1].id : null,
      };
    },
    { readOnly: true },
  );
}
module.exports = { actor, filter, documentPage, documentDetail };
