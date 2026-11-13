(function (root) {
  const error = (message) => Object.assign(Error(message), { status: 400, code: 400, publicMessage: true });
  const definitions = Object.freeze({
    TRY: { label: 'TL', digits: 2, scale: 100 },
    EUR: { label: 'Euro', digits: 2, scale: 100 },
    USD: { label: 'Dolar', digits: 2, scale: 100 },
    XAU: { label: 'Gram Altın', digits: 3, scale: 1000 },
  });
  function currency(value) {
    const key = value == null || value === '' ? 'TRY' : value;
    if (!Object.hasOwn(definitions, key)) throw error('Geçerli bir alacak birimi seçin.');
    return key;
  }
  function minor(value, unit = 'TRY') {
    const { digits, scale } = definitions[currency(unit)];
    const text = String(value ?? '0').trim();
    if (!/^\d+(?:\.\d+)?$/.test(text)) throw error('Geçerli pozitif tutar girin.');
    const [whole, decimal = ''] = text.split('.');
    if (decimal.length > digits && /[1-9]/.test(decimal.slice(digits)))
      throw error(
        unit === 'XAU'
          ? 'Gram altın en fazla 3 ondalık basamak içerebilir.'
          : 'Tutar en fazla 2 ondalık basamak içerebilir.',
      );
    const result =
      BigInt(whole) * BigInt(scale) +
      BigInt((decimal.slice(0, digits) + '0'.repeat(digits)).slice(0, digits));
    if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw error('Tutar güvenli hesaplama sınırını aşıyor.');
    return Number(result);
  }
  function checked(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw error('Birim hesabı güvenli sınırı aşıyor.');
    return value;
  }
  const hasForeign = (doc) => (doc.receivables || []).some((item) => currency(item.currency) !== 'TRY');
  const format = (value, unit = 'TRY', withUnit = true) => {
    const def = definitions[currency(unit)];
    return (
      Number(value || 0).toLocaleString('tr-TR', {
        minimumFractionDigits: def.digits,
        maximumFractionDigits: def.digits,
      }) + (withUnit ? ' ' + def.label : '')
    );
  };
  const formatMinor = (value, unit = 'TRY') => {
    const def = definitions[currency(unit)],
      amount = BigInt(value || 0),
      absolute = amount < 0n ? -amount : amount,
      scale = BigInt(def.scale);
    return (
      (amount < 0n ? '-' : '') +
      (absolute / scale).toLocaleString('tr-TR') +
      ',' +
      String(absolute % scale).padStart(def.digits, '0') +
      ' ' +
      def.label
    );
  };
  function principalTotals(items = []) {
    const result = {};
    for (const item of items) {
      const unit = currency(item.currency),
        amount = minor(item.amount || 0, unit),
        paid = minor(item.preTrackingPayment || 0, unit);
      if (paid > amount) throw error('Takip öncesi ödeme evrak tutarını aşamaz.');
      const row = (result[unit] ||= { currency: unit, gross: 0, prepaid: 0, principal: 0 });
      row.gross = checked(row.gross + amount);
      row.prepaid = checked(row.prepaid + paid);
      row.principal = checked(row.principal + amount - paid);
    }
    return result;
  }
  function interestFor(item, today) {
    const unit = currency(item.currency),
      rate = Number(item.interestRate || 0);
    if (!Number.isFinite(rate) || rate < 0 || rate > 10000)
      throw error('Yıllık faiz oranını 0–10.000 aralığında, en fazla 2 ondalık basamakla girin.');
    const rateBasisPoints = minor(rate, 'TRY');
    if (!rate || !item.due || item.due >= today) return 0;
    const days = Math.max(
      0,
      Math.floor((Date.parse(today + 'T00:00:00Z') - Date.parse(item.due + 'T00:00:00Z')) / 86400000),
    );
    if (!Number.isFinite(days)) throw error('Geçerli bir faiz başlangıç tarihi girin.');
    const principal = minor(item.amount, unit) - minor(item.preTrackingPayment || 0, unit);
    const numerator = BigInt(principal) * BigInt(rateBasisPoints) * BigInt(days);
    return checked(Number((numerator + 1825000n) / 3650000n));
  }
  function foreignBalances(doc, today, events = []) {
    const totals = principalTotals(doc.receivables || []),
      result = [];
    for (const [unit, total] of Object.entries(totals)) {
      if (unit === 'TRY') continue;
      const terms = doc.unitTerms?.[unit] || {},
        transactions = events
          .filter(
            (e) => e.documentId === doc.id && e.type === 'payment' && e.unitAllocation?.currency === unit,
          )
          .map((e) => ({ ...e, amount: e.unitAllocation.quantityMinor }));
      const sum = (type) =>
        checked(transactions.filter((e) => e.type === type).reduce((n, e) => n + e.amount, 0));
      const interest =
        terms.interestMinor ??
        (doc.receivables || [])
          .filter((i) => currency(i.currency) === unit)
          .reduce((n, i) => n + interestFor(i, today), 0);
      const fee = terms.feeMinor || 0,
        discount = terms.discountMinor || 0,
        expenses = sum('expense');
      [interest, fee, discount].forEach(checked);
      const grossTarget = checked(total.principal + interest + fee + expenses),
        target = Math.max(0, grossTarget - discount),
        received = sum('payment');
      result.push({
        ...total,
        interest,
        fee,
        discount,
        expenses,
        grossTarget,
        target,
        received,
        remaining: Math.max(0, target - received),
        clientPaid: sum('clientPayout'),
        costOnly: sum('costOnly'),
      });
    }
    return result;
  }
  function convertTL(tlMinor, rateMicros, unit) {
    const scale = definitions[currency(unit)].scale;
    if (
      !Number.isSafeInteger(tlMinor) ||
      tlMinor <= 0 ||
      !Number.isSafeInteger(rateMicros) ||
      rateMicros <= 0
    )
      throw error('Geçerli TL tutarı ve günlük kur gereklidir.');
    const numerator = BigInt(tlMinor) * BigInt(scale) * 1000000n,
      denominator = 100n * BigInt(rateMicros);
    const quantityMinor = checked(Number((numerator + denominator / 2n) / denominator));
    if (!quantityMinor) throw error('TL tutarı seçilen birimin en küçük hesaplama miktarının altında.');
    return quantityMinor;
  }
  function principalCostTL(doc, events = []) {
    const remaining = Object.fromEntries(
      Object.entries(principalTotals(doc.receivables || [])).map(([unit, total]) => [unit, total.principal]),
    );
    let cost = 0n;
    for (const event of events) {
      if (event.documentId !== doc.id || event.type !== 'payment' || !event.unitAllocation) continue;
      const allocation = event.unitAllocation,
        quantity = allocation.quantityMinor;
      checked(quantity);
      checked(event.amount);
      if (!quantity) throw error('Geçerli birim tahsilatı gerekli.');
      const principal = Math.min(quantity, remaining[allocation.currency] || 0);
      cost += (BigInt(event.amount) * BigInt(principal) + BigInt(quantity) / 2n) / BigInt(quantity);
      remaining[allocation.currency] = Math.max(0, (remaining[allocation.currency] || 0) - principal);
    }
    return checked(Number(cost));
  }
  const api = {
    definitions,
    currency,
    minor,
    format,
    formatMinor,
    principalTotals,
    foreignBalances,
    hasForeign,
    interestFor,
    convertTL,
    principalCostTL,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HanUnits = api;
})(globalThis);
