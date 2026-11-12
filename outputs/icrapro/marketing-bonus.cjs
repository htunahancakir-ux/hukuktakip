const { validDate } = require('../../lib/business-time.cjs');
const isMarketing = (p) =>
  String(p.department || '')
    .trim()
    .toLocaleLowerCase('tr-TR') === 'pazarlama';
const integer = (n) => {
  if (!Number.isSafeInteger(n) || n < 0) throw Error('Pazarlama primi tutarı veya evrak sayısı geçersiz.');
  return n;
};
const cents = (value) => integer(Math.round(Number(value || 0) * 100));
function businessDay(value) {
  if (validDate(value)) return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return '';
  const stamp = new Date(value);
  if (!Number.isFinite(stamp.getTime())) return '';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(stamp);
}
function calculateMarketingBonus(state, month, today = month + '-31') {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Error('Geçerli prim ayı seçin.');
  const staff = (state.data['icrapro-personnel-v1'] || []).filter(isMarketing);
  const rows = staff.map((p) => ({
    staffId: p.id,
    name: p.name,
    kind: 'marketing',
    documentCount: 0,
    documentRate: 0,
    documentBonus: 0,
    parkingCollected: 0,
    parkingRank: null,
    parkingBonus: 0,
    officeCollected: 0,
    officeTargetBonus: 0,
    newFirmBonus: 0,
    newFirms: [],
    total: 0,
  }));
  const byId = new Map(rows.map((r) => [r.staffId, r]));
  const byName = new Map();
  for (const p of state.data['icrapro-personnel-v1'] || []) {
    const name = String(p.name || '')
      .trim()
      .toLocaleLowerCase('tr-TR');
    byName.set(name, byName.has(name) ? null : p.id);
  }
  const input = state.marketingPayrollInputs || state.data['icrapro-v1'] || {};
  const docs = input.docs || [],
    clients = input.clients || [];
  const payments = input.payments || state.data['hanhukuk-finance-v1'] || [];
  const thisMonth = (date) => validDate(date) && date.startsWith(month + '-') && date <= today;
  const documents = new Map(),
    firmCounts = new Map();
  for (const doc of docs) {
    const owner =
      doc.receivedById ||
      (byId.has(doc.receivedBy)
        ? doc.receivedBy
        : byName.get(
            String(doc.receivedBy || '')
              .trim()
              .toLocaleLowerCase('tr-TR'),
          ));
    const row = byId.get(owner);
    const items = Array.isArray(doc.receivables) && doc.receivables.length ? doc.receivables : [doc];
    let principal = 0,
      parking = 0;
    for (const item of items) {
      const day = businessDay(item.registeredOn) || businessDay(doc.trackingDate) || businessDay(doc.created);
      if (thisMonth(day)) {
        if (row) row.documentCount++;
        firmCounts.set(doc.client, (firmCounts.get(doc.client) || 0) + 1);
      }
      if (!row) continue;
      const amount = Math.max(0, cents(item.originalAmount ?? item.amount) - cents(item.preTrackingPayment));
      principal = integer(principal + amount);
      if (item.docType === 'Yediemin Park Ücreti') parking = integer(parking + amount);
    }
    if (row)
      documents.set(doc.id, {
        row,
        principal,
        parking,
        onlyParking: items.every((item) => item.docType === 'Yediemin Park Ücreti'),
      });
  }
  let officeCollected = 0;
  const monthlyCollections = new Map();
  for (const event of payments) {
    if (event.type !== 'payment' || !thisMonth(event.date) || event.amount <= 0) continue;
    integer(event.amount);
    officeCollected = integer(officeCollected + event.amount);
    monthlyCollections.set(
      event.documentId,
      integer((monthlyCollections.get(event.documentId) || 0) + event.amount),
    );
  }
  for (const [documentId, collected] of monthlyCollections) {
    const info = documents.get(documentId);
    if (!info) continue;
    // Shared collections are divided by principal, independent of office commission.
    const share = info.onlyParking
      ? collected
      : info.principal
        ? Number(
            (BigInt(collected) * BigInt(info.parking) + BigInt(Math.floor(info.principal / 2))) /
              BigInt(info.principal),
          )
        : 0;
    info.row.parkingCollected = integer(info.row.parkingCollected + share);
  }
  const seenClients = new Set();
  for (const client of clients) {
    if (seenClients.has(client.id) || !thisMonth(businessDay(client.createdAt))) continue;
    seenClients.add(client.id);
    const row = byId.get(client.documentStaff);
    if (!row) continue;
    const count = firmCounts.get(client.id) || 0;
    row.newFirms.push({
      clientId: client.id,
      name: client.name,
      documentCount: count,
      bonus: count >= 10 ? 250000 : 0,
    });
  }
  const ranking = [...rows].sort(
    (a, b) => b.parkingCollected - a.parkingCollected || String(a.staffId).localeCompare(String(b.staffId)),
  );
  for (const row of ranking) {
    if (row.parkingCollected >= 100000000) {
      // Competition ranks: equal firsts both receive first prize; next rank is 3.
      row.parkingRank = 1 + ranking.filter((other) => other.parkingCollected > row.parkingCollected).length;
      row.parkingBonus = row.parkingRank === 1 ? 1500000 : row.parkingRank === 2 ? 750000 : 0;
    }
    row.documentRate = row.documentCount > 200 ? 15000 : 10000;
    row.documentBonus = integer(row.documentCount * row.documentRate);
    row.officeCollected = officeCollected;
    row.officeTargetBonus = officeCollected >= 1000000000 && row.documentCount >= 100 ? 750000 : 0;
    row.newFirmBonus = row.newFirms.reduce((sum, firm) => integer(sum + firm.bonus), 0);
    row.total = integer(row.documentBonus + row.parkingBonus + row.officeTargetBonus + row.newFirmBonus);
  }
  return rows;
}
module.exports = { isMarketing, businessDay, calculateMarketingBonus };
