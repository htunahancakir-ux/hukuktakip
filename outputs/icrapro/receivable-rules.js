(function (root) {
  const types = [
    'Senet',
    'Çek',
    'Sözleşme',
    'Cari Ekstre',
    'İlam',
    'Yediemin Park Ücreti',
    'Fatura',
    'Diğer',
  ];
  const cents = (value) => Math.round(Number(value || 0) * 100);
  const date = (value) => {
    const stamp = Date.parse(value + 'T00:00:00Z');
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(value || '') &&
      Number.isFinite(stamp) &&
      new Date(stamp).toISOString().slice(0, 10) === value
    );
  };
  function normalize(items) {
    if (!Array.isArray(items) || !items.length || items.length > 100)
      throw Error('En az bir, en fazla 100 alacak evrakı ekleyin.');
    const ids = new Set();
    return items.map((item) => {
      if (
        !item ||
        typeof item.id !== 'string' ||
        !item.id ||
        item.id.length > 100 ||
        ids.has(item.id) ||
        !types.includes(item.docType)
      )
        throw Error('Geçerli ve farklı evrak kayıtları ekleyin.');
      ids.add(item.id);
      const total = cents(item.amount),
        paid = cents(item.preTrackingPayment);
      if (![total, paid].every(Number.isSafeInteger) || total <= 0 || paid < 0 || paid > total)
        throw Error('Evrak tutarı pozitif, takip öncesi ödeme tutardan küçük veya eşit olmalıdır.');
      if (['Senet', 'Çek', 'Cari Ekstre', 'Fatura', 'Diğer'].includes(item.docType) && !date(item.due))
        throw Error(item.docType + ' için geçerli bir vade tarihi girin.');
      if (item.due && !date(item.due)) throw Error('Geçerli bir vade tarihi girin.');
      if (item.issued && (!date(item.issued) || (item.due && item.issued > item.due)))
        throw Error('Düzenleme tarihi geçerli olmalı ve vadeden sonra olmamalıdır.');
      if (item.docType === 'Çek' && !String(item.serial || '').trim()) throw Error('Çek numarasını girin.');
      if (
        item.docType === 'Yediemin Park Ücreti' &&
        (!date(item.parkingEntry) ||
          !['Motosiklet', 'Otomobil', 'Diğer'].includes(item.vehicleKind) ||
          item.parkingCommissionRate === '' ||
          item.parkingCommissionRate == null ||
          !Number.isFinite(Number(item.parkingCommissionRate)) ||
          Number(item.parkingCommissionRate) < 0 ||
          Number(item.parkingCommissionRate) > 100)
      )
        throw Error('Yediemin giriş tarihi, araç cinsi ve ofis payını girin.');
      const clean = {
        id: item.id,
        docType: item.docType,
        amount: total / 100,
        preTrackingPayment: paid / 100,
      };
      if (item.registeredOn && date(item.registeredOn)) clean.registeredOn = item.registeredOn;
      for (const key of [
        'due',
        'serial',
        'issued',
        'bank',
        'branch',
        'account',
        'contractSubject',
        'court',
        'courtFile',
        'decisionDate',
        'vehiclePlate',
        'chassisNumber',
        'parkingName',
        'parkingEntry',
        'vehicleKind',
        'invoiceSubject',
        'otherDocumentDescription',
        'notes',
      ]) {
        if (item[key] != null && typeof item[key] !== 'string') throw Error('Geçersiz evrak bilgisi.');
        clean[key] = String(item[key] || '').trim();
        if (clean[key].length > 3000) throw Error('Evrak açıklaması çok uzun.');
      }
      if (item.docType === 'Yediemin Park Ücreti')
        clean.parkingCommissionRate = Number(item.parkingCommissionRate);
      return clean;
    });
  }
  function summarize(doc, today, parkingFeeInfo) {
    const items = normalize(doc.receivables);
    let principal = 0,
      standardPrincipal = 0,
      parkingCommission = 0;
    for (const item of items) {
      if (item.docType === 'Yediemin Park Ücreti' && !['İnfaz', 'İade'].includes(doc.status)) {
        const info = parkingFeeInfo(item, today);
        if (!info || info.days <= 0) throw Error('Yediemin için geçerli giriş tarihi ve araç cinsi girin.');
        if (
          ![doc.identity, item.vehiclePlate, item.chassisNumber].some((value) => String(value || '').trim())
        )
          throw Error('Yediemin evrakına plaka veya şase numarası ya da borçluya TC/vergi numarası girin.');
        item.amount = info.amount / 100;
      }
      const amount = cents(item.amount) - cents(item.preTrackingPayment);
      principal += amount;
      if (item.docType === 'Yediemin Park Ücreti')
        parkingCommission += Math.round((amount * item.parkingCommissionRate) / 100);
      else standardPrincipal += amount;
    }
    if (!Number.isSafeInteger(principal) || !Number.isSafeInteger(parkingCommission))
      throw Error('Toplam alacak tutarı güvenli sınırı aşıyor.');
    const dates = items
      .filter((item) => item.docType !== 'Yediemin Park Ücreti' && item.due)
      .map((item) => item.due)
      .sort();
    return { items, principal, standardPrincipal, parkingCommission, due: dates[0] || '' };
  }
  function sync(doc, today, parkingFeeInfo) {
    if (!Array.isArray(doc.receivables)) return null;
    const result = summarize(doc, today, parkingFeeInfo);
    doc.receivables = result.items;
    doc.amount = result.principal / 100;
    doc.originalAmount = result.items.reduce((sum, item) => sum + cents(item.amount), 0) / 100;
    doc.preTrackingPayment =
      result.items.reduce((sum, item) => sum + cents(item.preTrackingPayment), 0) / 100;
    doc.due = result.due;
    doc.mixedParkingCommissionCents = result.parkingCommission;
    return result;
  }
  function charges(result, today, calculateInterest, calculateFee) {
    let amount = 0;
    const rows = [],
      receivables = [];
    for (const item of result.items) {
      if (item.docType === 'Yediemin Park Ücreti') continue;
      const principal = cents(item.amount) - cents(item.preTrackingPayment);
      const interest =
        principal > 0 && item.due && item.due < today
          ? calculateInterest(principal, item.due, today)
          : { amount: 0, rows: [], days: 0 };
      amount += interest.amount;
      rows.push(
        ...interest.rows.map((row) => ({
          ...row,
          receivableId: item.id,
          docType: item.docType,
          serial: item.serial,
        })),
      );
      receivables.push({
        id: item.id,
        docType: item.docType,
        serial: item.serial,
        start: item.due,
        principal,
        amount: interest.amount,
      });
    }
    const fee =
      result.standardPrincipal > 0
        ? calculateFee(result.standardPrincipal + amount, result.standardPrincipal, false)
        : { amount: 0, rows: [], early: false };
    return {
      interest: { amount, rows, days: rows.reduce((sum, row) => sum + row.days, 0), receivables },
      fee,
      base: result.standardPrincipal + amount,
    };
  }
  const api = { types, normalize, summarize, sync, charges };
  if (typeof module !== 'undefined') module.exports = api;
  else root.HanReceivables = api;
})(globalThis);
