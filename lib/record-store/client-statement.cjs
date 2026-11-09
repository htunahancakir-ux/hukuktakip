const { inTransaction } = require('../db-transaction.cjs');
const { actor } = require('./queries.cjs');
const { validDate } = require('../business-time.cjs');
async function clientStatement(pool, req, id, { start = '', end = '', offset = 0 } = {}) {
  offset = Number(offset);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 10000000 ||
    (start && !validDate(start)) ||
    (end && !validDate(end)) ||
    (start && end && start > end)
  )
    throw Object.assign(Error('Geçersiz ekstre filtresi.'), { status: 400 });
  return inTransaction(
    pool,
    async (db) => {
      const user = await actor(db, req);
      if (!['ceo', 'admin'].includes(user.role))
        throw Object.assign(Error('Finansal işlemler için yönetici yetkisi gerekli.'), { status: 403 });
      if (!(await db.query('SELECT id FROM han_data.clients WHERE active AND id=$1', [id])).rows.length)
        throw Object.assign(Error('Müvekkil bulunamadı.'), { status: 404 });
      const cte = `WITH payments AS (
      SELECT 'payment:'||e.id AS id,coalesce(e.occurred_on,'') AS date,
        coalesce(d.number,'—') AS number,coalesce(d.body->>'debtor','—') AS debtor,coalesce(d.status,'') AS status,
        e.amount_cents AS amount,
        concat_ws(' · ',coalesce(nullif(e.body->>'accountName',''),a.body->>'name','Belirtilmedi'),nullif(a.body->>'bank','')) AS bank,
        coalesce(e.body->>'note','') AS note,coalesce(e.body->>'createdAt','') AS created
      FROM han_data.ledger_entries e LEFT JOIN han_data.documents d ON d.id=e.document_id
      LEFT JOIN han_data.accounts a ON a.id=e.account_id
      WHERE e.active AND e.kind='clientPayout' AND coalesce(nullif(e.body->>'clientId',''),d.client_id)=$1
      UNION ALL
      SELECT 'legacy:'||d.id,'',coalesce(d.number,'—'),coalesce(d.body->>'debtor','—'),coalesce(d.status,''),
        round(coalesce(nullif(d.body->>'clientPaidAmount','')::numeric,0)*100),
        'Belirtilmedi','Eski kayıttaki toplam ödeme · Tarih ve gönderen hesap bilgisi bulunmuyor.',''
      FROM han_data.documents d WHERE d.active AND d.client_id=$1 AND coalesce(nullif(d.body->>'clientPaidAmount','')::numeric,0)>0
    ), filtered AS (SELECT * FROM payments WHERE ($2='' OR date>=$2) AND ($3='' OR (date<>'' AND date<=$3)))`;
      const params = [id, start, end];
      const {
        rows: [totals],
      } = await db.query(
        cte + ' SELECT count(*)::text AS count,coalesce(sum(amount),0)::text AS paid FROM filtered',
        params,
      );
      const { rows: items } = await db.query(
        cte +
          ' SELECT id,date,number,debtor,status,amount::text AS amount,bank,note FROM filtered ORDER BY date DESC,created DESC,id DESC LIMIT 50 OFFSET $4',
        [...params, offset],
      );
      return { items, totals, offset, more: BigInt(offset + items.length) < BigInt(totals.count) };
    },
    { readOnly: true },
  );
}
module.exports = { clientStatement };
