const { isDeepStrictEqual } = require('node:util');
const { businessDate, validDate } = require('./business-time.cjs');
const external = require('./external-out.cjs');
const fail = (message, status = 400) => Object.assign(Error(message), { status, code: status });
const rows = (s) => s.cheques || [];
const idOK = (id) => typeof id === 'string' && /^[a-zA-Z0-9-]{1,56}$/.test(id);
const clean = (v, max) => {
  if (v !== undefined && typeof v !== 'string') throw fail('Geçersiz çek bilgisi.');
  const s = (v || '').trim();
  if (s.length > max) throw fail('Çek bilgisi çok uzun.');
  return s;
};
const requestId = (id) => 'cheque-' + id;
const ledgerId = (row) =>
  row.direction === 'received' ? requestId(row.id) : external.entryId(row.approvalRequestId);
function create(s, input, user) {
  if (
    !input ||
    !idOK(input.id) ||
    !['received', 'issued'].includes(input.direction) ||
    !Number.isSafeInteger(input.amount) ||
    input.amount <= 0 ||
    !validDate(input.date) ||
    input.date > businessDate() ||
    !validDate(input.chequeDate) ||
    !['yes', 'no'].includes(input.profitChoice) ||
    input.expenseCategory
  )
    throw fail('Çek türü, tutarı, işlem ve çek tarihi ile kâr seçimini tamamlayın.');
  if (!s.data['hanhukuk-accounting-v1'].accounts.some((a) => a.id === input.accountId && a.active !== false))
    throw fail('Aktif kasa veya banka seçin.');
  const fields = {
    id: input.id,
    direction: input.direction,
    accountId: input.accountId,
    amount: input.amount,
    date: input.date,
    chequeDate: input.chequeDate,
    bankName: clean(input.bankName, 200),
    holder: clean(input.holder, 200),
    number: clean(input.number, 80),
    description: clean(input.description, 1500),
    includeInProfit: input.profitChoice === 'yes',
    currentAccountId: require('./current-accounts.cjs').cashParty(
      s,
      input.currentAccountId,
      input.direction === 'received' ? 'in' : 'externalOut',
    ),
  };
  if (!fields.bankName || !fields.holder) throw fail('Banka ve çek sahibi bilgilerini girin.');
  const old = rows(s).find((r) => r.id === input.id);
  if (old) {
    if (old.createdBy !== user.id || !Object.entries(fields).every(([k, v]) => old[k] === v))
      throw fail('Çek kayıt numarası başka bir işlemde kullanılmış.', 409);
    return { next: null, cheque: old };
  }
  const row = {
    ...fields,
    createdBy: user.id,
    createdByName: user.name,
    createdAt: new Date().toISOString(),
  };
  const note =
    (row.direction === 'received' ? 'Alınan çek' : 'Verilen çek') +
    ' · ' +
    (row.number ? 'No: ' + row.number + ' · ' : '') +
    row.bankName +
    ' · ' +
    row.holder +
    ' · Çek tarihi: ' +
    row.chequeDate +
    (row.description ? ' · ' + row.description : '');
  let next;
  if (row.direction === 'issued') {
    const result = external.request(
      s,
      {
        id: requestId(row.id),
        accountId: row.accountId,
        date: row.date,
        amount: row.amount,
        note,
        profitChoice: input.profitChoice,
        currentAccountId: row.currentAccountId,
      },
      user,
    );
    if (!result.next) throw fail('Çek onay talebi zaten var.', 409);
    next = result.next;
    row.approvalRequestId = requestId(row.id);
    next.externalOutRequests.find((r) => r.id === row.approvalRequestId).chequeId = row.id;
  } else {
    next = structuredClone(s);
    if (next.data['hanhukuk-accounting-v1'].entries.some((e) => e.id === ledgerId(row)))
      throw fail('Çek işlem numarası zaten kullanılmış.', 409);
    next.data['hanhukuk-accounting-v1'].entries.push({
      id: ledgerId(row),
      type: 'in',
      entryKind: 'cheque',
      chequeId: row.id,
      accountId: row.accountId,
      amount: row.amount,
      date: row.date,
      note,
      includeInProfit: row.includeInProfit,
      ...(row.currentAccountId ? { currentAccountId: row.currentAccountId } : {}),
      operatorId: user.id,
      operatorName: user.name,
      createdAt: row.createdAt,
    });
  }
  next.cheques = rows(next).concat(row);
  return { next, cheque: row };
}
function list(s, input = {}) {
  const direction = input.direction || 'received',
    from = clean(input.from, 10),
    to = clean(input.to, 10),
    q = clean(input.q, 200).toLocaleLowerCase('tr'),
    offset = Number(input.offset ?? 0);
  if (
    !['received', 'issued'].includes(direction) ||
    (from && !validDate(from)) ||
    (to && !validDate(to)) ||
    (from && to && from > to) ||
    !Number.isInteger(offset) ||
    offset < 0
  )
    throw fail('Geçerli çek filtresi seçin.');
  const accounts = new Map(s.data['hanhukuk-accounting-v1'].accounts.map((a) => [a.id, a.name]));
  const parties = new Map((s.currentAccountParties || []).map((p) => [p.id, p.name]));
  const entries = new Map(s.data['hanhukuk-accounting-v1'].entries.map((e) => [e.id, e]));
  const approvals = new Map(external.requests(s).map((r) => [r.id, r]));
  const all = rows(s)
    .filter(
      (r) => r.direction === direction && (!from || r.chequeDate >= from) && (!to || r.chequeDate <= to),
    )
    .map((r) => {
      const entry = entries.get(ledgerId(r)),
        approval = approvals.get(r.approvalRequestId);
      const status = entry
        ? 'recorded'
        : r.direction === 'issued' && approval?.status === 'pending'
          ? 'pending'
          : approval?.status === 'rejected'
            ? 'rejected'
            : 'deleted';
      const partyId = entry ? entry.currentAccountId : r.currentAccountId;
      return {
        ...r,
        status,
        accountName: accounts.get(r.accountId) || 'Hesap bulunamadı',
        currentAccountName: parties.get(partyId) || '',
        effectiveCurrentAccountId: partyId || '',
        decidedByName: approval?.decidedByName || '',
      };
    })
    .filter(
      (r) =>
        !q ||
        [r.number, r.holder, r.bankName, r.currentAccountName, r.description]
          .join(' ')
          .toLocaleLowerCase('tr')
          .includes(q),
    )
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
  return {
    items: all.slice(offset, offset + 50),
    count: all.length,
    more: offset + 50 < all.length,
    totals: {
      recorded: all
        .filter((r) => r.status === 'recorded')
        .reduce((sum, r) => sum + BigInt(r.amount), 0n)
        .toString(),
      pending: all
        .filter((r) => r.status === 'pending')
        .reduce((sum, r) => sum + BigInt(r.amount), 0n)
        .toString(),
    },
  };
}
function assertChanges(before, after, user) {
  const oldRows = new Map(rows(before).map((r) => [r.id, r])),
    newRows = new Map(rows(after).map((r) => [r.id, r]));
  for (const [id, row] of oldRows)
    if (!isDeepStrictEqual(row, newRows.get(id))) throw fail('Kayıtlı çek bilgileri değiştirilemez.', 403);
  const previous = new Map(before.data['hanhukuk-accounting-v1'].entries.map((e) => [e.id, e]));
  const nextEntries = new Map(after.data['hanhukuk-accounting-v1'].entries.map((e) => [e.id, e]));
  for (const row of rows(after))
    if (!oldRows.has(row.id)) {
      if (
        row.createdBy !== user.id ||
        !require('./accounting-access.cjs').accountingAllowed(user, after.data['icrapro-personnel-v1'])
      )
        throw fail('Çek kayıt yetkiniz yok.', 403);
      if (row.direction === 'received' && !nextEntries.has(ledgerId(row)))
        throw fail('Alınan çekin para hareketi eksik.', 409);
      if (row.direction === 'issued') {
        const req = external.requests(after).find((r) => r.id === row.approvalRequestId);
        if (
          !req ||
          req.status !== 'pending' ||
          req.chequeId !== row.id ||
          ['amount', 'accountId', 'date', 'includeInProfit', 'currentAccountId'].some(
            (k) => req[k] !== row[k],
          )
        )
          throw fail('Verilen çek CEO onayına sunulmalıdır.', 403);
      }
    }
  for (const e of nextEntries.values()) {
    const old = previous.get(e.id);
    if (old?.chequeId) {
      if (
        [
          'type',
          'entryKind',
          'chequeId',
          'amount',
          'accountId',
          'date',
          'includeInProfit',
          'note',
          'operatorId',
        ].some((k) => !isDeepStrictEqual(old[k], e[k]))
      )
        throw fail('Çekin finansal bilgileri değiştirilemez.', 403);
      continue;
    }
    if (!e.chequeId && e.entryKind !== 'cheque') continue;
    const row = newRows.get(e.chequeId);
    if (
      old ||
      !row ||
      e.id !== ledgerId(row) ||
      e.entryKind !== 'cheque' ||
      e.expenseCategory ||
      ['amount', 'accountId', 'date', 'includeInProfit'].some((k) => e[k] !== row[k]) ||
      (e.currentAccountId || '') !== row.currentAccountId
    )
      throw fail('Çek para hareketi çek kaydından oluşturulmalıdır.', 403);
    if (row.direction === 'received' && (oldRows.has(row.id) || e.type !== 'in' || row.createdBy !== user.id))
      throw fail('Alınan çek hareketi geçersiz.', 403);
    if (
      row.direction === 'issued' &&
      (e.type !== 'externalOut' ||
        user.role !== 'ceo' ||
        external.requests(after).find((r) => r.id === row.approvalRequestId)?.status !== 'approved')
    )
      throw fail('Verilen çek için CEO onayı gerekli.', 403);
  }
}
module.exports = { rows, create, list, assertChanges, requestId, ledgerId };
