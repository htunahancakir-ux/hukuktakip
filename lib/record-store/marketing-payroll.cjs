const { isMarketing } = require('../../outputs/icrapro/marketing-bonus.cjs');
// Read minimal bonus dimensions, never attachments or a paginated browser cache.
async function marketingPayrollInputs(db, staff, startMonth, month, today) {
  const marketers = staff.filter(isMarketing);
  if (!marketers.length) return { docs: [], clients: [], payments: [] };
  const { rows: docs } = await db.query(
    `SELECT jsonb_build_object('id',d.id,'client',d.client_id,'docType',d.body->>'docType',
      'trackingDate',d.tracking_on,'created',d.body->>'created',
      'receivedById',d.body->>'receivedById','receivedBy',d.body->>'receivedBy',
      'amount',d.body->'amount','originalAmount',d.body->'originalAmount',
      'preTrackingPayment',d.body->'preTrackingPayment',
      'receivables',CASE WHEN jsonb_typeof(d.body->'receivables')='array' THEN
        (SELECT jsonb_agg(jsonb_build_object('id',i->>'id','docType',i->>'docType',
          'amount',i->'amount','originalAmount',i->'originalAmount',
          'preTrackingPayment',i->'preTrackingPayment','registeredOn',i->>'registeredOn'))
          FROM jsonb_array_elements(d.body->'receivables') i) ELSE NULL END) AS record
      FROM han_data.documents d WHERE d.active AND
      (d.body->>'receivedById'=ANY($1::text[]) OR d.body->>'receivedBy'=ANY($1::text[])
      OR lower(translate(trim(d.body->>'receivedBy'),'Iİ','ıi'))=ANY($2::text[])
      OR EXISTS(SELECT 1 FROM han_data.clients c WHERE c.active AND c.id=d.client_id
        AND c.body->>'documentStaff'=ANY($1::text[])))`,
    [
      marketers.map((p) => p.id),
      marketers.map((p) =>
        String(p.name || '')
          .trim()
          .toLocaleLowerCase('tr-TR'),
      ),
    ],
  );
  const { rows: clients } = await db.query(
    `SELECT jsonb_build_object('id',id,'name',name,'createdAt',body->>'createdAt',
      'documentStaff',body->>'documentStaff') AS record FROM han_data.clients
      WHERE active AND body->>'documentStaff'=ANY($1::text[])`,
    [marketers.map((p) => p.id)],
  );
  const { rows: payments } = await db.query(
    `SELECT document_id,left(occurred_on,10) AS date,sum(amount_cents)::text AS amount
      FROM han_data.financial_events WHERE active AND kind='payment' AND amount_cents>0
      AND occurred_on>=$1 AND occurred_on<$2 AND occurred_on<=$3 GROUP BY document_id,left(occurred_on,10)`,
    [startMonth + '-01', month + '-32', today],
  );
  return {
    docs: docs.map((r) => r.record),
    clients: clients.map((r) => r.record),
    payments: payments.map((r) => ({
      type: 'payment',
      documentId: r.document_id,
      date: r.date,
      amount: Number(r.amount),
    })),
  };
}
module.exports = { marketingPayrollInputs };
