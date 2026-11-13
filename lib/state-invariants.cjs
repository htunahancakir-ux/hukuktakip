const { archiveRemovedDocuments, preventArchivedNumberReuse } = require('./document-archive.cjs');
const { normalizePhoneRecords } = require('../outputs/icrapro/phone-format.js');
const { syncPayrollPeriods } = require('../outputs/icrapro/payroll-periods.cjs');
const { applyAutomaticLegalCharges } = require('../outputs/icrapro/legal-charges.cjs');
const { duplicateIdentityError } = require('../outputs/icrapro/identity-validation.cjs');
const { businessDate } = require('./business-time.cjs');
const { assertDeletionAllowed } = require('./deletion-policy.cjs');
const { isDeepStrictEqual } = require('node:util');
function prepareState(state, next, actor, { skipPayroll = false } = {}) {
  if (actor) assertDeletionAllowed(state, next, actor);
  const today = businessDate();
  for (const doc of next.data['icrapro-v1'].docs)
    require('./document-receivers.cjs').normalizeHanReceiver(doc);
  for (const doc of next.data['icrapro-v1'].docs) delete doc.imatikFolioNumber;
  for (const archive of next.deletedDocuments || [])
    if (archive.document) delete archive.document.imatikFolioNumber;
  const previousDocuments = new Map(state.data['icrapro-v1'].docs.map((doc) => [doc.id, doc]));
  const oldPaymentIds = new Set(
    state.data['hanhukuk-finance-v1'].filter((e) => e.type === 'payment').map((e) => e.id),
  );
  const eventsByDocument = new Map();
  for (const event of next.data['hanhukuk-finance-v1']) {
    if (!eventsByDocument.has(event.documentId)) eventsByDocument.set(event.documentId, []);
    eventsByDocument.get(event.documentId).push(event);
  }
  if (actor) archiveRemovedDocuments(state, next, actor);
  delete next.data['icrapro-v1'].archivedNumbers;
  preventArchivedNumberReuse(state, next);
  normalizePhoneRecords(next.data);
  for (const client of next.data['icrapro-v1'].clients) {
    if (client.additionalBankAccounts !== undefined)
      client.additionalBankAccounts = require('../outputs/icrapro/client-bank-accounts.js').additional(
        client,
      );
  }
  require('./marketing-inputs.cjs').stampMarketingInputs(state, next, today);
  if (!skipPayroll) syncPayrollPeriods(next, today);
  if (actor) require('./personnel-ledger.cjs').assertPaymentChanges(state, next, actor, today);
  for (const d of next.data['icrapro-v1'].docs) {
    if (d.debtorType != null && !['Şahıs', 'Şirket', 'Şahıs Şirketi'].includes(d.debtorType))
      throw Object.assign(Error('Geçerli borçlu türü seçin.'), { code: 400 });
    if (Object.hasOwn(d, 'icramatikFolioNumber')) {
      if (typeof d.icramatikFolioNumber !== 'string' || d.icramatikFolioNumber.length > 100)
        throw Object.assign(Error('İcramatik Föy No en fazla 100 karakter olmalıdır.'), { code: 400 });
      d.icramatikFolioNumber = d.icramatikFolioNumber.trim();
    }
    const events = eventsByDocument.get(d.id) || [];
    const oldDocument = previousDocuments.get(d.id);
    const oldReceivables = oldDocument?.receivables;
    if (oldReceivables && !Array.isArray(d.receivables))
      throw Object.assign(Error('Föyün alacak kalemleri korunmalıdır.'), { code: 400 });
    if (Array.isArray(d.receivables)) {
      const changed = !isDeepStrictEqual(oldReceivables, d.receivables);
      const managerPrincipalEdit =
        ['ceo', 'admin'].includes(actor?.role) &&
        require('./document-principal.cjs').principalAmountsOnly(oldDocument, d);
      if (changed && ['İnfaz', 'İade'].includes(oldDocument?.status) && !managerPrincipalEdit)
        throw Object.assign(Error('Kapanmış föyün alacak evrakları değiştirilemez.'), { code: 409 });
      if (
        changed &&
        oldDocument &&
        actor &&
        actor.role !== 'ceo' &&
        !managerPrincipalEdit &&
        (oldDocument.repaymentPlan ||
          state.data['hanhukuk-finance-v1'].some((event) => event.documentId === d.id))
      )
        throw Object.assign(
          Error('Finansal hareketli föyün alacak evraklarını yalnızca CEO değiştirebilir.'),
          { code: 403 },
        );
      if (
        d.docType !== 'Diğer' &&
        d.docType !== require('../outputs/icrapro/receivable-rules.js').storageType(d)
      )
        throw Object.assign(Error('Çoklu evrak föyü türü geçersiz.'), { code: 400 });
      try {
        require('../outputs/icrapro/receivable-rules.js').sync(
          d,
          today,
          require('../outputs/icrapro/parking-fees.js').parkingFeeInfo,
        );
      } catch (error) {
        throw Object.assign(error, { code: 400 });
      }
    }
    if (
      ['Senet', 'Diğer'].includes(d.docType) &&
      (d.originalAmount != null || d.preTrackingPayment != null)
    ) {
      const [total, paid, principal] = [d.originalAmount, d.preTrackingPayment, d.amount].map((value) =>
        Math.round(Number(value) * 100),
      );
      if (
        ![total, paid, principal].every(Number.isSafeInteger) ||
        paid < 0 ||
        principal < 0 ||
        total - paid !== principal
      ) {
        throw Object.assign(new Error('Evrak tutarı ve takip öncesi ödeme uyumsuz.'), { code: 400 });
      }
    }
    applyAutomaticLegalCharges(d, events, today);
    require('./document-principal.cjs').validatePrincipalChange(
      oldDocument,
      d,
      events,
      next.data['hanhukuk-accounting-v1'].entries,
      actor,
    );
    const previous = previousDocuments.get(d.id);
    const stamp = previous?.created ? new Date(previous.created) : null;
    d.trackingDate =
      previous?.trackingDate || (stamp && Number.isFinite(stamp.getTime()) ? businessDate(stamp) : today);
    if (d.status === 'İnfaz' && oldDocument && oldDocument.status !== 'İnfaz') {
      const receivedNow = events
        .filter((e) => e.type === 'payment' && !e.unitAllocation)
        .reduce((sum, e) => sum + e.amount, 0);
      const rawTarget =
        Math.round(Number(d.amount || 0) * 100) +
        Math.round(Number(d.financeInterest || 0) * 100) +
        Math.round(Number(d.financeFee || 0) * 100) +
        (d.docType === 'Yediemin Park Ücreti'
          ? 0
          : events.filter((e) => e.type === 'expense').reduce((sum, e) => sum + e.amount, 0)) -
        Number(d.debtDiscountCents || 0);
      const addedPayment = events.some((e) => e.type === 'payment' && !oldPaymentIds.has(e.id));
      if (!addedPayment || receivedNow < rawTarget)
        require('./manual-closure.cjs').closeManually(d, events, actor, today);
    }
    const payments = events.filter((e) => e.documentId === d.id && e.type === 'payment' && !e.unitAllocation),
      received = payments.reduce((sum, e) => sum + Number(e.amount || 0), 0),
      parking = d.docType === 'Yediemin Park Ücreti',
      total = Math.max(
        0,
        Math.round(Number(d.amount || 0) * 100) +
          Math.round(Number(d.financeInterest || 0) * 100) +
          Math.round(Number(d.financeFee || 0) * 100) +
          (parking
            ? 0
            : events
                .filter((e) => e.documentId === d.id && e.type === 'expense')
                .reduce((sum, e) => sum + Number(e.amount || 0), 0)) -
          Number(d.debtDiscountCents || 0),
      );
    if (total > 0 && received >= total) {
      d.status = 'İnfaz';
      d.closedDate =
        d.closedDate ||
        payments
          .map((e) => e.date)
          .sort()
          .at(-1);
    } else if (String(d.enforcementFileNumber || '').trim() && (!d.status || d.status === 'Derdest'))
      d.status = 'İcra';
    require('../outputs/icrapro/parking-waiting.js').syncParkingWaiting(d, today);
  }
  require('./currency-collection.cjs').synchronize(next, today, state);
  const duplicate = duplicateIdentityError(next.data['icrapro-v1'], state.data['icrapro-v1']);
  if (duplicate) throw Object.assign(Error(duplicate), { code: 409 });
  require('./test-records.cjs').markStateRecords(state, next, actor);
}

module.exports = { prepareState };
