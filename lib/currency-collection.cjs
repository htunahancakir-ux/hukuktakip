const { createHash } = require('node:crypto');
const units = require('../outputs/icrapro/receivable-units.js');
const { validDate, businessDate } = require('./business-time.cjs');
const fail = (message, status = 400) =>
  Object.assign(Error(message), { status, code: status, publicMessage: true });
const manager = (u) => ['ceo', 'admin'].includes(u.role);
function eventsFor(state, doc) {
  return state.data['hanhukuk-finance-v1'].filter((e) => e.documentId === doc.id);
}
function snapshot(doc, events, asOf) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        asOf,
        doc.receivables,
        doc.unitTerms,
        doc.amount,
        doc.financeInterest,
        doc.financeFee,
        doc.debtDiscountCents,
        doc.status,
        events,
      ]),
    )
    .digest('hex');
}
function summary(state, doc, asOf = businessDate()) {
  const events = eventsFor(state, doc);
  return {
    documentId: doc.id,
    number: doc.number,
    status: doc.status || 'Derdest',
    asOf,
    revision: snapshot(doc, events, asOf),
    groups: units.foreignBalances(doc, asOf, events),
    history: events.filter((e) => e.unitAllocation),
    accounts: state.data['hanhukuk-accounting-v1'].accounts
      .filter((a) => a.active !== false)
      .map((a) => ({ id: a.id, name: a.name })),
  };
}
function append(state, input, user, rate, today = businessDate()) {
  const original = state.data['icrapro-v1'].docs.find((d) => d.id === input.documentId);
  if (!original) throw fail('Dosya bulunamadı.', 404);
  if (!manager(user) && user.role !== 'staff' && !user.permissions?.includes('documents'))
    throw fail('Tahsilat yetkiniz yok.', 403);
  if (user.readOnly && user.role !== 'ceo') throw fail('Bu hesapta yalnızca görüntüleme yapılabilir.', 403);
  const unit = units.currency(input.currency);
  if (unit === 'TRY' || !units.hasForeign(original))
    throw fail('Bu işlem için döviz veya gram altın alacağı seçin.');
  if (!validDate(input.date) || input.date > today) throw fail('Geçerli bir işlem tarihi seçin.');
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId || '')) throw fail('Geçerli işlem kimliği gerekli.');
  const oldEvents = eventsFor(state, original),
    amount = units.minor(input.amount || 0, 'TRY');
  const old = oldEvents.find((e) => e.id === input.requestId);
  if (old) {
    if (
      old.operatorId !== user.id ||
      old.unitAllocation?.currency !== unit ||
      old.amount !== amount ||
      old.accountId !== input.accountId ||
      old.date !== input.date ||
      old.note !== String(input.note || '').trim() ||
      String(old.turnoverStaffId || '') !== String(input.turnoverStaffId || '')
    )
      throw fail('Aynı işlem kimliği farklı bilgilerle kullanılamaz.', 409);
    return null;
  }
  if (state.data['hanhukuk-finance-v1'].some((e) => e.id === input.requestId))
    throw fail('İşlem kimliği başka bir kayıtta kullanılmış.', 409);
  const current = summary(state, original, input.date),
    group = current.groups.find((g) => g.currency === unit);
  if (!group) throw fail('Seçilen birimde alacak bulunamadı.');
  if (input.revision !== current.revision) throw fail('Dosya hesabı değişti. Güncel hesabı yükleyin.', 409);
  if (!rate || rate.id !== input.quoteId || rate.currency !== unit || rate.date !== input.date)
    throw fail('Günlük kur değişti. Kuru yeniden yükleyin.', 409);
  if (amount <= 0) throw fail('Pozitif TL tahsilat tutarı girin.');
  const quantityMinor = units.convertTL(amount, rate.rateMicros, unit);
  if (quantityMinor > group.remaining)
    throw fail('Çevrilen tutar seçilen birimdeki kalan alacağı aşamaz.', 409);
  const account = state.data['hanhukuk-accounting-v1'].accounts.find(
    (a) => a.id === input.accountId && a.active !== false,
  );
  if (!account) throw fail('Tahsilatın girdiği kasa veya bankayı seçin.');
  const note = String(input.note || '').trim();
  if (!note || note.length > 3000) throw fail('Açıklama / dekont numarasını girin.');
  const people = state.data['icrapro-personnel-v1'];
  const staffId = manager(user)
    ? String(input.turnoverStaffId || '')
    : user.staffId || original.relatedStaff || '';
  const staff = people.find((p) => p.id === staffId && p.active !== false),
    category = require('./turnover-categories.cjs').categoryName(staffId);
  if (!staff && !category) throw fail('Ciroyu yapan aktif personeli veya ciro türünü seçin.');
  const next = structuredClone(state),
    doc = next.data['icrapro-v1'].docs.find((d) => d.id === original.id);
  doc.unitTerms ||= {};
  doc.unitTerms[unit] ||= {};
  if (doc.unitTerms[unit].interestMinor === undefined) {
    doc.unitTerms[unit].interestMinor = group.interest;
    doc.unitTerms[unit].interestFrozenByCollection = true;
  }
  const principalMinor = Math.min(quantityMinor, Math.max(0, group.principal - group.received));
  const principalTLMinor = Number(
    (BigInt(amount) * BigInt(principalMinor) + BigInt(quantityMinor) / 2n) / BigInt(quantityMinor),
  );
  const event = {
    id: input.requestId,
    documentId: doc.id,
    type: 'payment',
    amount,
    date: input.date,
    accountId: account.id,
    accountName: account.name,
    note,
    operatorId: user.id,
    operatorName: user.name,
    turnoverStaffId: staffId,
    turnoverStaffName: category || staff.name,
    collectionStaffId: staffId,
    collectionStaffName: category || staff.name,
    closes: false,
    closedAmount: 0,
    revenuePart: 0,
    createdAt: new Date().toISOString(),
    unitAllocation: {
      currency: unit,
      quantityMinor,
      principalMinor,
      principalTLMinor,
      rateMicros: rate.rateMicros,
      rateDate: rate.rateDate,
      transactionDate: input.date,
      source: rate.source,
      sourceUrl: rate.sourceUrl,
      sourceHash: rate.sourceHash,
      quoteId: rate.id,
    },
  };
  if (category) event.turnoverCategory = staffId;
  if (user.testAccount === true) event.testRecord = { operatorId: user.id, operatorName: user.name };
  next.data['hanhukuk-finance-v1'].push(event);
  synchronize(next, today, state);
  const received = eventsFor(next, doc)
    .filter((e) => e.type === 'payment')
    .reduce((n, e) => n + e.amount, 0);
  event.principalAtCollection =
    Math.round(Number(doc.amount || 0) * 100) + (doc.unitPrincipalCostTLMinor || 0);
  event.closes = doc.status === 'İnfaz';
  event.closedAmount = event.closes ? received : 0;
  event.revenuePart = event.closes ? Math.max(0, received - event.principalAtCollection) : 0;
  next.collectionNoticeSequence = Number(next.collectionNoticeSequence || 0) + 1;
  next.collectionNotices = [
    ...(next.collectionNotices || []),
    {
      sequence: next.collectionNoticeSequence,
      eventId: event.id,
      operatorName: user.name,
      collectionStaffId: category ? user.staffId || '' : staffId,
      collectionStaffName: category ? user.name : event.collectionStaffName,
      amount: event.amount,
      closes: event.closes,
      createdAt: event.createdAt,
    },
  ].slice(-1000);
  return next;
}
function synchronize(state, today = businessDate(), before = null) {
  const history = state.data['hanhukuk-finance-v1'];
  for (const doc of state.data['icrapro-v1'].docs) {
    const events = eventsFor(state, doc),
      converted = events.filter((e) => e.unitAllocation);
    if (!units.hasForeign(doc)) {
      if (converted.length) throw fail('Tahsilatı bulunan döviz veya altın alacağı kaldırılamaz.');
      continue;
    }
    for (const [unit, term] of Object.entries(doc.unitTerms || {}))
      if (term.interestFrozenByCollection && !converted.some((e) => e.unitAllocation.currency === unit)) {
        delete term.interestMinor;
        delete term.interestFrozenByCollection;
      }
    const groups = units.foreignBalances(doc, today, events),
      available = new Set(groups.map((g) => g.currency));
    for (const event of converted) {
      const a = event.unitAllocation;
      if (
        event.type !== 'payment' ||
        !available.has(a.currency) ||
        !Number.isSafeInteger(a.quantityMinor) ||
        a.quantityMinor <= 0 ||
        !Number.isSafeInteger(a.principalTLMinor) ||
        a.principalTLMinor < 0 ||
        a.principalTLMinor > event.amount ||
        units.convertTL(event.amount, a.rateMicros, a.currency) !== a.quantityMinor
      )
        throw fail('Döviz/altın tahsilatının hesap bilgileri korunmalıdır.');
    }
    const principalCost = units.principalCostTL(doc, events);
    doc.unitPrincipalCostTLMinor = principalCost;
    const tlReceived = events
      .filter((e) => e.type === 'payment' && !e.unitAllocation)
      .reduce((n, e) => n + e.amount, 0);
    const expenses = events.filter((e) => e.type === 'expense').reduce((n, e) => n + e.amount, 0);
    const tlTarget = Math.max(
      0,
      Math.round(Number(doc.amount || 0) * 100) +
        Math.round(Number(doc.financeInterest || 0) * 100) +
        Math.round(Number(doc.financeFee || 0) * 100) +
        expenses -
        Number(doc.debtDiscountCents || 0),
    );
    const fullyPaid = tlReceived >= tlTarget && groups.every((g) => g.remaining === 0);
    const previous = before?.data['icrapro-v1'].docs.find((d) => d.id === doc.id);
    const previousEvents =
      before?.data['hanhukuk-finance-v1'].filter((e) => e.documentId === doc.id && e.type === 'payment') ||
      [];
    const removedPayment = previousEvents.some((e) => !events.some((current) => current.id === e.id));
    if (fullyPaid && doc.status !== 'İade') {
      doc.status = 'İnfaz';
      doc.closedDate ||= today;
      const closing = events.filter((e) => e.type === 'payment').at(-1);
      if (closing && !previousEvents.some((e) => e.id === closing.id) && previous?.status !== 'İnfaz') {
        const allReceived = events.filter((e) => e.type === 'payment').reduce((n, e) => n + e.amount, 0);
        closing.principalAtCollection = Math.round(Number(doc.amount || 0) * 100) + principalCost;
        closing.closes = true;
        closing.closedAmount = allReceived;
        closing.revenuePart = Math.max(0, allReceived - closing.principalAtCollection);
      }
    } else if (!fullyPaid && doc.status === 'İnfaz' && (previous?.status !== 'İnfaz' || removedPayment)) {
      doc.status = previous?.status && previous.status !== 'İnfaz' ? previous.status : 'Derdest';
      delete doc.closedDate;
      const oldIds = new Set((before?.data['hanhukuk-finance-v1'] || []).map((e) => e.id));
      for (const event of history.filter((e) => e.documentId === doc.id && !oldIds.has(e.id))) {
        event.closes = false;
        event.closedAmount = 0;
        event.revenuePart = 0;
      }
    }
  }
}
function updateTerms(state, input, user, today = businessDate()) {
  if (!manager(user) || (user.readOnly && user.role !== 'ceo'))
    throw fail('Faiz ve ücretleri yalnızca CEO ve yönetici değiştirebilir.', 403);
  const original = state.data['icrapro-v1'].docs.find((d) => d.id === input.documentId);
  if (!original) throw fail('Dosya bulunamadı.', 404);
  const currency = units.currency(input.currency),
    date = input.date || today;
  if (currency === 'TRY' || !validDate(date) || date > today) throw fail('Geçerli birim ve tarih seçin.');
  const interestMinor = units.minor(input.interest || 0, currency),
    feeMinor = units.minor(input.fee || 0, currency),
    discountMinor = units.minor(input.discount || 0, currency);
  if (discountMinor > interestMinor + feeMinor)
    throw fail('Bu alanda indirim, faiz ve ücret toplamını aşamaz; asıl alacak ayrı düzenlenir.');
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId || '')) throw fail('Geçerli işlem kimliği gerekli.');
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([currency, interestMinor, feeMinor, discountMinor, user.id]))
    .digest('hex');
  const old = (original.unitTermsHistory || []).find((row) => row.id === input.requestId);
  if (old) {
    if (old.fingerprint !== fingerprint) throw fail('İşlem kimliği farklı bilgilerle kullanılamaz.', 409);
    return null;
  }
  if (original.status === 'İnfaz') throw fail('İnfaz dosyasında faiz ve ücret değiştirilemez.');
  const current = summary(state, original, date);
  if (!current.groups.some((g) => g.currency === currency)) throw fail('Bu birimde alacak bulunamadı.');
  if (current.revision !== input.revision) throw fail('Dosya hesabı değişti. Güncel hesabı yükleyin.', 409);
  const next = structuredClone(state),
    doc = next.data['icrapro-v1'].docs.find((d) => d.id === original.id);
  doc.unitTerms ||= {};
  const before = doc.unitTerms[currency] || {};
  doc.unitTerms[currency] = { interestMinor, feeMinor, discountMinor, manual: true };
  doc.unitTermsHistory = [
    ...(doc.unitTermsHistory || []),
    {
      id: input.requestId,
      currency,
      before,
      after: doc.unitTerms[currency],
      by: user.id,
      byName: user.name,
      at: new Date().toISOString(),
      fingerprint,
    },
  ];
  synchronize(next, today, state);
  if (doc.status === 'İnfaz') {
    const events = eventsFor(next, doc),
      closing = events.filter((e) => e.type === 'payment').at(-1);
    if (closing) {
      closing.closes = true;
      closing.principalAtCollection =
        Math.round(Number(doc.amount || 0) * 100) + Number(doc.unitPrincipalCostTLMinor || 0);
      closing.closedAmount = events.filter((e) => e.type === 'payment').reduce((n, e) => n + e.amount, 0);
      closing.revenuePart = Math.max(0, closing.closedAmount - closing.principalAtCollection);
    }
  }
  return next;
}
function report(state, input = {}, today = businessDate()) {
  const currency = input.currency || '',
    search = String(input.q || '')
      .trim()
      .toLocaleLowerCase('tr'),
    offset = Number(input.offset || 0);
  if (
    (currency && !['EUR', 'USD', 'XAU'].includes(currency)) ||
    search.length > 200 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 1000000
  )
    throw fail('Geçerli rapor filtresi seçin.');
  const rows = [],
    totals = {};
  for (const doc of state.data['icrapro-v1'].docs) {
    if (!units.hasForeign(doc)) continue;
    const client = state.data['icrapro-v1'].clients.find((c) => c.id === doc.client)?.name || '';
    if (
      search &&
      ![doc.number, doc.debtor, client].some((value) =>
        String(value || '')
          .toLocaleLowerCase('tr')
          .includes(search),
      )
    )
      continue;
    for (const group of units.foreignBalances(doc, today, eventsFor(state, doc))) {
      if (currency && currency !== group.currency) continue;
      if (input.includeClosed !== 'true' && (!group.remaining || doc.status === 'İade')) continue;
      rows.push({
        documentId: doc.id,
        number: doc.number,
        debtor: doc.debtor,
        client,
        status: doc.status,
        ...group,
      });
      const total = (totals[group.currency] ||= { principal: 0n, interest: 0n, received: 0n, remaining: 0n });
      for (const key of Object.keys(total)) total[key] += BigInt(group[key]);
    }
  }
  rows.sort(
    (a, b) =>
      String(a.number).localeCompare(String(b.number), 'tr', { numeric: true }) ||
      a.currency.localeCompare(b.currency),
  );
  return {
    asOf: today,
    rows: rows.slice(offset, offset + 50),
    count: rows.length,
    offset,
    totals: Object.fromEntries(
      Object.entries(totals).map(([currency, values]) => [
        currency,
        Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])),
      ]),
    ),
  };
}
module.exports = { summary, append, synchronize, report, updateTerms };
