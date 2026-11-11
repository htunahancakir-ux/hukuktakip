const START_MONTH = '2026-11';
const categories = ['Maaş', 'Prim', 'Maaş Avansı'];
const fail = (message, code = 400) => Object.assign(Error(message), { code, status: code });
const integer = (value) => {
  if (!Number.isSafeInteger(value)) throw fail('Personel tutarı güvenli sınırı aşıyor.');
  return value;
};
function syncPersonnelLedger(state, today) {
  if (today.slice(0, 7) < START_MONTH) return false;
  const before = JSON.stringify(state.personnelLedger);
  const ledger = (state.personnelLedger ||= {
    startMonth: START_MONTH,
    sequence: 0,
    applied: {},
    accruals: [],
  });
  for (const [month, period] of Object.entries(state.payrollPeriods || {}).sort()) {
    if (month < START_MONTH || month > today.slice(0, 7)) continue;
    for (const row of period.rows || []) {
      for (const [kind, label] of [
        ['salary', 'Maaş'],
        ['bonus1', 'Prim 1'],
        ['bonus2', 'Prim 2'],
        ['dailyBonus', 'Günlük Prim'],
      ]) {
        const key = JSON.stringify([row.staffId, month, kind]);
        if (row.active === false && !Object.hasOwn(ledger.applied, key)) continue;
        const earnedDaily =
          kind === 'dailyBonus' && !period.closed && Array.isArray(state.dailyBonuses)
            ? state.dailyBonuses
                .filter(
                  (event) =>
                    event.staffId === row.staffId &&
                    event.date.startsWith(month + '-') &&
                    event.date <= today,
                )
                .reduce((sum, event) => integer(sum + event.amount), 0)
            : null;
        const amount = integer(Number(earnedDaily ?? row[kind] ?? 0));
        const old = ledger.applied[key] || 0,
          delta = integer(amount - old);
        if (!delta) continue;
        const first = !Object.hasOwn(ledger.applied, key);
        const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
          .toISOString()
          .slice(0, 10);
        const date =
          first && ['salary', 'bonus1'].includes(kind) ? month + '-01' : period.closed ? lastDay : today;
        ledger.accruals.push({
          id: 'payroll-accrual-' + ++ledger.sequence,
          staffId: row.staffId,
          month,
          date,
          kind,
          amount: delta,
          note: label + (first ? ' hakedişi' : ' düzeltmesi'),
        });
        ledger.applied[key] = amount;
      }
    }
  }
  return before !== JSON.stringify(state.personnelLedger);
}
function details(state, staffId, today) {
  const person = state.data['icrapro-personnel-v1'].find((row) => row.id === staffId);
  if (!person) throw fail('Personel bulunamadı.', 404);
  const currentMonth = today.slice(0, 7),
    ledger = state.personnelLedger;
  const accruals = (ledger?.accruals || []).filter(
    (row) => row.staffId === staffId && row.month >= START_MONTH,
  );
  const payments = state.data['hanhukuk-accounting-v1'].entries.filter(
    (row) =>
      row.staffId === staffId &&
      row.payrollMonth >= START_MONTH &&
      row.type === 'out' &&
      ['salaryAdvance', 'salaryPayment'].includes(row.payrollKind),
  );
  const months = new Map();
  const get = (month) => {
    if (!months.has(month))
      months.set(month, {
        month,
        earned: 0,
        advance: 0,
        paid: 0,
        salary: 0,
        remaining: 0,
        payable: month < currentMonth,
      });
    return months.get(month);
  };
  for (const row of accruals) {
    const period = get(row.month);
    period.earned = integer(period.earned + row.amount);
    if (row.kind === 'salary') period.salary = integer(period.salary + row.amount);
  }
  for (const row of payments) {
    const period = get(row.payrollMonth);
    period[row.payrollKind === 'salaryAdvance' ? 'advance' : 'paid'] += row.amount;
  }
  for (const row of months.values()) row.remaining = integer(row.earned - row.advance - row.paid);
  const rows = [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
  const current = get(currentMonth),
    advanceUsed = payments.some(
      (row) => row.payrollMonth === currentMonth && row.payrollKind === 'salaryAdvance',
    );
  const events = [
    ...accruals.map((row) => ({ ...row, credit: row.amount, debit: 0 })),
    ...payments.map((row) => ({
      id: row.id,
      month: row.payrollMonth,
      date: row.date,
      kind: row.payrollKind,
      note: row.note,
      credit: 0,
      debit: row.amount,
      accountName:
        state.data['hanhukuk-accounting-v1'].accounts.find((account) => account.id === row.accountId)?.name ||
        row.accountName ||
        '',
      operatorName: row.operatorName,
    })),
  ].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.credit !== 0 ? 0 : 1) - (b.credit !== 0 ? 0 : 1) ||
      a.id.localeCompare(b.id, undefined, { numeric: true }),
  );
  let balance = 0;
  for (const row of events) {
    balance = integer(balance + row.credit - row.debit);
    row.balance = balance;
  }
  return {
    staffId,
    staffName: person.name,
    startMonth: START_MONTH,
    currentMonth,
    months: rows,
    events,
    balance,
    payable: rows.filter((row) => row.payable).reduce((sum, row) => sum + Math.max(0, row.remaining), 0),
    currentEarned: current.earned,
    currentRemaining: current.remaining,
    advanceUsed,
    advanceLimit: advanceUsed ? 0 : Math.max(0, Math.min(Math.floor(current.salary / 4), current.remaining)),
  };
}
function validatePayment(state, input, user, today) {
  if (input.type !== 'out' || !categories.includes(input.expenseCategory)) {
    if (input.payrollKind || input.payrollMonth)
      throw fail('Personel ödemesi için maaş veya maaş avansı giderini seçin.');
    return {};
  }
  if (!['ceo', 'admin'].includes(user.role))
    throw fail('Personel ödemelerini yalnızca CEO ve yönetici yapabilir.', 403);
  if (
    typeof input.staffId !== 'string' ||
    !input.staffId ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.payrollMonth || '')
  )
    throw fail('Personel ve hakediş dönemini seçin.');
  const data = details(state, input.staffId, today),
    current = today.slice(0, 7);
  if (input.payrollMonth < START_MONTH) throw fail('Cari hesap 1 Kasım 2026 tarihinden başlar.');
  const advance = input.expenseCategory === 'Maaş Avansı';
  if (advance) {
    if (input.payrollMonth !== current || input.date.slice(0, 7) !== current)
      throw fail('Maaş avansı yalnızca mevcut ay için verilebilir.');
    if (data.advanceUsed) throw fail('Bu personel bu ay maaş avansını zaten aldı.', 409);
    if (input.amount > data.advanceLimit) throw fail('Maaş avansı aylık maaşın dörtte birini (%25) aşamaz.');
  } else {
    if (input.payrollMonth >= current || input.payrollMonth >= input.date.slice(0, 7))
      throw fail('Mevcut ayın hakedişi maaş olarak ödenemez. Kapanmış bir ay seçin.');
    const month = data.months.find((row) => row.month === input.payrollMonth);
    if (!month || input.amount > month.remaining)
      throw fail('Ödeme seçilen ayın kalan personel alacağını aşamaz.');
  }
  return {
    staffId: input.staffId,
    staffName: data.staffName,
    payrollMonth: input.payrollMonth,
    payrollKind: advance ? 'salaryAdvance' : 'salaryPayment',
  };
}
function assertPaymentChanges(before, next, user, today) {
  const old = new Map(before.data['hanhukuk-accounting-v1'].entries.map((row) => [row.id, row]));
  const entries = next.data['hanhukuk-accounting-v1'].entries;
  const working = {
    ...next,
    data: {
      ...next.data,
      'hanhukuk-accounting-v1': {
        ...next.data['hanhukuk-accounting-v1'],
        entries: entries.filter((row) => old.has(row.id)),
      },
    },
  };
  for (const entry of entries) {
    const prior = old.get(entry.id);
    if (
      prior?.payrollKind &&
      [
        'amount',
        'date',
        'accountId',
        'staffId',
        'payrollMonth',
        'payrollKind',
        'expenseCategory',
        'type',
      ].some((field) => entry[field] !== prior[field])
    )
      throw fail(
        'Personel ödemesinin finansal bilgileri değiştirilemez. Önce hatalı işlemi yetkili silme ekranından düzeltin.',
        409,
      );
    if (prior) continue;
    const payroll = validatePayment(working, entry, user, today);
    Object.assign(entry, payroll);
    working.data['hanhukuk-accounting-v1'].entries.push(entry);
  }
}
module.exports = {
  START_MONTH,
  categories,
  syncPersonnelLedger,
  details,
  validatePayment,
  assertPaymentChanges,
};
