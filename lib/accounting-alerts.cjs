const expensePool = require('./expense-pool.cjs');

// Shown on the accounting screen: the shared expense advance pool against its warning
// threshold, and installments / payment promises whose due date has passed.
const DEFAULT_POOL_THRESHOLD = 500000;
const MAX_ROWS = 200;

function poolThreshold(state) {
  const value = Number(state.data['icrapro-settings-v1']?.preferences?.expensePoolWarningCents);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_POOL_THRESHOLD;
}

function accountingAlerts(state, today) {
  const received = new Map();
  for (const event of state.data['hanhukuk-finance-v1'])
    if (event.type === 'payment')
      received.set(event.documentId, (received.get(event.documentId) || 0) + event.amount);
  const staff = new Map(state.data['icrapro-personnel-v1'].map((person) => [person.id, person.name]));
  const rows = [];
  for (const doc of state.data['icrapro-v1'].docs) {
    if (['İnfaz', 'İade'].includes(doc.status)) continue;
    const total = received.get(doc.id) || 0;
    const base = {
      documentId: doc.id,
      number: doc.number,
      debtor: doc.debtor,
      staffName: staff.get(doc.relatedStaff) || doc.relatedStaffName || 'Atanmadı',
    };
    const plan = doc.repaymentPlan;
    if (plan) {
      // Collections made after the plan settle its installments in due order.
      let paid = Math.max(0, total - Number(plan.receivedAtCreation || 0));
      for (const [index, installment] of (plan.installments || []).entries()) {
        const applied = Math.min(paid, installment.amount);
        paid -= applied;
        const remaining = installment.amount - applied;
        if (installment.due < today && remaining > 0)
          rows.push({ ...base, kind: 'installment', sequence: index + 1, due: installment.due, remaining });
      }
    }
    const promise = doc.paymentPromise;
    if (promise) {
      const remaining = Math.max(
        0,
        promise.amount - Math.max(0, total - Number(promise.receivedAtCreation || 0)),
      );
      if (promise.date < today && remaining > 0)
        rows.push({ ...base, kind: 'promise', due: promise.date, remaining });
    }
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
