const { isDeepStrictEqual } = require('node:util');
const { businessDate, validDate } = require('./business-time.cjs');
const fail = (message, code = 400) => Object.assign(Error(message), { code, status: code });
const requests = (state) => state.externalOutRequests || [];
const idOK = (id) => typeof id === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(id);
const entryId = (id) => 'external-out-' + id;
function request(state, input, user) {
  if (
    !idOK(input?.id) ||
    !Number.isSafeInteger(input.amount) ||
    input.amount <= 0 ||
    !validDate(input.date) ||
    input.date > businessDate() ||
    !['yes', 'no'].includes(input.profitChoice) ||
    typeof input.note !== 'string' ||
    !input.note.trim() ||
    input.note.length > 3000 ||
    input.expenseCategory
  )
    throw fail('Tarih, tutar, kâr seçimi ve açıklamayı tamamlayın. Gider kalemi seçilmez.');
  const ledger = state.data['hanhukuk-accounting-v1'];
  if (!ledger.accounts.some((a) => a.id === input.accountId && a.active !== false))
    throw fail('Aktif kasa veya banka seçin.');
  const currentAccountId = require('./current-accounts.cjs').cashParty(
    state,
    input.currentAccountId,
    'externalOut',
  );
  const fields = {
    id: input.id,
    accountId: input.accountId,
    amount: input.amount,
    date: input.date,
    includeInProfit: input.profitChoice === 'yes',
    note: input.note.trim(),
    currentAccountId,
  };
  const old = requests(state).find((r) => r.id === input.id);
  if (old) {
    if (old.requestedBy !== user.id || !Object.entries(fields).every(([k, v]) => old[k] === v))
      throw fail('Talep numarası başka bir işlemde kullanılmış.', 409);
    return { next: null, request: old };
  }
  const row = {
    ...fields,
    status: 'pending',
    requestedBy: user.id,
    requestedByName: user.name,
    createdAt: new Date().toISOString(),
  };
  const next = structuredClone(state);
  next.externalOutRequests = requests(next).concat(row);
  return { next, request: row };
}
function decide(state, input, user, balances, legacyBalance) {
  if (user.role !== 'ceo')
    throw fail('Harici para çıkışını yalnızca CEO onaylayabilir veya reddedebilir.', 403);
  if (!idOK(input?.id) || !['approve', 'reject'].includes(input.action))
    throw fail('Geçerli talep ve işlem seçin.');
  const original = requests(state).find((r) => r.id === input.id);
  if (!original) throw fail('Talep bulunamadı.', 404);
  const status = input.action === 'approve' ? 'approved' : 'rejected';
  if (original.status === status) return { next: null, request: original };
  if (original.status !== 'pending') throw fail('Bu talep daha önce sonuçlandırılmış.', 409);
  const next = structuredClone(state),
    row = next.externalOutRequests.find((r) => r.id === input.id);
  if (status === 'approved') {
    const ledger = next.data['hanhukuk-accounting-v1'];
    if (!ledger.accounts.some((a) => a.id === row.accountId && a.active !== false))
      throw fail('Talebin kasa/bankası artık aktif değil.', 409);
    const amount = balances ? balances[row.accountId] : legacyBalance(row.accountId);
    if (typeof amount === 'number' && !Number.isSafeInteger(amount))
      throw fail('Hesap bakiyesi doğrulanamadı.', 409);
    if (amount === undefined || BigInt(amount) < BigInt(row.amount))
      throw fail('Seçilen hesapta yeterli bakiye yok. Talep onay beklemeye devam ediyor.', 409);
    if (ledger.entries.some((e) => e.id === entryId(row.id)))
      throw fail('İşlem numarası zaten kayıtlı.', 409);
    if (row.currentAccountId) require('./current-accounts.cjs').findParty(next, row.currentAccountId, true);
    ledger.entries.push({
      id: entryId(row.id),
      type: 'externalOut',
      accountId: row.accountId,
      amount: row.amount,
      date: row.date,
      note: row.note,
      includeInProfit: row.includeInProfit,
      externalOutRequestId: row.id,
      ...(row.currentAccountId ? { currentAccountId: row.currentAccountId } : {}),
      operatorId: row.requestedBy,
      operatorName: row.requestedByName,
      approvedBy: user.id,
      approvedByName: user.name,
      createdAt: new Date().toISOString(),
    });
  }
  row.status = status;
  row.decidedBy = user.id;
  row.decidedByName = user.name;
  row.decidedAt = new Date().toISOString();
  return { next, request: row };
}
function assertChanges(before, after, user) {
  const oldRequests = new Map(requests(before).map((r) => [r.id, r]));
  const newRequests = new Map(requests(after).map((r) => [r.id, r]));
  for (const [id, old] of oldRequests) {
    const next = newRequests.get(id);
    if (!next) throw fail('Harici çıkış talepleri silinemez.', 403);
    if (isDeepStrictEqual(old, next)) continue;
    if (
      user.role !== 'ceo' ||
      old.status !== 'pending' ||
      !['approved', 'rejected'].includes(next.status) ||
      next.decidedBy !== user.id ||
      Object.keys(old)
        .filter((k) => k !== 'status')
        .some((k) => !isDeepStrictEqual(old[k], next[k]))
    )
      throw fail('Harici çıkışın onay bilgileri değiştirilemez.', 403);
    if (
      next.status === 'approved' &&
      !after.data['hanhukuk-accounting-v1'].entries.some((e) => e.id === entryId(id))
    )
      throw fail('Onaylanan harici çıkışın para hareketi eksik.', 409);
  }
  const previous = new Map(before.data['hanhukuk-accounting-v1'].entries.map((e) => [e.id, e]));
  for (const e of after.data['hanhukuk-accounting-v1'].entries) {
    const old = previous.get(e.id);
    if (old?.type === 'externalOut') {
      if (
        [
          'type',
          'amount',
          'accountId',
          'date',
          'includeInProfit',
          'externalOutRequestId',
          'approvedBy',
          'approvedByName',
          'note',
          'operatorId',
          'operatorName',
        ].some((k) => !isDeepStrictEqual(e[k], old[k]))
      )
        throw fail('Onaylı harici çıkışın finansal bilgileri değiştirilemez.', 403);
      continue;
    }
    if (e.type !== 'externalOut') continue;
    const request = newRequests.get(e.externalOutRequestId),
      prior = oldRequests.get(e.externalOutRequestId);
    if (
      old ||
      user.role !== 'ceo' ||
      prior?.status !== 'pending' ||
      request?.status !== 'approved' ||
      e.id !== entryId(request.id) ||
      request.decidedBy !== user.id ||
      e.approvedBy !== user.id ||
      e.expenseCategory ||
      ['amount', 'accountId', 'date', 'includeInProfit', 'note'].some((k) => e[k] !== request[k]) ||
      (e.currentAccountId || '') !== request.currentAccountId ||
      e.operatorId !== request.requestedBy
    )
      throw fail('Harici para çıkışı CEO onayından oluşturulmalıdır.', 403);
  }
}
module.exports = { requests, request, decide, assertChanges, entryId };
