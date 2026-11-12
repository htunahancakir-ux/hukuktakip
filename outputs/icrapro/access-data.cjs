const { validateNewClientPayouts, appendClientPayout } = require('../../lib/client-payout.cjs');
const { apply: applyRecordPatch } = require('./record-patch.js');
const expensePool = require('../../lib/expense-pool.cjs');
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
  if (url.pathname === '/api/personnel-attachments' && req.method === 'GET') {
    if (!['ceo', 'admin'].includes(u.role)) throw fail(403, 'Personel ekleri için yönetici yetkisi gerekli.');
    const personnelId = url.searchParams.get('personnelId'),
      attachmentId = url.searchParams.get('attachmentId');
    if (!ctx.state.data['icrapro-personnel-v1'].some((person) => person.id === personnelId))
      throw fail(404, 'Personel bulunamadı.');
    const files = (ctx.state.personnelAttachments || []).filter((row) => row.personnelId === personnelId);
    if (attachmentId) {
      const file = files.find((row) => row.id === attachmentId);
      if (!file) throw fail(404, 'Ek bulunamadı.');
      send(res, 200, { attachment: file.attachment });
    } else
      send(res, 200, {
        items: files.map((row) => ({
          id: row.id,
          name: row.attachment.name,
          mime: row.attachment.mime,
          createdAt: row.attachment.createdAt,
        })),
      });
    return true;
  }
  if (url.pathname === '/api/record-attachments' && req.method === 'POST') {
    const result = require('../../lib/record-attachments.cjs').appendAttachment(
      ctx.state,
      await body(req),
      u,
      allowed,
    );
    if (result.next) persist(result.next);
    const { data, ...attachment } = result.attachment;
    send(res, 200, { ok: true, attachment });
    return true;
  }
  if (url.pathname === '/api/expense-pool' && req.method === 'GET') {
    if (!allowed(u, 'documents')) throw fail(403, 'Dosya işlem yetkiniz yok.');
    send(res, 200, expensePool.details(ctx.state));
    return true;
  }
  if (url.pathname === '/api/expense-pool/fund' && req.method === 'POST') {
    const result = expensePool.fund(ctx.state, await body(req), u, allowed, ledgerBalance);
    if (result.next) persist(result.next);
    send(res, 200, { ok: true, entry: result.entry, ...expensePool.summary(ctx.state) });
    return true;
  }
  if (url.pathname === '/api/expense-pool/allocate' && req.method === 'POST') {
    const result = expensePool.allocate(ctx.state, await body(req), u, allowed);
    if (result.next) persist(result.next);
    send(res, 200, { ok: true, event: result.event, ...expensePool.summary(ctx.state) });
    return true;
  }
  if (url.pathname === '/api/client-payout' && req.method === 'POST') {
    const next = appendClientPayout(ctx.state, await body(req), u, options?.payoutAccountBalances);
    if (next) persist(next);
    send(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/cash-entry' && req.method === 'POST') {
    const next = require('../../lib/cash-entry.cjs').appendCashEntry(
      ctx.state,
      await body(req),
      u,
      allowed,
      options?.cashAccountBalances,
      ledgerBalance,
    );
    if (next) persist(next);
    send(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/data' || url.pathname === '/api/data/patch') {
    const patchRequest = url.pathname === '/api/data/patch';
    const key = url.searchParams.get('key');
    if (!dataKeys.includes(key)) throw fail(404, 'Veri bulunamadı.');
    res.hanDataKey = key;
    if (req.method === 'GET' && !patchRequest) {
      res.setHeader('ETag', revision(key));
      send(res, 200, readKey(key, u));
      return true;
    }
    if (req.method !== 'PUT') throw fail(405, 'Yöntem desteklenmiyor.');
    if (!patchRequest && options.requireRevision && !req.headers['if-match'])
      throw fail(428, 'Önce güncel kaydı yükleyin.');
    if (!patchRequest && req.headers['if-match'] && req.headers['if-match'] !== revision(key))
      throw fail(409, 'Kayıt başka bir işlemle değişti. Sayfayı yenileyip tekrar deneyin.');
    const incoming = await body(req);
    if (patchRequest && key === 'icrapro-v1' && Array.isArray(incoming?.changes)) {
      incoming.changes = incoming.changes.filter(
        (change) => !(change.path?.[0] === 'docs' && change.field === 'conversationReport'),
      );
      if (!incoming.changes.length) {
        send(res, 200, { ok: true, records: [] });
        return true;
      }
    }
    if (
      patchRequest &&
      key === 'icrapro-v1' &&
      incoming?.changes?.some((change) => change.path?.[0] === 'clients') &&
      !allowed(u, 'clients')
    )
      throw fail(403, 'Müvekkil kayıtlarını değiştirme yetkiniz yok.');
    if (key === 'icrapro-v1' && !['ceo', 'admin'].includes(u.role)) {
      const protectedFields = [
        'repaymentPlan',
        'repaymentPlanHistory',
        'debtDiscountCents',
        'discountHistory',
        'financeInterest',
        'financeFee',
        'financeTermsManual',
      ];
      if (patchRequest && Array.isArray(incoming?.changes)) {
        for (const change of incoming.changes) {
          if (change.path?.[0] !== 'docs') continue;
          if (change.field && protectedFields.includes(change.field))
            throw fail(403, 'Yapılandırmayı yalnızca yönetici yapabilir.');
          if (!change.field && change.value) {
            const old = ctx.state.data[key].docs.find((d) => d.id === change.id) || {};
            if (
              protectedFields.some(
                (field) => JSON.stringify(old[field]) !== JSON.stringify(change.value[field]),
              )
            )
              throw fail(403, 'Yapılandırmayı yalnızca yönetici yapabilir.');
          }
        }
      } else if (!patchRequest && Array.isArray(incoming?.value?.docs)) {
        for (const doc of incoming.value.docs) {
          const old = ctx.state.data[key].docs.find((d) => d.id === doc.id) || {};
          if (protectedFields.some((field) => JSON.stringify(old[field]) !== JSON.stringify(doc[field])))
            throw fail(403, 'Yapılandırmayı yalnızca yönetici yapabilir.');
        }
      }
    }
    const sendSaved = () => {
      if (!patchRequest || !options.recordStore) return send(res, 200, { ok: true });
      const current = readKey(key, u),
        seen = new Set(),
        records = [];
      for (const change of incoming.changes) {
        const identity = JSON.stringify([change.path, change.id]);
        if (seen.has(identity)) continue;
        seen.add(identity);
        const rows = change.path.reduce((value, part) => value?.[part], current);
        const value = rows.find((row) => row.id === change.id) || null;
        const preservedFields = [];
        if (key === 'icrapro-v1' && value)
          for (const field of ['fileData', 'photoData', 'attachments']) {
            if (!Object.hasOwn(value, field)) continue;
            preservedFields.push(field);
            delete value[field];
          }
        records.push({
          path: change.path,
          id: change.id,
          value,
          preservedFields,
        });
      }
      send(res, 200, { ok: true, records });
    };
    const v = patchRequest ? { value: applyRecordPatch(key, readKey(key, u), incoming) } : incoming,
      next = structuredClone(ctx.state);
    expensePool.guardGenericChanges(ctx.state, key, v.value);
    if (key === 'icrapro-v1' && ['ceo', 'admin'].includes(u.role) && Array.isArray(v.value?.docs)) {
      for (const doc of v.value.docs) {
        const before = ctx.state.data[key].docs.find((d) => d.id === doc.id);
        if (
          !before ||
          !['financeInterest', 'financeFee'].some(
            (field) => Number(before[field] || 0) !== Number(doc[field] || 0),
          )
        )
          continue;
        if (u.role !== 'ceo' && before.status === 'İnfaz')
          throw fail(403, 'İnfaz edilmiş dosyada faiz ve ücret değiştirilemez.');
        const amounts = [doc.amount, doc.financeInterest, doc.financeFee].map((value) =>
          Math.round(Number(value || 0) * 100),
        );
        if (amounts.some((value) => !Number.isSafeInteger(value) || value < 0))
          throw fail(400, 'Faiz ve ücret için geçerli tutarlar girin.');
        const events = ctx.state.data['hanhukuk-finance-v1'].filter((event) => event.documentId === doc.id);
        const received = events
          .filter((event) => event.type === 'payment')
          .reduce((sum, event) => sum + event.amount, 0);
        const expense = events
          .filter((event) => event.type === 'expense')
          .reduce((sum, event) => sum + event.amount, 0);
        const total = Math.max(
          0,
          amounts.reduce((sum, value) => sum + value, 0) + expense - Number(doc.debtDiscountCents || 0),
        );
        if (!Number.isSafeInteger(total) || (u.role !== 'ceo' && received > 0 && received >= total))
          throw fail(400, 'Yeni toplam borç, alınmış tahsilattan yüksek olmalıdır.');
      }
    }
    if (
      ['ceo', 'admin'].includes(u.role) ||
      (key === 'hanhukuk-accounting-v1' &&
        require('../../lib/accounting-access.cjs').accountingStaff(
          u,
          ctx.state.data['icrapro-personnel-v1'],
        )) ||
      (key === 'hanhukuk-finance-v1' && allowed(u, 'documents'))
    ) {
      if (key === 'hanhukuk-accounting-v1') validateNewClientPayouts(ctx.state, v.value, u);
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
        const parkingProcessed = [],
          parkingClosed = new Map();
        for (const event of v.value) {
          if (priorIds.has(event.id)) continue;
          priorIds.add(event.id);
          event.operatorId = u.id;
          event.operatorName = u.name;
          delete event.turnoverCategory;
          if (event.type === 'payment' && ['ceo', 'admin'].includes(u.role) && !event.turnoverStaffId)
            throw fail(400, 'Ciroyu yapan personeli seçin.');
          if (event.turnoverStaffId) {
            if (event.type !== 'payment' || !['ceo', 'admin'].includes(u.role))
              throw fail(403, 'Ciro personelini yalnızca yönetici seçebilir.');
            const staff = ctx.state.data['icrapro-personnel-v1'].find(
              (person) => person.id === event.turnoverStaffId && person.active,
            );
            const category = require('../../lib/turnover-categories.cjs').categoryName(event.turnoverStaffId);
            if (!staff && !category) throw fail(400, 'Aktif personel veya geçerli bir ciro türü seçin.');
            event.turnoverStaffName = category || staff.name;
            if (category) event.turnoverCategory = event.turnoverStaffId;
          } else {
            delete event.turnoverStaffId;
            delete event.turnoverStaffName;
          }
          if (event.type === 'payment') {
            const document = ctx.state.data['icrapro-v1'].docs.find((d) => d.id === event.documentId);
            const closed = require('../../lib/parking-collection.cjs').normalizeParkingCollection(
              document,
              event,
              [...ctx.state.data[key], ...parkingProcessed],
              parkingToday(),
              parkingClosed.get(event.documentId) ?? document?.status === 'İnfaz',
            );
            if (document?.docType === 'Yediemin Park Ücreti') {
              parkingClosed.set(event.documentId, closed);
              parkingProcessed.push(event);
            } else delete event.parkingPostClosure;
            event.collectionStaffId = event.turnoverStaffId || document?.relatedStaff || '';
            event.collectionStaffName =
              (event.turnoverCategory ? event.turnoverStaffName : '') ||
              ctx.state.data['icrapro-personnel-v1'].find((p) => p.id === event.collectionStaffId)?.name ||
              '';
            if (
              !event.turnoverCategory &&
              !ctx.state.data['icrapro-personnel-v1'].some(
                (p) => p.id === event.collectionStaffId && p.active,
              )
            )
              throw fail(400, 'Tahsilat için aktif bir ciro personeli seçilmeli veya dosyaya atanmalıdır.');
          }
          if (event.type === 'payment' && Number.isSafeInteger(event.amount) && event.amount > 0) {
            next.collectionNoticeSequence = Number(next.collectionNoticeSequence || 0) + 1;
            next.collectionNotices = [
              ...(next.collectionNotices || []),
              {
                sequence: next.collectionNoticeSequence,
                eventId: event.id,
                operatorName: u.name,
                collectionStaffId: event.turnoverCategory ? u.staffId || '' : event.collectionStaffId,
                collectionStaffName: event.turnoverCategory ? u.name : event.collectionStaffName,
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
          // This field is generated by the server, never supplied by a data patch.
          if (before?.conversationReport) d.conversationReport = before.conversationReport;
          else delete d.conversationReport;
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
            if (JSON.stringify(d.conversations) !== JSON.stringify(before.conversations || []))
              delete d.conversationReport;
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
      sendSaved();
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
        'debtorType',
        'taxOffice',
        'identity',
        'officeIdentity',

        'receivables',
        'enforcementOffice',
        'enforcementFileNumber',
        'attachments',
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
    sendSaved();
    return true;
  }
  return false;
}

module.exports = { handleDataRoutes };
