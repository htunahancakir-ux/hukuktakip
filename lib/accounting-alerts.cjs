const expensePool = require('./expense-pool.cjs');
const {
  openFile,
  receivedByDocument,
  installmentStates,
  promiseRemaining,
} = require('./payment-schedule.cjs');

// Shown on the accounting screen: the shared expense advance pool against its warning
// threshold, and installments / payment promises whose due date has passed.
const DEFAULT_POOL_THRESHOLD = 500000;
const MAX_ROWS = 200;

function poolThreshold(state) {
  const value = Number(state.data['icrapro-settings-v1']?.preferences?.expensePoolWarningCents);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_POOL_THRESHOLD;
}

function accountingAlerts(state, today) {
  const received = receivedByDocument(state.data['hanhukuk-finance-v1']);
  const staff = new Map(state.data['icrapro-personnel-v1'].map((person) => [person.id, person.name]));
  const rows = [];
  for (const doc of state.data['icrapro-v1'].docs) {
    if (!openFile(doc)) continue;
    const total = received.get(doc.id) || 0;
    const base = {
      documentId: doc.id,
      number: doc.number,
      debtor: doc.debtor,
      staffName: staff.get(doc.relatedStaff) || doc.relatedStaffName || 'Atanmadı',
    };
    for (const installment of doc.repaymentPlan ? installmentStates(doc.repaymentPlan, total) : [])
      if (installment.due < today && installment.remaining > 0)
        rows.push({
          ...base,
          kind: 'installment',
          sequence: installment.sequence,
          due: installment.due,
          remaining: installment.remaining,
        });
    const promise = doc.paymentPromise,
      owed = promise ? promiseRemaining(promise, total) : 0;
    if (promise && promise.date < today && owed > 0)
      rows.push({ ...base, kind: 'promise', due: promise.date, remaining: owed });
  }
  rows.sort(
    (a, b) =>
      String(a.due).localeCompare(String(b.due)) ||
      String(a.debtor || '').localeCompare(String(b.debtor || ''), 'tr'),
  );
  const remaining = rows.reduce((sum, row) => sum + row.remaining, 0);
  if (!Number.isSafeInteger(remaining)) throw Object.assign(Error('Toplam hesaplanamadı.'), { code: 400 });
  return {
    today,
    pool: { ...expensePool.summary(state), threshold: poolThreshold(state) },
    overdue: {
      count: rows.length,
      remaining,
      installments: rows.filter((row) => row.kind === 'installment').length,
      promises: rows.filter((row) => row.kind === 'promise').length,
      rows: rows.slice(0, MAX_ROWS),
    },
  };
}

module.exports = { accountingAlerts, DEFAULT_POOL_THRESHOLD };
