const { isDeepStrictEqual } = require('node:util');
const { businessDate, validDate } = require('./business-time.cjs');

const fail = (code, message) => Object.assign(Error(message), { code });
const funding = (row) => row.expensePoolFunding === true;
const allocation = (row) => row.expensePoolAllocation === true;

function summary(state) {
  const ledger = state.data['hanhukuk-accounting-v1'];
  const events = state.data['hanhukuk-finance-v1'];
  const funded = ledger.entries.filter(funding).reduce((sum, row) => sum + row.amount, 0);
  const allocated = events.filter(allocation).reduce((sum, row) => sum + row.amount, 0);
  if (![funded, allocated, funded - allocated].every(Number.isSafeInteger))
    throw fail(400, 'Masraf avansı toplamı hesaplanamadı.');
  return { funded, allocated, balance: funded - allocated };
}

function details(state) {
  const docs = new Map(state.data['icrapro-v1'].docs.map((doc) => [doc.id, doc]));
  const deposits = state.data['hanhukuk-accounting-v1'].entries.filter(funding).map((row) => ({
    id: row.id,
    kind: 'fund',
    date: row.date,
    amount: row.amount,
    note: row.note,
    operatorName: row.operatorName,
    accountId: row.accountId,
    createdAt: row.createdAt,
  }));
  const uses = state.data['hanhukuk-finance-v1'].filter(allocation).map((row) => ({
    id: row.id,
    kind: 'allocation',
    date: row.date,
    amount: row.amount,
    note: row.note,
    operatorName: row.operatorName,
    documentId: row.documentId,
    documentNumber: docs.get(row.documentId)?.number || '',
    type: row.type,
    createdAt: row.createdAt,
  }));
  return {
    ...summary(state),
    movements: [...deposits, ...uses].sort(
      (a, b) =>
        String(b.date).localeCompare(String(a.date)) ||
        String(b.createdAt).localeCompare(String(a.createdAt)),
    ),
  };
}

function assertNonnegativeHistory(state) {
  const ledger = state.data['hanhukuk-accounting-v1'];
  const events = state.data['hanhukuk-finance-v1'];
  const rows = [
    ...ledger.entries.filter(funding).map((row) => ({ date: row.date, delta: BigInt(row.amount), order: 0 })),
    ...events.filter(allocation).map((row) => ({ date: row.date, delta: -BigInt(row.amount), order: 1 })),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.order - b.order);
  let balance = 0n;
  for (const row of rows) {
    balance += row.delta;
    if (balance < 0n) throw fail(400, 'Seçilen tarihte masraf avansında yeterli bakiye yok.');
  }
}

function parse(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'Geçersiz işlem.');
  const id = input.id,
    amount = input.amount,
    note = typeof input.note === 'string' ? input.note.trim() : '';
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw fail(400, 'Geçersiz işlem numarası.');
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !note ||
    note.length > 3000 ||
    typeof input.date !== 'string' ||
    !validDate(input.date) ||
    input.date > businessDate()
  )
    throw fail(400, 'Geçerli tutar, tarih ve açıklama girin.');
  return { id, amount, note, date: input.date };
}

function fund(state, input, user, allowed, ledgerBalance) {
  if (!allowed(user, 'cashOut')) throw fail(403, 'Kasa çıkışı yetkiniz yok.');
  const value = parse(input),
    ledger = state.data['hanhukuk-accounting-v1'];
  const account = ledger.accounts.find((a) => a.id === input.accountId);
  if (!account) throw fail(400, 'Kaynak kasa veya banka seçin.');
  const existing = ledger.entries.find((row) => row.id === value.id);
  if (existing) {
    if (
      !funding(existing) ||
      existing.operatorId !== user.id ||
      ['amount', 'date', 'note'].some((key) =>
        key === 'note'
          ? !require('./test-records.cjs').matchesNote(existing, value.note)
          : existing[key] !== value[key],
      ) ||
      existing.accountId !== account.id
    )
      throw fail(409, 'İşlem numarası başka bir kayıtta kullanılmış.');
    return { next: null, entry: existing };
  }
  const available = ledgerBalance(account.id);
  if (!Number.isSafeInteger(available)) throw fail(400, 'Kaynak hesap bakiyesi doğrulanamadı.');
  if (available < value.amount) throw fail(400, 'Seçilen hesapta yeterli bakiye yok.');
  const entry = {
    ...value,
    type: 'out',
    expenseCategory: 'Masraf',
    expensePoolFunding: true,
    accountId: account.id,
    operatorId: user.id,
    operatorName: user.name,
    createdAt: new Date().toISOString(),
  };
  const next = structuredClone(state);
  next.data['hanhukuk-accounting-v1'].entries.push(entry);
  summary(next);
  return { next, entry };
}

function allocate(state, input, user, allowed) {
  if (!allowed(user, 'documents')) throw fail(403, 'Dosya işlem yetkiniz yok.');
  const value = parse(input),
    events = state.data['hanhukuk-finance-v1'];
  if (!['expense', 'costOnly'].includes(input.type)) throw fail(400, 'Masraf işlemini seçin.');
  const doc = state.data['icrapro-v1'].docs.find((d) => d.id === input.documentId);
  if (!doc) throw fail(404, 'Borçlu dosyası bulunamadı.');
  const existing = events.find((row) => row.id === value.id);
  if (existing) {
    if (
      !allocation(existing) ||
      existing.operatorId !== user.id ||
      existing.documentId !== doc.id ||
      existing.type !== input.type ||
      ['amount', 'date', 'note'].some((key) =>
        key === 'note'
          ? !require('./test-records.cjs').matchesNote(existing, value.note)
          : existing[key] !== value[key],
      )
    )
      throw fail(409, 'İşlem numarası başka bir kayıtta kullanılmış.');
    return { next: null, event: existing };
  }
  if (input.type === 'expense' && (doc.status === 'İnfaz' || doc.docType === 'Yediemin Park Ücreti'))
    throw fail(400, 'Bu dosyada masraf borca eklenemez.');
  const last = events
    .filter((e) => e.documentId === doc.id)
    .map((e) => e.date || '')
    .sort()
    .at(-1);
  if (last && value.date < last) throw fail(400, 'Dosyanın son işleminden önce masraf girilemez.');
  if (value.amount > summary(state).balance) throw fail(400, 'Masraf avansında yeterli bakiye yok.');
  const event = {
    ...value,
    documentId: doc.id,
    type: input.type,
    expensePoolAllocation: true,
    accountName: 'Masraf Avansı',
    operatorId: user.id,
    operatorName: user.name,
    createdAt: new Date().toISOString(),
  };
  const next = structuredClone(state);
  next.data['hanhukuk-finance-v1'].push(event);
  assertNonnegativeHistory(next);
  return { next, event };
}

function guardGenericChanges(before, key, value) {
  const isFinance = key === 'hanhukuk-finance-v1';
  if (!isFinance && key !== 'hanhukuk-accounting-v1') return;
  const old = isFinance ? before.data[key] : before.data[key].entries;
  const updated = isFinance ? value : value?.entries;
  if (!Array.isArray(updated)) return;
  const flag = isFinance ? allocation : funding;
  const previous = new Map(old.filter(flag).map((row) => [row.id, row]));
  const incoming = new Map(updated.filter(flag).map((row) => [row.id, row]));
  for (const id of new Set([...previous.keys(), ...incoming.keys()]))
    if (!isDeepStrictEqual(previous.get(id), incoming.get(id)))
      throw fail(403, 'Masraf avansı işlemlerini bu ekrandan değiştiremezsiniz.');
}

module.exports = {
  summary,
  details,
  fund,
  allocate,
  guardGenericChanges,
  funding,
  allocation,
  assertNonnegativeHistory,
};
