function callcenterUnit(p) {
  const unit = String(p.department || '')
    .toLocaleLowerCase('tr')
    .replace(/[\s_-]/g, '');
  if (unit === 'temlik') return 'callcentert';
  return ['callcenter', 'callcentery', 'callcentere', 'callcentert'].includes(unit) ? unit : '';
}
function isCallcenter(p) {
  return !!callcenterUnit(p);
}
const rules = {
  callcentere: { quota: 50000000, thresholds: [[50000000, 4]], target: Infinity, noExtras: true },
  callcentert: { quota: 50000000, thresholds: [[50000000, 4]], target: Infinity, noExtras: true },
  callcenter: {
    quota: 90000000,
    thresholds: [
      [150000000, 4],
      [125000000, 3],
      [110000000, 2],
      [90000000, 1],
    ],
    target: 175000000,
  },
  callcentery: {
    quota: 100000000,
    thresholds: [
      [165000000, 4],
      [150000000, 3],
      [125000000, 2],
      [100000000, 1],
    ],
    target: 185000000,
  },
};
const categoryKey = (value) =>
  String(value || '')
    .toLocaleLowerCase('tr-TR')
    .replaceAll('ı', 'i')
    .replace(/[\s_-]/g, '');
const categoryNames = new Set(['temlikreddiyat', 'hukukreddiyat', 'bonus']);
const categoryIds = new Set(['turnover:temlik-reddiyat', 'turnover:hukuk-reddiyat', 'turnover:bonus']);
function sumAmount(a, b) {
  const result = a + b;
  if (!Number.isSafeInteger(result)) throw Error('Prim cirosu güvenli tutar sınırını aşıyor.');
  return result;
}
function calculateCallcenterBonus(state, month) {
  const staff = state.data['icrapro-personnel-v1'],
    events = state.data['hanhukuk-finance-v1'],
    docs = state.data['icrapro-v1'].docs;
  const people = new Map(staff.map((p) => [p.id, p]));
  const rows = staff
    .filter((p) => isCallcenter(p) && !categoryIds.has(p.id) && !categoryNames.has(categoryKey(p.name)))
    .map((p) => ({
      staffId: p.id,
      name: p.name,
      unit: callcenterUnit(p),
      active: p.active !== false,
      collected: 0,
      firstHalf: 0,
      secondHalf: 0,
    }));
  const map = new Map(rows.map((r) => [r.staffId, r]));
  let temlikCollected = 0;
  for (const e of events) {
    if (
      e.type !== 'payment' ||
      !String(e.date || '').startsWith(month + '-') ||
      !Number.isSafeInteger(e.amount) ||
      e.amount <= 0
    )
      continue;
    const doc = docs.find((d) => d.id === e.documentId);
    const id = e.turnoverStaffId || e.collectionStaffId || doc?.relatedStaff;
    const name =
      people.get(id)?.name || e.turnoverStaffName || e.collectionStaffName || doc?.relatedStaffName;
    // Reserved category IDs take precedence over historical display names.
    const temlik =
      id === 'turnover:temlik-reddiyat' || (!categoryIds.has(id) && categoryKey(name) === 'temlikreddiyat');
    if (temlik) {
      temlikCollected = sumAmount(temlikCollected, e.amount);
      continue;
    }
    if (categoryIds.has(id) || categoryNames.has(categoryKey(name))) continue;
    const row = map.get(id);
    if (!row) continue;
    row.collected = sumAmount(row.collected, e.amount);
    if (Number(e.date.slice(8, 10)) <= 15) row.firstHalf = sumAmount(row.firstHalf, e.amount);
    else row.secondHalf = sumAmount(row.secondHalf, e.amount);
  }
  return rows.map((r) => {
    const rule = rules[r.unit],
      active = rows.filter((p) => p.active && p.unit === r.unit),
      teamReached = active.length > 0 && active.every((p) => p.collected >= rule.quota),
      quotaCollected = r.unit === 'callcentert' ? sumAmount(r.collected, temlikCollected) : r.collected,
      rate = rule.thresholds.find(([threshold]) => quotaCollected >= threshold)?.[1] || 0,
      percentageBonus = Math.round((r.collected * rate) / 100),
      targetBonus = !rule.noExtras && r.collected >= rule.target ? 1000000 : 0,
      teamBonus = !rule.noExtras && r.active && teamReached ? 500000 : 0,
      firstHalfBonus = !rule.noExtras && r.firstHalf >= 100000000 ? 1000000 : 0,
      secondHalfBonus = !rule.noExtras && r.secondHalf >= 100000000 ? 1000000 : 0;
    return {
      ...r,
      quota: rule.quota,
      ...(r.unit === 'callcentert' ? { temlikCollected, quotaCollected } : {}),
      rate,
      percentageBonus,
      targetBonus,
      teamBonus,
      firstHalfBonus,
      secondHalfBonus,
      total: percentageBonus + targetBonus + teamBonus + firstHalfBonus + secondHalfBonus,
    };
  });
}
module.exports = { isCallcenter, callcenterUnit, calculateCallcenterBonus };
