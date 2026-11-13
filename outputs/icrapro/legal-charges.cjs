const legalRateVerifiedThrough = '2026-11-03';
const legalCalculationSupportedThrough = '2026-12-31';
const legalRatePeriods = [
  { start: '2006-01-01', end: '2024-06-01', rate: 9 },
  { start: '2024-06-01', end: '2026-07-31', rate: 24 },
  { start: '2026-07-31', end: '2027-01-01', rate: 31 },
];
const enforcementTariffBands = [
  [800000, 16],
  [800000, 15],
  [1600000, 14],
  [1600000, 13],
  [2400000, 11],
  [3200000, 8],
  [4000000, 5],
  [4800000, 3],
  [5600000, 2],
  [Infinity, 1],
];
function legalDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error('Geçerli bir tarih girin.');
  const stamp = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value)
    throw Error('Geçersiz tarih.');
  return stamp;
}
function calculateLegalInterest(principal, start, end) {
  legalDate(start);
  legalDate(end);
  if (!Number.isSafeInteger(principal) || principal <= 0) throw Error('Anapara geçersiz.');
  if (start < '2006-01-01' || end > legalCalculationSupportedThrough)
    throw Error('Bu tarih aralığı için doğrulanmış faiz oranı bulunmuyor.');
  if (end < start) throw Error('Hesap tarihi vadeden önce olamaz.');
  const rows = [];
  let raw = 0;
  for (const period of legalRatePeriods) {
    const from = start > period.start ? start : period.start,
      to = end < period.end ? end : period.end;
    if (to <= from) continue;
    const days = (legalDate(to) - legalDate(from)) / 86400000,
      interest = (principal * period.rate * days) / 36500;
    raw += interest;
    rows.push({ from, to, rate: period.rate, days, interest: Math.round(interest) });
  }
  return { amount: Math.round(raw), rows, days: rows.reduce((sum, r) => sum + r.days, 0) };
}
function calculateEnforcementFee(base, principal, early = false) {
  if (!Number.isSafeInteger(base) || base <= 0 || !Number.isSafeInteger(principal) || principal <= 0)
    throw Error('Ücret matrahı geçersiz.');
  let remaining = base,
    raw = 0;
  const rows = [];
  if (base <= 78125 * 100) {
    raw = 12500 * 100;
    rows.push({ amount: base, rate: null, fee: raw });
  } else
    for (const [limit, rate] of enforcementTariffBands) {
      if (!remaining) break;
      const amount = Math.min(remaining, limit * 100),
        fee = (amount * rate) / 100;
      raw += fee;
      remaining -= amount;
      rows.push({ amount, rate, fee: Math.round(fee) });
    }
  const capped = Math.min(Math.round(raw), principal),
    fee = Math.round(capped * (early ? 0.75 : 1));
  return { amount: fee, rows, capped, early };
}

function applyAutomaticLegalCharges(d, events, today) {
  const receivables = Array.isArray(d.receivables)
    ? require('./receivable-rules.js').sync(d, today, require('./parking-fees.js').parkingFeeInfo)
    : null;
  if (
    d.financeTermsManual === true ||
    d.docType === 'Yediemin Park Ücreti' ||
    d.repaymentPlan ||
    !d.due ||
    ['İade', 'İnfaz'].includes(d.status) ||
    events.some((e) => e.documentId === d.id && e.type === 'payment' && !e.unitAllocation)
  )
    return false;
  try {
    if (today < '2026-11-03' || today > legalCalculationSupportedThrough) return false;
    const principal = Math.round(Number(d.amount || 0) * 100);
    const calculated = receivables
      ? require('./receivable-rules.js').charges(
          receivables,
          today,
          calculateLegalInterest,
          calculateEnforcementFee,
        )
      : null;
    const interest = calculated?.interest || calculateLegalInterest(principal, d.due, today),
      base = calculated?.base ?? principal + interest.amount,
      fee = calculated?.fee || calculateEnforcementFee(base, principal, false),
      key = JSON.stringify([today, d.due, principal, receivables?.items || null]);
    // Keep calculatedAt stable for identical calculations. Open scoped forms
    // compare their saved calculation against this record when they submit.
    if (
      d.automaticLegalKey === key &&
      d.legalCalculation?.automatic === true &&
      !d.legalCalculationError &&
      Math.round(Number(d.financeInterest || 0) * 100) === interest.amount &&
      Math.round(Number(d.financeFee || 0) * 100) === fee.amount &&
      d.legalCalculation.interest?.amount === interest.amount &&
      d.legalCalculation.fee?.amount === fee.amount
    )
      return false;
    d.financeInterest = interest.amount / 100;
    d.financeFee = fee.amount / 100;
    d.legalCalculation = {
      principal,
      start: d.due,
      end: today,
      interest,
      base,
      fee,
      baseMode: 'principalInterest',
      early: 'no',
      verifiedThrough: legalRateVerifiedThrough,
      tariff: 'AAÜT 03.11.2026 — madde 11',
      automatic: true,
      calculatedAt: new Date().toISOString(),
    };
    d.automaticLegalKey = key;
    delete d.legalCalculationError;
    return true;
  } catch (error) {
    d.legalCalculationError = error.message;
    return false;
  }
}
module.exports = { applyAutomaticLegalCharges, calculateLegalInterest, calculateEnforcementFee };
