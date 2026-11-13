const fail = (message, code = 400) => Object.assign(Error(message), { code, status: code });
const cents = (value) => Math.round(Number(value || 0) * 100);
function closeManually(doc, events, user, today) {
  if (!['ceo', 'admin'].includes(user?.role))
    throw fail('Manuel infazı yalnızca CEO ve yönetici yapabilir.', 403);
  const native = require('../outputs/icrapro/receivable-units.js').foreignBalances(doc, today, events);
  if (native.some((g) => g.received < g.principal))
    throw fail('Manuel infaz için her birimde asıl alacak tahsil edilmiş olmalıdır.');
  const payments = events.filter((e) => e.documentId === doc.id && e.type === 'payment' && !e.unitAllocation);
  const received = payments.reduce((sum, e) => sum + e.amount, 0),
    principal = cents(doc.amount);
  if (
    !Number.isSafeInteger(principal) ||
    (principal <= 0 && !native.length) ||
    !Number.isSafeInteger(received) ||
    received < principal
  )
    throw fail('Manuel infaz için tahsilat asıl alacağa eşit veya üzerinde olmalıdır.');
  for (const group of native)
    if (group.remaining > 0) {
      doc.unitTerms ||= {};
      doc.unitTerms[group.currency] ||= {};
      doc.unitTerms[group.currency].discountMinor =
        (doc.unitTerms[group.currency].discountMinor || 0) + group.remaining;
    }
  const parking = doc.docType === 'Yediemin Park Ücreti';
  const expenses = parking
    ? 0
    : events
        .filter((e) => e.documentId === doc.id && e.type === 'expense')
        .reduce((sum, e) => sum + e.amount, 0);
  const oldDiscount = Number(doc.debtDiscountCents || 0);
  const target = Math.max(
    0,
    principal + cents(doc.financeInterest) + cents(doc.financeFee) + expenses - oldDiscount,
  );
  if (!Number.isSafeInteger(target)) throw fail('Dosya toplamı geçersiz.');
  if (
    doc.status === 'İnfaz' &&
    doc.closedDate === today &&
    doc.manualClosure?.principal === principal &&
    doc.manualClosure?.received === received &&
    target <= received
  )
    return doc;
  const waived = Math.max(0, target - received);
  if (waived) {
    doc.debtDiscountCents = oldDiscount + waived;
    doc.discountHistory = [
      ...(doc.discountHistory || []),
      {
        date: today,
        amount: waived,
        note: 'Asıl alacak tahsil edildi; kalan bakiye manuel infazla kapatıldı.',
        operatorId: user.id,
        operatorName: user.name,
        createdAt: new Date().toISOString(),
      },
    ];
  }
  doc.status = 'İnfaz';
  doc.closedDate = today;
  doc.manualClosure = {
    principal,
    received,
    waived,
    by: user.id,
    byName: user.name,
    at: new Date().toISOString(),
  };
  const closing = payments.at(-1);
  if (closing) {
    closing.closes = true;
    closing.closedAmount = Math.max(0, target - waived);
  }
  return doc;
}
module.exports = { closeManually };
