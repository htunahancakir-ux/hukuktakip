const { isDeepStrictEqual } = require('node:util');
function validateNewClientPayouts(state, next, actor, accountBalances) {
  const old = state.data['hanhukuk-accounting-v1'];
  if (!Array.isArray(next?.entries)) throw Object.assign(Error('Geçersiz muhasebe kaydı.'), { code: 400 });
  const ids = new Set(old.entries.map((e) => e.id));
  const added = next.entries.filter((e) => !ids.has(e.id));
  if (!added.some((e) => e.type === 'clientPayout')) return;
  const fail = (message) => {
    throw Object.assign(Error(message), { code: 400 });
  };
  if (
    !isDeepStrictEqual(old.accounts, next.accounts) ||
    added.some((e) => e.type !== 'clientPayout') ||
    old.entries.some(
      (e) =>
        !isDeepStrictEqual(
          e,
          next.entries.find((n) => n.id === e.id),
        ),
    ) ||
    new Set(next.entries.map((e) => e.id)).size !== next.entries.length
  )
    fail('Ödeme sırasında diğer muhasebe kayıtlarını değiştirmeyin. Sayfayı yenileyin.');
  const cents = (v) => Math.round(Number(v || 0) * 100);
  const events = state.data['hanhukuk-finance-v1'];
  const balances = new Map(old.accounts.map((a) => [a.id, 0]));
  for (const e of old.entries) {
    if (balances.has(e.accountId))
      balances.set(e.accountId, balances.get(e.accountId) + (e.type === 'in' ? e.amount : -e.amount));
    if (e.type === 'transfer' && balances.has(e.destination))
      balances.set(e.destination, balances.get(e.destination) + e.amount);
  }
  for (const e of events)
    if (!(old.excludedFinanceIds || []).includes(e.id) && balances.has(e.accountId))
      balances.set(e.accountId, balances.get(e.accountId) + (e.type === 'payment' ? e.amount : -e.amount));
  const paidNow = new Map();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(new Date());
  for (const e of added) {
    const d = state.data['icrapro-v1'].docs.find((d) => d.id === e.documentId);
    if (!d || d.client !== e.clientId || d.status !== 'İnfaz')
      fail('Ödeme için uygun bir infaz dosyası seçin.');
    const parking = d.docType === 'Yediemin Park Ücreti';
    const related = events.filter((x) => x.documentId === d.id);
    const received = related.filter((x) => x.type === 'payment').reduce((s, x) => s + x.amount, 0);
    const expenses = parking
      ? 0
      : related.filter((x) => x.type === 'expense').reduce((s, x) => s + x.amount, 0);
    const principal = cents(d.amount);
    const target = Math.max(
      0,
      principal +
        (parking ? 0 : cents(d.financeInterest) + cents(d.financeFee) + expenses) -
        Number(d.debtDiscountCents || 0),
    );
    if (received < target) fail('Müvekkil ödemesi için borçlu bakiyesi kapanmış olmalıdır.');
    const rate = Number(d.parkingCommissionRate);
    if (
      parking &&
      (d.parkingCommissionRate == null ||
        d.parkingCommissionRate === '' ||
        !Number.isFinite(rate) ||
        rate < 0 ||
        rate > 100)
    )
      fail('Yediemin ofis payı geçersiz.');
    const entitlement = parking ? Math.max(0, received - Math.round((received * rate) / 100)) : principal;
    const paid =
      cents(d.clientPaidAmount) +
      old.entries
        .filter((x) => x.type === 'clientPayout' && x.documentId === d.id)
        .reduce((s, x) => s + x.amount, 0) +
      (paidNow.get(d.id) || 0);
    const remaining = Math.max(0, entitlement - paid);
    if (
      !Number.isSafeInteger(e.amount) ||
      e.amount <= 0 ||
      !Number.isSafeInteger(remaining) ||
      e.amount > remaining
    )
      fail('Ödeme tutarı sıfırdan büyük olmalı ve müvekkile kalan tutarı aşmamalıdır.');
    const account = old.accounts.find((a) => a.id === e.accountId);
    const balance = accountBalances ? BigInt(accountBalances[e.accountId] || '0') : balances.get(e.accountId);
    if (
      !account ||
      (accountBalances ? balance < BigInt(e.amount) : !Number.isSafeInteger(balance) || balance < e.amount)
    )
      fail('Seçilen hesapta yeterli bakiye yok.');
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ||
      !Number.isFinite(Date.parse(e.date)) ||
      new Date(e.date + 'T00:00:00Z').toISOString().slice(0, 10) !== e.date ||
      e.date > today ||
      (d.closedDate && e.date < d.closedDate)
    )
      fail('Geçerli bir ödeme tarihi girin.');
    if (!String(e.note || '').trim()) fail('Ödeme açıklamasını girin.');
    e.operatorId = actor.id;
    e.operatorName = actor.name;
    e.accountName = account.name;
    e.note = String(e.note).trim();
    e.createdAt = new Date().toISOString();
    paidNow.set(d.id, (paidNow.get(d.id) || 0) + e.amount);
    if (accountBalances) accountBalances[e.accountId] = String(balance - BigInt(e.amount));
    else balances.set(e.accountId, balance - e.amount);
  }
}
function appendClientPayout(state, input, actor, accountBalances) {
  const reject = (code, message) => {
    throw Object.assign(Error(message), { code });
  };
  if (!require('./accounting-access.cjs').accountingAllowed(actor, state.data['icrapro-personnel-v1']))
    reject(403, 'Muhasebe yetkisi gerekli.');
  if (typeof input?.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.id))
    reject(400, 'Geçerli ödeme işlem numarası gerekli.');
  const entry = {
    id: input.id,
    type: 'clientPayout',
    documentId: input.documentId,
    clientId: input.clientId,
    accountId: input.accountId,
    amount: input.amount,
    date: input.date,
    note: String(input.note || '').trim(),
  };
  const old = state.data['hanhukuk-accounting-v1'];
  const existing = old.entries.find((e) => e.id === entry.id);
  if (existing) {
    if (
      !Object.keys(entry).every((key) =>
        key === 'note'
          ? require('./test-records.cjs').matchesNote(existing, entry.note)
          : existing[key] === entry[key],
      )
    )
      reject(409, 'Bu işlem numarası farklı bir ödeme için kullanılmış.');
    return null; // A retry of a committed request must never create a second payment.
  }
  const next = structuredClone(state);
  const ledger = next.data['hanhukuk-accounting-v1'];
  ledger.entries.push(entry);
  validateNewClientPayouts(state, ledger, actor, accountBalances && { ...accountBalances });
  return next;
}
module.exports = { validateNewClientPayouts, appendClientPayout };
