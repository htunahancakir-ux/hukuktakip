const { isDeepStrictEqual } = require('node:util');
const { syncPayrollPeriods } = require('../../outputs/icrapro/payroll-periods.cjs');
const { businessDate } = require('../business-time.cjs');
function safeCents(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw Error('Prim toplamı güvenli kuruş sınırını aşıyor.');
  return n;
}
// Aggregate only the payroll dimensions the existing rules need. Previous
// closed periods remain immutable, and no browser page limits affect payroll.
async function refreshPayroll(db, today = businessDate()) {
  const {
    rows: [metadata],
  } = await db.query('SELECT body,revision FROM han_data.metadata WHERE id=1 FOR UPDATE');
  const { rows: personnel } = await db.query(
    'SELECT id,body,revision FROM han_data.personnel WHERE active ORDER BY ordinal,id',
  );
  const state = structuredClone(metadata.body);
  const month = today.slice(0, 7),
    startMonth = state.payrollPeriodMonth || month;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(startMonth) || startMonth > month)
    throw Error('Bordro dönemi geçersiz.');
  const { rows: collections } = await db.query(
    `SELECT
      coalesce(nullif(e.body->>'turnoverStaffId',''),nullif(e.body->>'collectionStaffId',''),d.staff_id) AS staff,
      left(e.occurred_on,7) AS month,
      CASE WHEN substring(e.occurred_on FROM 9 FOR 2)::int<=15 THEN '01' ELSE '16' END AS half,
      sum(e.amount_cents)::text AS amount
    FROM han_data.financial_events e LEFT JOIN han_data.documents d ON d.id=e.document_id
    WHERE e.active AND e.kind='payment' AND e.amount_cents>0 AND e.occurred_on>=$1 AND e.occurred_on<$2
    GROUP BY 1,2,3`,
    [startMonth + '-01', month + '-32'],
  );
  const { rows: daily } = await db.query(
    `SELECT body->>'staffId' AS staff,left(body->>'date',7) AS month,
    sum((body->>'amount')::bigint)::text AS amount FROM han_data.daily_bonuses
    WHERE active AND body->>'date'>=$1 AND body->>'date'<$2 AND body->>'date'<=$3 GROUP BY 1,2`,
    [startMonth + '-01', month + '-32', today],
  );
  state.data['icrapro-personnel-v1'] = personnel.map((r) => structuredClone(r.body));
  state.otherPersonnelPayrollInputs =
    await require('./other-personnel-payroll.cjs').otherPersonnelPayrollInputs(
      db,
      state.data['icrapro-personnel-v1'],
      startMonth,
      today,
    );
  state.marketingPayrollInputs = await require('./marketing-payroll.cjs').marketingPayrollInputs(
    db,
    state.data['icrapro-personnel-v1'],
    startMonth,
    month,
    today,
  );
  state.data['icrapro-v1'] = { clients: [], docs: [] };
  state.data['hanhukuk-finance-v1'] = collections.map((r, i) => ({
    id: 'payroll-' + i,
    type: 'payment',
    collectionStaffId: r.staff,
    date: r.month + '-' + r.half,
    amount: safeCents(r.amount),
  }));
  state.dailyBonuses = daily.map((r) => ({
    staffId: r.staff,
    date: r.month + '-01',
    amount: safeCents(r.amount),
  }));
  syncPayrollPeriods(state, today);
  const nextMeta = {
    ...metadata.body,
    payrollPeriods: state.payrollPeriods,
    payrollPeriodMonth: state.payrollPeriodMonth,
    personnelLedger: state.personnelLedger,
  };
  if (!isDeepStrictEqual(nextMeta, metadata.body))
    await db.query('UPDATE han_data.metadata SET body=$1::jsonb,revision=revision+1 WHERE id=1', [
      JSON.stringify(nextMeta),
    ]);
  for (let i = 0; i < personnel.length; i++) {
    const before = personnel[i],
      after = state.data['icrapro-personnel-v1'][i];
    if (!isDeepStrictEqual(before.body, after))
      await db.query(
        'UPDATE han_data.personnel SET body=$2::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1',
        [before.id, JSON.stringify(after)],
      );
  }
  return state.payrollPeriods;
}
module.exports = { refreshPayroll };
