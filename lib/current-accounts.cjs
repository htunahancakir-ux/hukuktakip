const { createHash } = require('node:crypto');
const { businessDate, validDate } = require('./business-time.cjs');
const fail = (message, code = 400) => Object.assign(Error(message), { code, status: code });
const parties = (s) => s.currentAccountParties || [];
const entries = (s) => s.currentAccountEntries || [];
const idOK = (id) => typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id);
const clean = (v, max) => {
  if (v !== undefined && typeof v !== 'string') throw fail('Geçersiz cari bilgisi.');
  const text = (v || '').trim();
  if (text.length > max) throw fail('Cari bilgisi çok uzun.');
  return text;
};
const key = (s) =>
  String(s || '')
    .toLocaleLowerCase('tr-TR')
    .replaceAll('ı', 'i');
function findParty(s, id, active = false) {
  const p = parties(s).find((p) => p.id === id);
  if (!p || (active && p.active === false)) throw fail('Aktif bir cari hesap seçin.', 404);
  return p;
}
function eligible(e) {
  return ['in', 'out', 'externalOut'].includes(e.type) && !e.financeEventId && !e.expensePoolFunding;
}
function cashParty(s, value, type) {
  const id = clean(value, 80);
  if (!id) return '';
  if (!['in', 'out', 'externalOut'].includes(type))
    throw fail('Cari bağlantısı yalnızca para giriş ve çıkışında kullanılır.');
  findParty(s, id, true);
  return id;
}
function saveParty(s, input, user) {
  if (!input || !idOK(input.id)) throw fail('Geçerli cari numarası gerekli.');
  const fields = {
    name: clean(input.name, 200),
    kind: input.kind || 'Firma',
    phone: clean(input.phone, 80),
    phoneSource: clean(input.phoneSource, 200),
    note: clean(input.note, 3000),
  };
  if (!fields.name || !['Firma', 'Kişi'].includes(fields.kind)) throw fail('Cari adı ve türünü girin.');
  const old = parties(s).find((p) => p.id === input.id);
  if (old && Object.entries(fields).every(([k, v]) => old[k] === v)) return { next: null, party: old };
  if (old && input.revision !== old.revision) throw fail('Cari başka bir işlemle değişti. Yenileyin.', 409);
  const p = {
    ...old,
    ...fields,
    id: input.id,
    active: old?.active !== false,
    revision: (old?.revision || 0) + 1,
    createdAt: old?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    updatedBy: user.id,
  };
  const next = structuredClone(s);
  next.currentAccountParties = parties(next)
    .filter((r) => r.id !== p.id)
    .concat(p);
  return { next, party: p };
}
function addEntry(s, input, user) {
  if (
    !input ||
    !idOK(input.id) ||
    !['debit', 'credit'].includes(input.side) ||
    !Number.isSafeInteger(input.amount) ||
    input.amount <= 0 ||
    !validDate(input.date) ||
    input.date > businessDate()
  )
    throw fail('Geçerli tutar, tarih ve borç/alacak türü girin.');
  findParty(s, input.partyId, true);
  const note = clean(input.note, 3000);
  if (!note) throw fail('Açıklama girin.');
  const fields = {
    id: input.id,
    partyId: input.partyId,
    side: input.side,
    amount: input.amount,
    date: input.date,
    note,
  };
  const old = entries(s).find((e) => e.id === input.id);
  if (old) {
    if (!Object.entries(fields).every(([k, v]) => old[k] === v) || old.operatorId !== user.id)
      throw fail('İşlem numarası başka bir kayıtta kullanılmış.', 409);
    return { next: null, entry: old };
  }
  const e = { ...fields, createdAt: new Date().toISOString(), operatorId: user.id, operatorName: user.name };
  const next = structuredClone(s);
  next.currentAccountEntries = entries(next).concat(e);
  return { next, entry: e };
}
function fromClient(s, input, user) {
  if (
    !input ||
    !idOK(input.id) ||
    typeof input.clientId !== 'string' ||
    !input.clientId ||
    input.clientId.length > 200
  )
    throw fail('Geçerli müvekkil seçin.');
  const client = s.data['icrapro-v1'].clients.find((c) => c.id === input.clientId && c.active !== false);
  if (!client) throw fail('Aktif müvekkil bulunamadı.', 404);
  const existing = parties(s).find((p) => p.clientId === client.id);
  if (existing) {
    if (existing.active === false) throw fail('Bu müvekkilin carisi pasif durumda.', 409);
    return { next: null, party: existing, existing: true };
  }
  if (parties(s).some((p) => p.id === input.id))
    throw fail('Cari numarası başka bir kayıtta kullanılmış.', 409);
  const result = saveParty(
    s,
    {
      id: input.id,
      name: client.name || client.tradeName,
      kind: client.type === 'Şahıs' ? 'Kişi' : 'Firma',
      phone: client.phone || '',
    },
    user,
  );
  const party = result.next.currentAccountParties.find((p) => p.id === input.id);
  Object.assign(party, {
    clientId: client.id,
    clientCode: client.clientCode ?? client.sourceImport?.clientCode ?? '',
    address: client.address || '',
    city: client.city || '',
    district: client.district || '',
  });
  return { next: result.next, party, existing: false };
}
function linkEntry(s, input, user) {
  if (!input || !idOK(input.entryId) || typeof input.expectedPartyId !== 'string')
    throw fail('Geçerli para hareketi seçin.');
  const e = s.data['hanhukuk-accounting-v1'].entries.find((e) => e.id === input.entryId);
  if (!e || !eligible(e)) throw fail('Bu hareket cariye bağlanamaz.', 404);
  const id = cashParty(s, input.partyId, e.type);
  if ((e.currentAccountId || '') === id) return { next: null };
  if ((e.currentAccountId || '') !== input.expectedPartyId)
    throw fail('Cari bağlantısı değişmiş. Hareketleri yenileyin.', 409);
  const next = structuredClone(s);
  const row = next.data['hanhukuk-accounting-v1'].entries.find((r) => r.id === e.id);
  if (id) row.currentAccountId = id;
  else delete row.currentAccountId;
  row.currentAccountLinkedAt = new Date().toISOString();
  row.currentAccountLinkedBy = user.id;
  return { next };
}
function validateLedgerLinks(s, ledger) {
  const previous = new Map(s.data['hanhukuk-accounting-v1'].entries.map((e) => [e.id, e]));
  for (const e of ledger.entries || []) {
    const old = previous.get(e.id);
    if (e.currentAccountId && !eligible(e)) throw fail('Bu hareket cariye bağlanamaz.');
    if ((old?.currentAccountId || '') === (e.currentAccountId || '')) continue;
    if (e.currentAccountId) {
      cashParty(s, e.currentAccountId, e.type);
    }
  }
}
function movements(s, partyId) {
  const accounts = new Map(s.data['hanhukuk-accounting-v1'].accounts.map((a) => [a.id, a.name]));
  const rows = entries(s)
    .filter((e) => !partyId || e.partyId === partyId)
    .map((e) => ({
      ...e,
      id: 'manual:' + e.id,
      kind: e.side === 'debit' ? 'Alacak kaydı' : 'Borç kaydı',
      signed: (e.side === 'debit' ? BigInt(e.amount) : -BigInt(e.amount)).toString(),
      account: '—',
      source: 'manual',
    }));
  for (const e of s.data['hanhukuk-accounting-v1'].entries) {
    if (!eligible(e) || !e.currentAccountId || (partyId && e.currentAccountId !== partyId)) continue;
    rows.push({
      id: 'cash:' + e.id,
      partyId: e.currentAccountId,
      date: String(e.date || '').slice(0, 10),
      createdAt: e.createdAt || '',
      kind:
        e.type === 'externalOut'
          ? 'Harici ödeme'
          : e.type === 'out'
            ? 'Kasa/Banka ödemesi'
            : 'Kasa/Banka tahsilatı',
      note: e.note || '',
      signed: (e.type === 'in' ? -BigInt(e.amount) : BigInt(e.amount)).toString(),
      account: accounts.get(e.accountId) || e.accountName || 'Belirtilmedi',
      source: 'cash',
      operatorName: e.operatorName || '',
    });
  }
  return rows.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      String(a.createdAt || '').localeCompare(String(b.createdAt || '')) ||
      a.id.localeCompare(b.id),
  );
}
function list(s, input = {}) {
  const q = clean(input.q, 200),
    offset = Number(input.offset ?? 0),
    limit = Number(input.limit ?? 50);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw fail('Geçersiz sayfa.');
  const balances = new Map();
  for (const e of movements(s)) balances.set(e.partyId, (balances.get(e.partyId) || 0n) + BigInt(e.signed));
  const all = parties(s)
    .filter((p) => p.active !== false && key(p.name + ' ' + p.phone).includes(key(q)))
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'))
    .map((p) => ({ ...p, balance: String(balances.get(p.id) || 0n) }));
  return {
    items: all.slice(offset, offset + limit),
    count: all.length,
    more: offset + limit < all.length,
    totals: {
      receivable: String(all.reduce((sum, p) => sum + (BigInt(p.balance) > 0n ? BigInt(p.balance) : 0n), 0n)),
      payable: String(all.reduce((sum, p) => sum + (BigInt(p.balance) < 0n ? -BigInt(p.balance) : 0n), 0n)),
    },
  };
}
function statement(s, id, input = {}) {
  const p = findParty(s, id),
    from = clean(input.from, 10),
    to = clean(input.to, 10);
  const offset = Number(input.offset ?? 0),
    limit = Number(input.limit ?? 50);
  if (
    (from && !validDate(from)) ||
    (to && !validDate(to)) ||
    (from && to && from > to) ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw fail('Geçerli tarih aralığı ve sayfa seçin.');
  let balance = 0n,
    opening = 0n;
  const all = movements(s, id).map((e) => {
    balance += BigInt(e.signed);
    if (from && e.date < from) opening += BigInt(e.signed);
    return { ...e, balance: String(balance) };
  });
  const selected = all.filter((e) => (!from || e.date >= from) && (!to || e.date <= to)).reverse();
  const version = createHash('sha256')
    .update(JSON.stringify([id, from, to, all]))
    .digest('hex');
  if (input.version && input.version !== version)
    throw fail('Cari hareketleri değişti. İlk sayfadan yenileyin.', 409);
  const debit = selected.reduce((sum, e) => sum + (BigInt(e.signed) > 0n ? BigInt(e.signed) : 0n), 0n),
    credit = selected.reduce((sum, e) => sum + (BigInt(e.signed) < 0n ? -BigInt(e.signed) : 0n), 0n);
  return {
    party: p,
    items: selected.slice(offset, offset + limit),
    count: selected.length,
    more: offset + limit < selected.length,
    version,
    totals: {
      opening: String(opening),
      debit: String(debit),
      credit: String(credit),
      closing: String(opening + debit - credit),
      current: String(balance),
    },
    allItems: selected,
  };
}
module.exports = {
  parties,
  findParty,
  eligible,
  cashParty,
  saveParty,
  fromClient,
  addEntry,
  linkEntry,
  validateLedgerLinks,
  list,
  statement,
};
