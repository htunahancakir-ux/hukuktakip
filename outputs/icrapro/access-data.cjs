const { validateNewClientPayouts, appendClientPayout } = require('../../lib/client-payout.cjs');
async function handleDataRoutes(ctx) {
  const {
    req,
    res,
    url,
    u,
    options,
    revision,
    persist,
    invalidate,
    allowed,
    fail,
    body,
    send,
    readKey,
    ledgerBalance,
    crypto,
    dataKeys,
    parkingToday,
    applyParkingFee,
  } = ctx;
  if (url.pathname === '/api/client-payout' && req.method === 'POST') {
    const next = appendClientPayout(ctx.state, await body(req), u);
    if (next) persist(next);
    send(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/cash-entry' && req.method === 'POST') {
    const v = await body(req);
    const external = v.type === 'external';
    if (external && !['yes', 'no'].includes(v.profitChoice)) throw fail(400, 'Kâr seçimini yapın.');
    if (external) v.type = 'in';
    if (v.type === 'advance' && !['T.Ç', 'S.S', 'Diğer'].includes(v.advanceType))
      throw fail(400, 'Avans türünü seçin.');
    if (!['in', 'out', 'advance'].includes(v.type) || !allowed(u, v.type === 'in' ? 'cashIn' : 'cashOut'))
      throw fail(403, 'Bu para işlemi için yetkiniz yok.');
    const amount = Number(v.amount),
      ledger = ctx.state.data['hanhukuk-accounting-v1'];
    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      !ledger.accounts.some((a) => a.id === v.accountId) ||
      !String(v.note || '').trim() ||
      !/^\d{4}-\d{2}-\d{2}$/.test(v.date) ||
      !Number.isFinite(Date.parse(v.date))
    )
      throw fail(400, 'Geçerli hesap, tarih, tutar ve açıklama girin.');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(new Date());
    if (v.date > today) throw fail(400, 'Gelecek tarihli işlem yapılamaz.');
    if (
      (v.type === 'out' && !String(v.expenseCategory || '').trim()) ||
      (['out', 'advance'].includes(v.type) && ledgerBalance(v.accountId) < amount)
    )
      throw fail(400, 'Gider kalemi eksik veya bakiye yetersiz.');
    const next = structuredClone(ctx.state);
    next.data['hanhukuk-accounting-v1'].entries.push({
      id: crypto.randomUUID(),
      type: v.type,
      amount,
      accountId: v.accountId,
      date: v.date,
      note: String(v.note).trim(),
      expenseCategory: v.type === 'out' ? v.expenseCategory : undefined,
      advanceType: v.type === 'advance' ? v.advanceType : undefined,
      entryKind: external ? 'external' : undefined,
      includeInProfit: external && v.profitChoice === 'yes',
      operatorId: u.id,
      operatorName: u.name,
      createdAt: new Date().toISOString(),
    });
    persist(next);
    send(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/data') {
    const key = url.searchParams.get('key');
    if (!dataKeys.includes(key)) throw fail(404, 'Veri bulunamadı.');
    res.hanDataKey = key;
    if (req.method === 'GET') {
      res.setHeader('ETag', revision(key));
      send(res, 200, readKey(key, u));
      return true;
    }
    if (req.method !== 'PUT') throw fail(405, 'Yöntem desteklenmiyor.');
    if (options.requireRevision && !req.headers['if-match']) throw fail(428, 'Önce güncel kaydı yükleyin.');
    if (req.headers['if-match'] && req.headers['if-match'] !== revision(key))
      throw fail(409, 'Kayıt başka bir işlemle değişti. Sayfayı yenileyip tekrar deneyin.');
    const v = await body(req),
      next = structuredClone(ctx.state);
    if (['ceo', 'admin'].includes(u.role) || (key === 'hanhukuk-finance-v1' && allowed(u, 'documents'))) {
      if (key === 'hanhukuk-accounting-v1') validateNewClientPayouts(ctx.state,v.value,u);
      if (key === 'hanhukuk-finance-v1') {
        if (!Array.isArray(v.value)) throw fail(400, 'Geçersiz finans kaydı.');
        if (!['ceo', 'admin'].includes(u.role)) {
          for (const old of ctx.state.data[key]) {
            const incoming = v.value.find((e) => e.id === old.id);
            if (!incoming || JSON.stringify(incoming) !== JSON.stringify(old))
              throw fail(403, 'Mevcut finans hareketleri değiştirilemez.');
          }
        }
        const priorIds = new Set(ctx.state.data[key].map((e) => e.id));
        for (const event of v.value) {
          if (priorIds.has(event.id)) continue;
          priorIds.add(event.id);
          event.operatorId = u.id;
          event.operatorName = u.name;
          if (event.turnoverStaffId) {
            if (event.type !== 'payment' || !['ceo', 'admin'].includes(u.role))
              throw fail(403, 'Ciro personelini yalnızca yönetici seçebilir.');
            const staff = ctx.state.data['icrapro-personnel-v1'].find(
              (person) => person.id === event.turnoverStaffId && person.active,
            );
            if (!staff) throw fail(400, 'Aktif bir ciro personeli seçin.');
            event.turnoverStaffName = staff.name;
          } else {
            delete event.turnoverStaffId;
            delete event.turnoverStaffName;
          }
          if (event.type === 'payment') {
            const document = ctx.state.data['icrapro-v1'].docs.find((d) => d.id === event.documentId);
            event.collectionStaffId = event.turnoverStaffId || document?.relatedStaff || '';
            event.collectionStaffName =
              ctx.state.data['icrapro-personnel-v1'].find((p) => p.id === event.collectionStaffId)?.name ||
              '';
          }
          if (event.type === 'payment' && Number.isSafeInteger(event.amount) && event.amount > 0) {
            next.collectionNoticeSequence = Number(next.collectionNoticeSequence || 0) + 1;
            next.collectionNotices = [
              ...(next.collectionNotices || []),
              {
                sequence: next.collectionNoticeSequence,
                eventId: event.id,
                operatorName: u.name,
                amount: event.amount,
                closes: event.closes === true,
                createdAt: new Date().toISOString(),
              },
            ].slice(-1000);
          }
        }
      }
      if (key === 'icrapro-v1') {
        for (const d of v.value.docs) {
          const before = ctx.state.data[key].docs.find((x) => x.id === d.id);
          if (before) {
            d.linkedDocumentIds = before.linkedDocumentIds;
            d.chainUpdatedBy = before.chainUpdatedBy;
            d.chainUpdatedAt = before.chainUpdatedAt;
            if (Number(d.assignmentVersion || 0) !== Number(before.assignmentVersion || 0)) {
              d.relatedStaff = before.relatedStaff;
              d.relatedStaffName = before.relatedStaffName;
            }
            d.conversations = [
              ...(before.conversations || []),
              ...(d.conversations || [])
                .filter((c) => !(before.conversations || []).some((old) => old.id === c.id))
                .map((c) => ({
                  ...c,
                  staff: u.staffId || u.id,
                  staffName: u.name,
                  operatorId: u.id,
                  createdAt: new Date().toISOString(),
                })),
            ];
            d.assignmentVersion = before.assignmentVersion;
            d.assignmentHistory = before.assignmentHistory;
            d.noCallWarningKey = before.noCallWarningKey;
            d.paymentPromise = before.paymentPromise;
            d.paymentPromiseHistory = before.paymentPromiseHistory;
          }
          if (String(d.relatedStaff || '') !== String(before?.relatedStaff || '')) {
            const staff = ctx.state.data['icrapro-personnel-v1'].find(
              (p) => p.id === d.relatedStaff && p.active === true,
            );
            if (d.relatedStaff && !staff) throw fail(400, 'Dosya sorumlusu aktif personel olmalıdır.');
            d.relatedStaffName = staff?.name || '';
            d.assignmentVersion = Number(before?.assignmentVersion || 0) + 1;
            d.assignmentHistory = [
              ...(before?.assignmentHistory || []),
              {
                from: before?.relatedStaff || '',
                to: d.relatedStaff || '',
                staffName: staff?.name || '',
                assignedBy: u.id,
                assignedByName: u.name,
                date: new Date().toISOString(),
              },
            ];
          }
        }
      }
      next.data[key] = v.value;
      if (key === 'icrapro-personnel-v1')
        for (const account of ctx.state.users) {
          if (account.staffId && !v.value.some((p) => p.id === account.staffId && p.active !== false))
            invalidate(account.id);
        }
      if (key === 'icrapro-v1') next.data[key].docs.forEach((d) => applyParkingFee(d, parkingToday()));
      persist(next);
      send(res, 200, { ok: true });
      return true;
    }
    if (key !== 'icrapro-v1') throw fail(403, 'Bu veriyi değiştirme yetkiniz yok.');
    const old = structuredClone(ctx.state.data[key]),
      value = v.value;
    old.docs.forEach((d) => applyParkingFee(d, parkingToday()));
    if (!Array.isArray(value?.clients) || !Array.isArray(value?.docs)) throw fail(400, 'Geçersiz kayıt.');
    if (allowed(u, 'clients')) next.data[key].clients = value.clients;
    else if (JSON.stringify(value.clients) !== JSON.stringify(readKey(key, u).clients))
      throw fail(403, 'Müvekkil değiştirme yetkiniz yok.');
    if (allowed(u, 'documents')) {
      const permitted = new Set([
        'id',
        'number',
        'created',
        'updatedAt',
        'docType',
        'client',
        'clientParty',
        'debtor',
        'identity',
        'additionalPhones',
        'additionalAddresses',
        'phone1',
        'phone2',
        'referencePhone1',
        'referencePhone2',
        'officePhone1',
        'officePhone2',
        'city',
        'district',
        'address',
        'address2',
        'address2City',
        'address2District',
        'officeAddress3',
        'officeAddress3City',
        'officeAddress3District',
        'amount',
        'originalAmount',
        'preTrackingPayment',
        'due',
        'issued',
        'serial',
        'deliveredBy',
        'receivedBy',
        'receivedById',
        'recordedBy',
        'recordedByName',
        'status',
        'closedDate',
        'repaymentPlan',
        'repaymentPlanHistory',
        'debtDiscountCents',
        'discountHistory',
        'originalDocument',
        'fileName',
        'fileData',
        'photoFileName',
        'photoData',
        'notes',
        'guarantors',
        'tapuStatus',
        'tapuDetails',
        'vehicleStatus',
        'vehicleDetails',
        'sgkStatus',
        'sgkDetails',
        'captureStatus',
        'captureDetails',
        'bank',
        'branch',
        'account',
        'contractSubject',
        'periodStart',
        'periodEnd',
        'court',
        'courtFile',
        'decisionDate',
        'vehiclePlate',
        'vehicleKind',
        'chassisNumber',
        'parkingName',
        'parkingEntry',
        'parkingExit',
        'parkingCommissionRate',
        'parkingDailyPricing',
        'invoiceSubject',
        'otherDocumentDescription',
      ]);
      if (old.docs.some((d) => !value.docs.some((x) => x.id === d.id)))
        throw fail(403, 'Evrak silme yetkiniz yok.');
      next.data[key].docs = value.docs.map((d) => {
        const before = old.docs.find((x) => x.id === d.id);
        if (
          before &&
          ['financeInterest', 'financeFee'].some((key) => Number(d[key] || 0) !== Number(before[key] || 0))
        )
          throw fail(403, 'Faiz ve avukatlık ücretini yalnızca CEO ve yönetici değiştirebilir.');
        if (d.status === 'İade' && before?.status !== 'İade')
          throw fail(403, 'Dosyayı iadeye yalnızca yönetici alabilir.');
        if (before && Number(d.amount || 0) !== Number(before.amount || 0))
          throw fail(403, 'Ana bor? tutar?n? yaln?zca y?netici de?i?tirebilir.');
        if (String(d.relatedStaff || '') !== String(before?.relatedStaff || ''))
          throw fail(403, 'Dosya sorumlusunu yalnızca yönetici atayabilir.');
        const clean = Object.fromEntries(Object.entries(d).filter(([k]) => permitted.has(k)));
        if (before) {
          const locked =
            ctx.state.data['hanhukuk-finance-v1'].some((e) => e.documentId === d.id) || before.repaymentPlan;
          if (
            locked &&
            [
              'amount',
              'originalAmount',
              'preTrackingPayment',
              'due',
              'parkingCommissionRate',
              'parkingEntry',
              'vehicleKind',
            ].some(
              (k) =>
                String(clean[k] ?? '') !==
                String(
                  before[k] ??
                    (k === 'originalAmount' && ['Senet', 'Diğer'].includes(clean.docType)
                      ? before.amount
                      : k === 'preTrackingPayment' && ['Senet', 'Diğer'].includes(clean.docType)
                        ? 0
                        : ''),
                ),
            )
          )
            throw fail(403, 'Finansal hareketli evrakın tutar/vadesi değiştirilemez.');
          const merged = { ...before, ...clean, id: before.id, number: before.number };
          applyParkingFee(merged, parkingToday());
          return merged;
        }
        const fresh = { ...clean, status: 'Derdest' };
        applyParkingFee(fresh, parkingToday());
        return fresh;
      });
    } else if (value.docs.length) throw fail(403, 'Evrak değiştirme yetkiniz yok.');
    persist(next);
    send(res, 200, { ok: true });
    return true;
  }
  return false;
}

module.exports = { handleDataRoutes };
