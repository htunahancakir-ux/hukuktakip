(function (root) {
  function sixMonthsAfter(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return '';
    const date = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== value) return '';
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 7, 0));
    return new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), Math.min(date.getUTCDate(), end.getUTCDate())),
    )
      .toISOString()
      .slice(0, 10);
  }
  function parkingWaitingInfo(doc, today) {
    const items = Array.isArray(doc.receivables)
      ? doc.receivables.filter((item) => item.docType === 'Yediemin Park Ücreti')
      : doc.docType === 'Yediemin Park Ücreti'
        ? [doc]
        : [];
    if (!items.length || ['İnfaz', 'İade'].includes(doc.status)) return null;
    const dates = items.map((item) => sixMonthsAfter(item.parkingEntry));
    const readyOn = dates.every(Boolean) ? dates.sort().at(-1) : '';
    return { readyOn, waiting: !readyOn || today < readyOn };
  }
  function syncParkingWaiting(doc, today) {
    const info = parkingWaitingInfo(doc, today);
    if (!info) return false;
    const before = JSON.stringify([doc.status, doc.parkingProcessOn, doc.parkingWaitingVersion]);
    if (info.waiting) doc.status = 'Bekleme';
    else if (!doc.status || doc.status === 'Bekleme') doc.status = 'Derdest';
    doc.parkingProcessOn = info.readyOn;
    doc.parkingWaitingVersion = 1;
    return before !== JSON.stringify([doc.status, doc.parkingProcessOn, doc.parkingWaitingVersion]);
  }
  const api = { sixMonthsAfter, parkingWaitingInfo, syncParkingWaiting };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(globalThis);
