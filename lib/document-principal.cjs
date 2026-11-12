const { isDeepStrictEqual } = require('node:util');
const parking = 'Yediemin Park Ücreti';
const fail = (message, code = 400) => Object.assign(Error(message), { code, status: code });
const cents = (n) => {
  const value = Math.round(Number(n || 0) * 100);
  if (!Number.isSafeInteger(value) || value < 0) throw fail('Asıl alacak tutarı geçersiz.');
  return value;
};
function principalAmountsOnly(before, after) {
  if (
    !Array.isArray(before?.receivables) ||
    !Array.isArray(after?.receivables) ||
    before.receivables.length !== after.receivables.length
  )
    return false;
  return before.receivables.every((old, i) => {
    const item = after.receivables[i];
    if (!item || old.id !== item.id) return false;
    const left = { ...old },
      right = { ...item };
    if (old.docType !== parking) {
      delete left.amount;
      delete right.amount;
    }
    return isDeepStrictEqual(left, right);
  });
}
function changed(before, after) {
  if (!before || before.docType === parking) return false;
  if (Array.isArray(before.receivables) && Array.isArray(after.receivables)) {
    return before.receivables.some(
      (item) =>
        item.docType !== parking &&
        after.receivables.some((next) => next.id === item.id && cents(item.amount) !== cents(next.amount)),
    );
  }
  return cents(before.amount) !== cents(after.amount);
}
function validatePrincipalChange(before, after, events, entries, user) {
  if (!user || !changed(before, after)) return;
  const related = events.filter((e) => e.documentId === before.id);
  const received = related.filter((e) => e.type === 'payment').reduce((sum, e) => sum + e.amount, 0);
  if (!['ceo', 'admin'].includes(user.role) && (received || ['İnfaz', 'İade'].includes(before.status)))
    throw fail('Tahsilatlı dosyada asıl alacağı yalnızca CEO ve yönetici değiştirebilir.', 403);
  const principal = cents(after.amount);
  const target = Math.max(
    0,
    principal +
      cents(after.financeInterest) +
      cents(after.financeFee) +
      related.filter((e) => e.type === 'expense').reduce((sum, e) => sum + e.amount, 0) -
      Number(after.debtDiscountCents || 0),
  );
  if (!Number.isSafeInteger(target)) throw fail('Yeni toplam borç geçersiz.');
  const paid =
    cents(before.clientPaidAmount) +
    entries
      .filter((e) => e.type === 'clientPayout' && e.documentId === before.id)
      .reduce((sum, e) => sum + e.amount, 0);
  const entitlement = Math.max(0, principal - Number(after.mixedParkingCommissionCents || 0));
  if (paid > entitlement) throw fail('Asıl alacak, müvekkile daha önce ödenen tutarın altına indirilemez.');
}
function adjustDocumentPrincipal(state, input, user, today) {
  if (!['ceo', 'admin'].includes(user.role))
    throw fail('Asıl alacağı yalnızca CEO ve yönetici değiştirebilir.', 403);
  const before = state.data['icrapro-v1'].docs.find((d) => d.id === input.documentId);
  if (!before) throw fail('Dosya bulunamadı.', 404);
  if (input.expectedPrincipal !== cents(before.amount))
    throw fail('Asıl alacak başka bir işlemle değişti. Güncel dosyayı yeniden açın.', 409);
  if (before.docType === parking) throw fail('Yediemin asıl alacağı günlük tarifeden hesaplanır.');
  const next = structuredClone(state),
    after = next.data['icrapro-v1'].docs.find((d) => d.id === before.id);
  const validAmount = (value, allowZero = false) => {
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw fail('Geçerli asıl alacak girin.');
    return value;
  };
  if (Array.isArray(after.receivables)) {
    if (
      !Array.isArray(input.items) ||
      input.items.length !== after.receivables.length ||
      new Set(input.items.map((r) => r.id)).size !== input.items.length
    )
      throw fail('Föydeki tüm alacak kalemlerini güncel kayıtlarıyla gönderin.');
    for (const item of after.receivables) {
      const value = input.items.find((r) => r.id === item.id);
      if (!value) throw fail('Alacak kalemi bulunamadı.');
      if (value.expectedAmount !== cents(item.amount) - cents(item.preTrackingPayment))
        throw fail('Alacak kalemi başka bir işlemle değişti. Güncel dosyayı yeniden açın.', 409);
      const amount = validAmount(value.amount, true);
      if (item.docType === parking) {
        if (amount !== cents(item.amount) - cents(item.preTrackingPayment))
          throw fail('Yediemin kalemi günlük tarifeden hesaplanır.');
      } else item.amount = (amount + cents(item.preTrackingPayment)) / 100;
    }
    require('../outputs/icrapro/receivable-rules.js').sync(
      after,
      today,
      require('../outputs/icrapro/parking-fees.js').parkingFeeInfo,
    );
  } else {
    after.amount = validAmount(input.amount) / 100;
    if (before.originalAmount != null || ['Senet', 'Diğer'].includes(before.docType))
      after.originalAmount = (input.amount + cents(before.preTrackingPayment)) / 100;
  }
  if (cents(after.amount) <= 0) throw fail('Toplam asıl alacak sıfırdan büyük olmalıdır.');
  require('../outputs/icrapro/legal-charges.cjs').applyAutomaticLegalCharges(
    after,
    state.data['hanhukuk-finance-v1'],
    today,
  );
  validatePrincipalChange(
    before,
    after,
    state.data['hanhukuk-finance-v1'],
    state.data['hanhukuk-accounting-v1'].entries,
    user,
  );
  if (!changed(before, after)) return { next: null, record: before };
  const events = state.data['hanhukuk-finance-v1'].filter((e) => e.documentId === before.id);
  const received = events.filter((e) => e.type === 'payment').reduce((sum, e) => sum + e.amount, 0);
  const target = Math.max(
    0,
    cents(after.amount) +
      cents(after.financeInterest) +
      cents(after.financeFee) +
      events.filter((e) => e.type === 'expense').reduce((sum, e) => sum + e.amount, 0) -
      Number(after.debtDiscountCents || 0),
  );
  if (before.status === 'İnfaz' && target > received) {
    after.status = String(after.enforcementFileNumber || '').trim() ? 'İcra' : 'Derdest';
    delete after.closedDate;
  }
  after.principalAdjustment = {
    before: cents(before.amount),
    after: cents(after.amount),
    beforeStatus: before.status,
    beforeClosedDate: before.closedDate || '',
    by: user.id,
    byName: user.name,
    at: new Date().toISOString(),
  };
  after.principalAdjustmentHistory = [
    ...(before.principalAdjustmentHistory || []),
    after.principalAdjustment,
  ].slice(-100);
  return { next, record: after };
}
module.exports = { principalAmountsOnly, validatePrincipalChange, adjustDocumentPrincipal };
