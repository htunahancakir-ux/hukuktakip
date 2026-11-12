const { balance } = require('./record-store/balances.cjs');
const { recognizedCollectionRevenue } = require('../outputs/icrapro/profit-rules.js');
function normalizeParkingCollection(doc, event, previous, today, wasClosed = doc?.status === 'İnfaz') {
  if (doc?.docType !== 'Yediemin Park Ücreti' || event.type !== 'payment') return wasClosed;
  const fail = (message) => {
    throw Object.assign(Error(message), { code: 400, status: 400 });
  };
  const rate = Number(doc.parkingCommissionRate);
  if (
    doc.parkingCommissionRate == null ||
    doc.parkingCommissionRate === '' ||
    !Number.isFinite(rate) ||
    rate < 0 ||
    rate > 100
  )
    fail('Önce geçerli anlaşma yüzdesini girip kaydedin.');
  if (!Number.isSafeInteger(event.amount) || event.amount <= 0)
    fail('Geçerli pozitif tahsilat tutarı girin.');
  const money = balance(doc, previous, today);
  const received = Number(money.received_cents),
    total = received + event.amount;
  if (!Number.isSafeInteger(total)) fail('Tahsilat toplamı güvenli tutar sınırını aşıyor.');
  const closes = !wasClosed && total >= Number(money.target_cents);
  const previousProfit = wasClosed
    ? previous
        .filter((e) => e.documentId === doc.id)
        .reduce((sum, e) => sum + recognizedCollectionRevenue(e, previous, { ...doc, status: 'İnfaz' }), 0)
    : 0;
  event.parkingPostClosure = wasClosed;
  event.parkingCommissionRate = rate;
  event.principalAtCollection = Number(money.principal_cents);
  event.closes = closes;
  event.closedAmount = closes ? Number(money.target_cents) : 0;
  event.revenuePart = wasClosed || closes ? Math.round((total * rate) / 100) - previousProfit : 0;
  event.clientShare = event.amount - event.revenuePart;
  return wasClosed || closes;
}
module.exports = { normalizeParkingCollection };
