function isLawyer(p) {
  return (
    String(p.department || '')
      .normalize('NFKC')
      .trim()
      .toLocaleLowerCase('tr-TR') === 'avukat'
  );
}

function calculateLawyerBonus(state, month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Error('Geçerli prim ayı seçin.');
  const lawyers = (state.data['icrapro-personnel-v1'] || []).filter((p) => p.active !== false && isLawyer(p));
  if (!lawyers.length) return [];
  let officeCollected = 0;
  for (const event of state.data['hanhukuk-finance-v1'] || []) {
    if (event.type !== 'payment' || !String(event.date || '').startsWith(month + '-') || event.amount <= 0)
      continue;
    if (!Number.isSafeInteger(event.amount) || !Number.isSafeInteger(officeCollected + event.amount))
      throw Error('Avukat primi cirosu güvenli tutar sınırını aşıyor.');
    officeCollected += event.amount;
  }
  const total = Math.round(officeCollected / 100);
  return lawyers.map((p) => ({
    staffId: p.id,
    name: p.name,
    kind: 'lawyer',
    officeCollected,
    rate: 1,
    percentageBonus: total,
    total,
  }));
}

module.exports = { isLawyer, calculateLawyerBonus };
