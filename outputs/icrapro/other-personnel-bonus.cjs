const { categories } = require('../../lib/turnover-categories.cjs');
const normalized = (name) =>
  String(name || '')
    .trim()
    .toLocaleLowerCase('tr-TR')
    .replaceAll('ı', 'i')
    .replace(/[\s_-]+/g, '');
function isOtherPersonnel(p) {
  return (
    String(p.department || '')
      .trim()
      .toLocaleLowerCase('tr-TR') === 'diğer' &&
    !Object.hasOwn(categories, p.id) &&
    !Object.values(categories).some((name) => normalized(name) === normalized(p.name))
  );
}
function calculateOtherPersonnelBonus(state, month, today = month + '-31') {
  const people = state.data['icrapro-personnel-v1'] || [];
  const rows = people.filter(isOtherPersonnel).map((p) => ({
    staffId: p.id,
    name: p.name,
    kind: 'other',
    collected: 0,
    closedCount: 0,
    rate: 12.5,
    percentageBonus: 0,
    total: 0,
  }));
  const byId = new Map(rows.map((r) => [r.staffId, r])),
    names = new Map();
  for (const p of people) {
    const key = normalized(p.name);
    names.set(key, names.has(key) ? null : p.id);
  }
  const input = state.otherPersonnelPayrollInputs || {};
  const docs = input.docs || state.data['icrapro-v1']?.docs || [];
  const events = input.payments || state.data['hanhukuk-finance-v1'] || [];
  const sums = new Map();
  for (const e of events) {
    if (e.type !== 'payment' || e.date > today || !Number.isSafeInteger(e.amount) || e.amount <= 0) continue;
    const total = sums.get(e.documentId) || { amount: 0, lastDate: '' };
    total.amount += e.amount;
    if (!Number.isSafeInteger(total.amount)) throw Error('Prim cirosu güvenli tutar sınırını aşıyor.');
    if (e.date > total.lastDate) total.lastDate = e.date;
    sums.set(e.documentId, total);
  }
  for (const d of docs) {
    if (d.status !== 'İnfaz') continue;
    const payments = sums.get(d.id);
    if (!payments) continue;
    const day = d.closedDate || payments.lastDate;
    if (!day.startsWith(month + '-') || day > today) continue;
    const receiver =
      d.receivedById || (byId.has(d.receivedBy) ? d.receivedBy : names.get(normalized(d.receivedBy)));
    const row = byId.get(receiver);
    if (!row) continue;
    row.collected += payments.amount;
    if (!Number.isSafeInteger(row.collected)) throw Error('Prim cirosu güvenli tutar sınırını aşıyor.');
    row.closedCount++;
  }
  for (const row of rows) row.total = row.percentageBonus = Math.round(row.collected / 8);
  return rows;
}
module.exports = { isOtherPersonnel, calculateOtherPersonnelBonus };
