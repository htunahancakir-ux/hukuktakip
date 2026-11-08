const { applyParkingFee } = require('../../outputs/icrapro/parking-fees.js');
const { applyAutomaticLegalCharges } = require('../../outputs/icrapro/legal-charges.cjs');
const { businessDate } = require('../business-time.cjs');
const { inTransaction } = require('../db-transaction.cjs');
const fs = require('node:fs');
const crypto = require('node:crypto');
const calculationVersion = crypto
  .createHash('sha256')
  .update(
    [
      __filename,
      require.resolve('../../outputs/icrapro/parking-fees.js'),
      require.resolve('../../outputs/icrapro/legal-charges.cjs'),
    ]
      .map((file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
      .join('\n'),
  )
  .digest('hex');
function cents(value) {
  const result = Math.round(Number(value || 0) * 100);
  if (!Number.isSafeInteger(result)) throw Error('Para alanı güvenli kuruş sınırını aşıyor.');
  return BigInt(result);
}
function balance(document, events, today = businessDate()) {
  const doc = structuredClone(document);
  applyParkingFee(doc, today);
  applyAutomaticLegalCharges(doc, events, today);
  let received = 0n,
    expenses = 0n;
  for (const e of events) {
    if (e.documentId !== doc.id) continue;
    if (!Number.isSafeInteger(e.amount)) throw Error('Geçersiz hareket tutarı.');
    if (e.type === 'payment') received += BigInt(e.amount);
    if (e.type === 'expense') expenses += BigInt(e.amount);
  }
  const parking = doc.docType === 'Yediemin Park Ücreti',
    principal = cents(doc.amount);
  const dateDependent =
    !['İnfaz', 'İade'].includes(doc.status) &&
    (parking || (!!doc.due && !doc.repaymentPlan && !events.some((e) => e.type === 'payment')));
  if (parking) expenses = 0n;
  const raw =
    principal +
    (parking ? 0n : cents(doc.financeInterest) + cents(doc.financeFee) + expenses) -
    BigInt(doc.debtDiscountCents || 0);
  const target = raw > 0n ? raw : 0n,
    remaining = target > received ? target - received : 0n;
  return {
    principal_cents: String(principal),
    target_cents: String(target),
    received_cents: String(received),
    remaining_cents: String(remaining),
    expenses_cents: String(expenses),
    calculated_on: today,
    closed_on:
      doc.closedDate ||
      events
        .filter((e) => e.type === 'payment' && e.closes)
        .map((e) => e.date)
        .filter(Boolean)
        .sort()
        .at(-1) ||
      '',
    valid_until: dateDependent ? today : '9999-12-31',
    calculation_version: calculationVersion,
  };
}
async function refreshBalances(pool, today = businessDate()) {
  // Small bounded batches; never silently return a partial total. A failed refresh
  // causes an explicit error. Background maintenance can call this before reads.
  let refreshed = 0,
    after = '';
  for (;;) {
    const count = await inTransaction(pool, async (db) => {
      const { rows } = await db.query(
        `SELECT d.id,d.body,d.revision FROM han_data.documents d
        LEFT JOIN han_data.document_balances b ON b.document_id=d.id
        WHERE d.active AND d.id>$2 AND (b.document_id IS NULL OR b.source_revision<>d.revision OR b.valid_until<$1 OR b.calculation_version<>$3)
        ORDER BY d.id LIMIT 250 FOR UPDATE OF d`,
        [today, after, calculationVersion],
      );
      if (!rows.length) return 0;
      after = rows.at(-1).id;
      const { rows: events } = await db.query(
        'SELECT body FROM han_data.financial_events WHERE active AND document_id=ANY($1::text[])',
        [rows.map((r) => r.id)],
      );
      const grouped = new Map();
      for (const { body } of events) {
        if (!grouped.has(body.documentId)) grouped.set(body.documentId, []);
        grouped.get(body.documentId).push(body);
      }
      const values = rows.map((r) => ({
        document_id: r.id,
        source_revision: r.revision,
        ...balance(r.body, grouped.get(r.id) || [], today),
      }));
      await db.query(
        `INSERT INTO han_data.document_balances
        SELECT document_id,principal_cents,target_cents,received_cents,remaining_cents,expenses_cents,calculated_on,source_revision,closed_on,valid_until,calculation_version
        FROM jsonb_to_recordset($1::jsonb) AS b(document_id text,principal_cents bigint,target_cents bigint,received_cents bigint,
          remaining_cents bigint,expenses_cents bigint,calculated_on text,source_revision bigint,closed_on text,valid_until text,calculation_version text)
        ON CONFLICT(tenant_id,document_id) DO UPDATE SET principal_cents=EXCLUDED.principal_cents,target_cents=EXCLUDED.target_cents,
          received_cents=EXCLUDED.received_cents,remaining_cents=EXCLUDED.remaining_cents,expenses_cents=EXCLUDED.expenses_cents,
          calculated_on=EXCLUDED.calculated_on,source_revision=EXCLUDED.source_revision,closed_on=EXCLUDED.closed_on,
          valid_until=EXCLUDED.valid_until,calculation_version=EXCLUDED.calculation_version`,
        [JSON.stringify(values)],
      );
      return rows.length;
    });
    refreshed += count;
    if (count === 0) return refreshed;
  }
}
module.exports = { balance, refreshBalances, calculationVersion };
