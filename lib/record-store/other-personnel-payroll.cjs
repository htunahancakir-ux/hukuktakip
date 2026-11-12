const { isOtherPersonnel } = require('../../outputs/icrapro/other-personnel-bonus.cjs');
async function otherPersonnelPayrollInputs(db, people, startMonth, today) {
  const other = people.filter(isOtherPersonnel);
  if (!other.length) return { docs: [], payments: [] };
  const { rows } = await db.query(
    `SELECT jsonb_build_object('id',d.id,'status',d.status,'closedDate',d.body->>'closedDate','receivedById',d.body->>'receivedById','receivedBy',d.body->>'receivedBy') AS record FROM han_data.documents d
 WHERE d.active AND d.status='İnfaz' AND (d.body->>'receivedById'=ANY($1::text[]) OR d.body->>'receivedBy'=ANY($1::text[]) OR regexp_replace(replace(lower(translate(trim(d.body->>'receivedBy'),'Iİ','ıi')),'ı','i'),'[[:space:]_-]+','','g')=ANY($2::text[]))
 AND coalesce(nullif(d.body->>'closedDate',''),(SELECT max(e.occurred_on) FROM han_data.financial_events e WHERE e.active AND e.kind='payment' AND e.document_id=d.id)) BETWEEN $3 AND $4`,
    [
      other.map((p) => p.id),
      other.map((p) =>
        String(p.name || '')
          .trim()
          .toLocaleLowerCase('tr-TR')
          .replaceAll('ı', 'i')
          .replace(/[\s_-]+/g, ''),
      ),
      startMonth + '-01',
      today,
    ],
  );
  const ids = rows.map((r) => r.record.id);
  if (!ids.length) return { docs: [], payments: [] };
  const { rows: payments } = await db.query(
    `SELECT document_id,sum(amount_cents)::text AS amount,max(occurred_on) AS date FROM han_data.financial_events WHERE active AND kind='payment' AND amount_cents>0 AND document_id=ANY($1::text[]) AND occurred_on<=$2 GROUP BY document_id`,
    [ids, today],
  );
  return {
    docs: rows.map((r) => r.record),
    payments: payments.map((r) => ({
      documentId: r.document_id,
      type: 'payment',
      amount: Number(r.amount),
      date: r.date,
    })),
  };
}
module.exports = { otherPersonnelPayrollInputs };
