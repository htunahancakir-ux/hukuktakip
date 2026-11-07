const { archiveRemovedDocuments, preventArchivedNumberReuse } = require('./document-archive.cjs');
const { normalizePhoneRecords } = require('../outputs/icrapro/phone-format.js');
const { syncPayrollPeriods } = require('../outputs/icrapro/payroll-periods.cjs');
const { applyAutomaticLegalCharges } = require('../outputs/icrapro/legal-charges.cjs');
const { duplicateIdentityError } = require('../outputs/icrapro/identity-validation.cjs');
const { businessDate } = require('./business-time.cjs');
const { assertDeletionAllowed } = require('./deletion-policy.cjs');
function prepareState(state, next, actor) {
  if (actor) assertDeletionAllowed(state, next, actor);
  const today = businessDate();
  const previousDocuments = new Map(state.data['icrapro-v1'].docs.map((doc) => [doc.id, doc]));
  const eventsByDocument = new Map();
  for (const event of next.data['hanhukuk-finance-v1']) {
    if (!eventsByDocument.has(event.documentId)) eventsByDocument.set(event.documentId, []);
    eventsByDocument.get(event.documentId).push(event);
  }
  if (actor) archiveRemovedDocuments(state, next, actor);
  delete next.data['icrapro-v1'].archivedNumbers;
  preventArchivedNumberReuse(state, next);
  normalizePhoneRecords(next.data);
  syncPayrollPeriods(next, today);
  for (const d of next.data['icrapro-v1'].docs) {
    const events = eventsByDocument.get(d.id) || [];
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
    const previous = previousDocuments.get(d.id);
    const stamp = previous?.created ? new Date(previous.created) : null;
    d.trackingDate =
      previous?.trackingDate || (stamp && Number.isFinite(stamp.getTime()) ? businessDate(stamp) : today);
    const payments = events.filter((e) => e.documentId === d.id && e.type === 'payment'),
      received = payments.reduce((sum, e) => sum + Number(e.amount || 0), 0),
      parking = d.docType === 'Yediemin Park Ücreti',
      total = Math.max(
        0,
        Math.round(Number(d.amount || 0) * 100) +
          (parking
            ? 0
            : Math.round(Number(d.financeInterest || 0) * 100) +
              Math.round(Number(d.financeFee || 0) * 100) +
              events
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
  }
  const duplicate = duplicateIdentityError(next.data['icrapro-v1'], state.data['icrapro-v1']);
  if (duplicate) throw Object.assign(Error(duplicate), { code: 409 });
}

module.exports = { prepareState };
