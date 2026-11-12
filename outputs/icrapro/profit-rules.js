(function (root) {
  function recognizedCollectionRevenue(event, events, doc) {
    if (event.type !== 'payment') return 0;
    if (doc?.docType === 'Yediemin Park Ücreti' && doc.status !== 'İnfaz') return 0;
    if (doc?.status === 'İade') return Number(event.amount || 0);
    if (doc?.principalAdjustment && doc.status !== 'İnfaz') return 0;
    const payments = events.filter((e) => e.documentId === event.documentId && e.type === 'payment');
    const parking =
      (event.parkingCommissionRate !== undefined &&
        event.parkingCommissionRate !== null &&
        event.parkingCommissionRate !== '') ||
      doc?.docType === 'Yediemin Park Ücreti';
    if (parking && event.parkingPostClosure === true) return Number(event.revenuePart || 0);
    const settlement = parking ? payments.filter((e) => e.parkingPostClosure !== true) : payments;
    const closing = doc?.status === 'İnfaz' ? settlement.at(-1) : settlement.filter((e) => e.closes).at(-1);
    if (!closing || (event !== closing && (!event.id || event.id !== closing.id))) return 0;
    const received = settlement.reduce((sum, e) => sum + Number(e.amount || 0), 0);
    if (parking)
      return Math.round(
        (received * Number(event.parkingCommissionRate ?? doc?.parkingCommissionRate ?? 0)) / 100,
      );
    const principal = doc?.principalAdjustment
      ? Math.round(Number(doc.amount || 0) * 100)
      : (event.principalAtCollection ?? (doc ? Math.round(Number(doc.amount || 0) * 100) : null));
    return principal === null
      ? payments.reduce((sum, e) => sum + Number(e.revenuePart || 0), 0)
      : Math.max(0, received - Number(principal)) + Number(doc?.mixedParkingCommissionCents || 0);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { recognizedCollectionRevenue };
  else root.recognizedCollectionRevenue = recognizedCollectionRevenue;
})(typeof window !== 'undefined' ? window : this);
