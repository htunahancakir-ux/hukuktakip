const { randomUUID } = require('node:crypto');
const { businessDate, validDate } = require('./business-time.cjs');
const { expenseCategories } = require('../outputs/icrapro/accounting-rules.js');
const fail = (code, message) => Object.assign(Error(message), { code });
function appendCashEntry(state, input, user, allowed, balances, legacyBalance) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'Geçersiz işlem.');
  const external = input.type === 'external',
    type = external ? 'in' : input.type;
  if (!['in', 'out', 'advance', 'transfer'].includes(type)) throw fail(400, 'Geçersiz işlem türü.');
  if (
    type === 'transfer'
      ? !require('./accounting-access.cjs').accountingAllowed(user, state.data['icrapro-personnel-v1'])
      : !allowed(user, type === 'in' ? 'cashIn' : 'cashOut')
  )
    throw fail(403, 'Bu para işlemi için yetkiniz yok.');
  const id = input.id ?? randomUUID();
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw fail(400, 'Geçersiz işlem numarası.');
  const amount = Number(input.amount),
    ledger = state.data['hanhukuk-accounting-v1'];
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    typeof input.note !== 'string' ||
    !input.note.trim() ||
    input.note.length > 3000 ||
    !validDate(input.date) ||
    input.date > businessDate()
  )
    throw fail(400, 'Geçerli tutar, tarih ve açıklama girin.');
  if (external && !['yes', 'no'].includes(input.profitChoice)) throw fail(400, 'Kâr seçimini yapın.');
  if (type === 'out' && !expenseCategories.includes(input.expenseCategory))
    throw fail(400, 'Gider kalemi seçin.');
  if (type === 'advance' && !['T.Ç', 'S.S', 'Diğer'].includes(input.advanceType))
    throw fail(400, 'Avans türünü seçin.');
  const entry = {
    id,
    type,
    amount,
    accountId: input.accountId,
    date: input.date,
    note: input.note.trim(),
    ...(type === 'transfer' ? { destination: input.destination } : {}),
    ...(type === 'out' ? { expenseCategory: input.expenseCategory } : {}),
    ...(type === 'advance' ? { advanceType: input.advanceType } : {}),
    ...(external ? { entryKind: 'external' } : {}),
    includeInProfit: external && input.profitChoice === 'yes',
  };
  const existing = ledger.entries.find((e) => e.id === id);
  if (existing) {
    if (
      (require('./personnel-ledger.cjs').categories.includes(input.expenseCategory) &&
        (existing.staffId !== input.staffId || existing.payrollMonth !== input.payrollMonth)) ||
      existing.operatorId !== user.id ||
      Object.keys(entry).some((k) =>
        k === 'note'
          ? !require('./test-records.cjs').matchesNote(existing, entry.note)
          : existing[k] !== entry[k],
      )
    )
      throw fail(409, 'Bu işlem numarası başka bir kayıtta kullanılmış.');
    return null;
  }
  if (!ledger.accounts.some((a) => a.id === input.accountId)) throw fail(400, 'Hesap seçin.');
  const payroll = require('./personnel-ledger.cjs').validatePayment(state, input, user, businessDate());
  if (
    type === 'transfer' &&
    (input.destination === input.accountId || !ledger.accounts.some((a) => a.id === input.destination))
  )
    throw fail(400, 'Farklı bir hedef hesap seçin.');
  const available = balances
    ? BigInt(balances[input.accountId] || '0')
    : BigInt(legacyBalance(input.accountId));
  if (type !== 'in' && available < BigInt(amount)) throw fail(400, 'Seçilen hesapta yeterli bakiye yok.');
  const next = structuredClone(state);
  next.data['hanhukuk-accounting-v1'].entries.push({
    ...entry,
    ...payroll,
    operatorId: user.id,
    operatorName: user.name,
    createdAt: new Date().toISOString(),
  });
  return next;
}
module.exports = { appendCashEntry };
