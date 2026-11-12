const { calculateCallcenterBonus } = require('./personnel-bonus.cjs');
const { calculateMarketingBonus } = require('./marketing-bonus.cjs');
function monthlyPayrollRows(state, month, today = month + '-31') {
  const calculated = [
    ...calculateCallcenterBonus(state, month),
    ...calculateMarketingBonus(state, month, today),
    ...require('./other-personnel-bonus.cjs').calculateOtherPersonnelBonus(state, month, today),
  ];
  return state.data['icrapro-personnel-v1'].map((p) => {
    const salary = Math.round(Number(p.officialSalary || 0) * 100),
      bonus1 = Math.round(Number(p.unofficialSalary || 0) * 100),
      bonus2 = calculated.find((r) => r.staffId === p.id)?.total ?? Math.round(Number(p.bonus || 0) * 100),
      dailyBonus = (state.dailyBonuses || [])
        .filter((e) => e.staffId === p.id && e.date.startsWith(month + '-'))
        .reduce((sum, e) => sum + e.amount, 0);
    return {
      staffId: p.id,
      name: p.name,
      department: p.department,
      active: p.active !== false,
      salary,
      bonus1,
      bonus2,
      dailyBonus,
      bonus2Details: calculated.find((r) => r.staffId === p.id) || {
        staffId: p.id,
        name: p.name,
        total: bonus2,
        manual: true,
      },
      total: salary + bonus1 + bonus2 + dailyBonus,
    };
  });
}
function syncPayrollPeriods(state, today) {
  const month = today.slice(0, 7);
  const previous = JSON.stringify({ month: state.payrollPeriodMonth, periods: state.payrollPeriods });
  state.payrollPeriods = state.payrollPeriods || {};
  let cursor = state.payrollPeriodMonth || month;
  if (cursor < month) {
    while (cursor < month) {
      if (!state.payrollPeriods[cursor]?.closed)
        state.payrollPeriods[cursor] = {
          month: cursor,
          rows: monthlyPayrollRows(state, cursor, today),
          closed: true,
          closedAt: today,
        };
      for (const p of state.data['icrapro-personnel-v1']) p.bonus = 0;
      const [y, m] = cursor.split('-').map(Number);
      cursor = m === 12 ? y + 1 + '-01' : y + '-' + String(m + 1).padStart(2, '0');
    }
  }
  state.payrollPeriodMonth = month;
  state.payrollPeriods[month] = { month, rows: monthlyPayrollRows(state, month, today), closed: false };
  const ledgerChanged = require('../../lib/personnel-ledger.cjs').syncPersonnelLedger(state, today);
  return (
    ledgerChanged ||
    previous !== JSON.stringify({ month: state.payrollPeriodMonth, periods: state.payrollPeriods })
  );
}
module.exports = { monthlyPayrollRows, syncPayrollPeriods };
