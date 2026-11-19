const crypto = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');
const { actor } = require('./queries.cjs');
const workbook = require('../excel-workbook.cjs');
const fields = require('../excel-import-fields.cjs');
const { fold, amount, date } = fields;
const { businessDate } = require('../business-time.cjs');
const receivables = require('../../outputs/icrapro/receivable-rules.js');
const units = require('../../outputs/icrapro/receivable-units.js');
const phone = require('../../outputs/icrapro/phone-format.js').formatPhoneNumber;
const { markRecord } = require('../test-records.cjs');
const bad = workbook.bad;
const manager = (user) => ['ceo', 'admin'].includes(user.role);
function authorize(user, kind, commit = false) {
  if (!['clients', 'documents'].includes(kind)) throw bad('Aktarım türü geçersiz.');
  if (
    user.platformSupport ||
    (commit && user.readOnly && user.role !== 'ceo') ||
    (!manager(user) && !user.permissions?.includes(kind))
  )
    throw Object.assign(Error('Bu aktarım için kayıt yetkiniz yok.'), { status: 403 });
  if (commit) require('../module-permissions.cjs').assertModuleAction(user, kind, 'create');
}
function id(...values) {
  const h = crypto.createHash('sha256').update(values.join('|')).digest('hex');
  return (
    h.slice(0, 8) +
    '-' +
    h.slice(8, 12) +
    '-5' +
    h.slice(13, 16) +
    '-a' +
    h.slice(17, 20) +
    '-' +
    h.slice(20, 32)
  );
}
const keyName = (value) => fold(value || '');
function findStaff(context, value, { han = false } = {}) {
  if (!value) return null;
  if (han && ['han', 'receiverhan'].includes(fold(value))) return { id: 'receiver:han', name: 'HAN' };
  const matches = context.personnel.filter(
    (p) => p.active !== false && (p.id === value || fold(p.name) === fold(value)),
  );
  if (matches.length !== 1)
    throw bad('Personel bulunamadı veya aynı isimde birden fazla personel var: ' + value);
  return matches[0];
}
function contact(v) {
  const identity = String(v.identityClient || v.identity || '').replace(/\s/g, '');
  if (identity && !/^\d{10,11}$/.test(identity)) throw bad('TC / vergi numarası 10 veya 11 rakam olmalıdır.');
  const cities = require('../../outputs/icrapro/districts.js');
  const city = v.city ? Object.keys(cities).find((c) => fold(c) === fold(v.city)) || '' : '';
  if (v.city && !city) throw bad('İl listede bulunamadı: ' + v.city);
  const district = v.district ? (cities[city] || []).find((d) => fold(d) === fold(v.district)) || '' : '';
  if (v.district && !district) throw bad('İlçe, seçilen ilde bulunamadı: ' + v.district);
  return {
    identity,
    taxOffice: v.taxOffice,
    phone: phone(v.phone),
    additionalPhones: [v.phone2, v.phone3, v.phone4, v.phone5].filter(Boolean).map(phone),
    address: v.address,
    city,
    district,
    notes: v.notes,
  };
}
async function context(db, rows, input) {
  const names = [
    ...new Set(
      rows
        .flatMap((r) => [r.values.name, r.values.clientName, r.values.debtor])
        .filter(Boolean)
        .map(fold),
    ),
  ];
  const identities = [
    ...new Set(
      rows
        .flatMap((r) => [r.values.identityClient, r.values.identity, r.values.clientIdentity])
        .filter(Boolean),
    ),
  ];
  const codes = [
    ...new Set(
      rows
        .map((r) => r.values.clientCode)
        .filter(Boolean)
        .map(fold),
    ),
  ];
  const folios = [...new Set(rows.map((r) => r.values.sourceFolio).filter(Boolean))];
  const {
    rows: [metadata],
  } = await db.query(
    "SELECT han_private.current_tenant()::text AS tenant,body->'mapsConfig' AS maps FROM han_data.metadata WHERE id=1",
  );
  const { rows: clients } = await db.query(
    `SELECT id,active,body->>'name' AS name,body->>'identity' AS identity,
  coalesce(body#>>'{sourceImport,clientCode}',body->>'clientCode','') AS code,body#>>'{sourceImport,sha256}' AS sha
  FROM han_data.clients WHERE tenant_id=han_private.current_tenant() AND (id=$1 OR body->>'identity'=ANY($2::text[])
  OR regexp_replace(han_data.search_normalize(body->>'name'),'[^a-z0-9]','','g')=ANY($3::text[])
  OR regexp_replace(han_data.search_normalize(coalesce(body#>>'{sourceImport,clientCode}',body->>'clientCode','')),'[^a-z0-9]','','g')=ANY($4::text[]))`,
    [String(input.clientId || ''), identities, names, codes],
  );
  const { rows: documents } = await db.query(
    `SELECT id,active,client_id AS client,body->>'debtor' AS debtor,body->>'identity' AS identity,
  body#>>'{sourceImport,sha256}' AS sha,body#>>'{sourceImport,originalFolioNumber}' AS source,
  coalesce(body->'previousFolioNumbers','[]'::jsonb) AS previous
  FROM han_data.documents WHERE tenant_id=han_private.current_tenant() AND (body->>'identity'=ANY($1::text[])
  OR regexp_replace(han_data.search_normalize(body->>'debtor'),'[^a-z0-9]','','g')=ANY($2::text[])
  OR body#>>'{sourceImport,originalFolioNumber}'=ANY($3::text[])
  OR coalesce(body->'previousFolioNumbers','[]'::jsonb) ?| $3::text[])`,
    [identities, names, folios],
  );
  const { rows: personnel } = await db.query(
    'SELECT body FROM han_data.personnel WHERE active ORDER BY ordinal,id',
  );
  const { rows: accounts } = await db.query(
    "SELECT id,body->>'name' AS name FROM han_data.accounts WHERE active",
  );
  return {
    ...metadata,
    clients,
    documents,
    personnel: personnel.map((p) => p.body),
    accounts,
    categories: [
      ...new Set([
        ...require('../maps-settings.cjs')
          .publicConfig(metadata.maps)
          .sectors.map((s) => s.label),
        'Diğer',
      ]),
    ],
  };
}
function provenance(input, hash, sources, sourceFolio = '') {
  return {
    file: input.fileName,
    sha256: hash,
    sheets: [...new Set(sources.map((s) => s.sheet))],
    rows: sources,
    originalFolioNumber: sourceFolio,
    importedAt: new Date().toISOString(),
  };
}
function partyType(value, company = false) {
  if (!value) return company ? 'Şirket' : 'Şahıs';
  const known = {
    gercek: 'Şahıs',
    sahis: 'Şahıs',
    tuzel: 'Şirket',
    sirket: 'Şirket',
    sahissirketi: 'Şahıs Şirketi',
  };
  if (!known[fold(value)]) throw bad('Kişi türü Şahıs, Şirket veya Şahıs Şirketi olmalıdır.');
  return known[fold(value)];
}
function resolveClient(ctx, v, input) {
  let matches;
  if (v.clientIdentity) matches = ctx.clients.filter((c) => c.identity === v.clientIdentity);
  else if (v.clientCode) matches = ctx.clients.filter((c) => c.code && fold(c.code) === fold(v.clientCode));
  else if (v.clientName) matches = ctx.clients.filter((c) => fold(c.name) === fold(v.clientName));
  else matches = ctx.clients.filter((c) => c.id === input.clientId);
  if (matches.length !== 1 || !matches[0].active)
    throw bad(
      'Tek bir aktif müvekkil eşleştirilemedi. Müvekkili seçin veya adını/vergi numarasını düzeltin.',
    );
  if (v.clientName && fold(v.clientName) !== fold(matches[0].name))
    throw bad('Müvekkil adı ve kodu/vergi numarası birbiriyle uyuşmuyor.');
  return matches[0];
}
function clientPlan(ctx, rows, input, user, hash) {
  const seen = new Set();
  return rows.map((row) => {
    const v = row.values,
      entry = { key: row.key, sources: row.sources, label: v.name, detail: '', state: 'ready', message: '' };
    try {
      if (!v.name) throw bad('Müvekkil adı gerekli.');
      const c = contact(v);
      const category = v.category || input.category || 'Diğer';
      if (!ctx.categories.includes(category)) throw bad('Müvekkil türünü rota sektörleri listesinden seçin.');
      const iban = String(v.iban || '')
        .replace(/\s/g, '')
        .toUpperCase();
      if (!require('../../outputs/icrapro/client-bank-accounts.js').validIban(iban))
        throw bad('Türkiye IBAN numarası geçersiz.');
      const received = findStaff(ctx, v.documentStaff, { han: true }),
        recorded = findStaff(ctx, v.recordedBy);
      const duplicates = ctx.clients.filter(
        (old) =>
          (c.identity && old.identity === c.identity) ||
          (v.clientCode && old.code && fold(old.code) === fold(v.clientCode)) ||
          fold(old.name) === fold(v.name),
      );
      if (duplicates.some((old) => c.identity && old.identity && c.identity !== old.identity))
        throw bad('Aynı ad veya kod farklı bir vergi/TC numarasıyla kayıtlı.');
      if (ctx.documents.some((d) => c.identity && d.identity === c.identity))
        throw bad('Bu vergi/TC numarası mevcut bir borçluya ait.');
      if (duplicates.length > 1) throw bad('Birden fazla mevcut müvekkille eşleşiyor.');
      const unique = c.identity || fold(v.clientCode) || fold(v.name);
      if (duplicates.length || seen.has(unique)) {
        entry.state = 'duplicate';
        entry.message =
          duplicates[0]?.active === false
            ? 'Arşivde kayıtlı; yeniden oluşturulmadı.'
            : 'Zaten kayıtlı; mevcut bilgiler korunacak.';
        return entry;
      }
      seen.add(unique);
      entry.client = {
        ...c,
        id: id(ctx.tenant, 'excel-client', hash, unique),
        name: v.name,
        tradeName: v.name,
        type: partyType(v.type, true),
        clientCategory: category,
        iban,
        bankName: v.bankName,
        bankBranch: v.bankBranch,
        accountHolder: v.accountHolder,
        mersisNumber: v.mersisNumber,
        email: v.email,
        documentStaff: received?.id || '',
        recordedBy: recorded?.id || '',
        recordedByName: recorded?.name || user.name,
        createdAt: new Date().toISOString(),
        sourceImport: { ...provenance(input, hash, row.sources, v.sourceFolio), clientCode: v.clientCode },
      };
      entry.detail = category;
      markRecord(null, entry.client, user, 'notes');
    } catch (error) {
      entry.state = 'error';
      entry.message = error.message;
    }
    return entry;
  });
}
function documentPlan(ctx, rows, input, user, hash) {
  // A one-borrower bank extract may repeat only the payment columns on later rows.
  const sharedKeys = [
    'debtor',
    'clientName',
    'clientIdentity',
    'clientCode',
    'sourceFolio',
    'identity',
    'address',
    'city',
    'district',
    'phone',
    'receivedBy',
    'responsible',
    'registeredOn',
  ];
  const oneBorrower =
    new Set(
      rows
        .map((r) => r.values.debtor)
        .filter(Boolean)
        .map(fold),
    ).size === 1;
  if (oneBorrower)
    for (const key of sharedKeys) {
      const values = [...new Set(rows.map((r) => r.values[key]).filter(Boolean))];
      if (values.length === 1) for (const row of rows) if (!row.values[key]) row.values[key] = values[0];
    }
  const groups = new Map(),
    errors = [];
  for (const row of rows) {
    try {
      const v = row.values;
      if (!v.debtor) throw bad('Borçlu adı gerekli.');
      const client = resolveClient(ctx, v, input);
      const group =
        client.id + '|' + (v.sourceFolio || (v.identity ? v.identity + '|' + fold(v.debtor) : row.key));
      if (!groups.has(group))
        groups.set(group, {
          key: row.key,
          rows: [],
          client,
          label: v.debtor,
          detail: client.name,
          state: 'ready',
          message: '',
          sources: [],
        });
      const target = groups.get(group);
      target.rows.push(row);
      target.sources.push(...row.sources);
    } catch (error) {
      errors.push({
        key: row.key,
        label: row.values.debtor || '—',
        detail: '',
        sources: row.sources,
        state: 'error',
        message: error.message,
      });
    }
  }
  const output = [];
  for (const [group, entry] of groups) {
    try {
      const primary = entry.rows.find((r) => r.values.gross || r.values.amount) || entry.rows[0],
        v = primary.values;
      for (const field of [
        'debtor',
        'identity',
        'responsible',
        'receivedBy',
        'registeredOn',
        'financeInterest',
        'financeFee',
        'status',
      ]) {
        if (
          new Set(
            entry.rows
              .map((r) => r.values[field])
              .filter(Boolean)
              .map((value) => (field === 'debtor' ? fold(value) : value)),
          ).size > 1
        )
          throw bad(
            'Aynı kaynak föyde çelişen bilgiler var: ' +
              fields.fields('documents').find((f) => f.key === field).label,
          );
      }
      const common = contact(v);
      const duplicate = ctx.documents.find(
        (d) =>
          d.id === id(ctx.tenant, 'excel-document', hash, group) ||
          (d.client === entry.client.id &&
            ((v.sourceFolio && (d.source === v.sourceFolio || d.previous.includes(v.sourceFolio))) ||
              (common.identity && d.identity === common.identity && fold(d.debtor) === fold(v.debtor)))),
      );
      if (duplicate) {
        entry.state = 'duplicate';
        entry.message = duplicate.active
          ? 'Mevcut föy bulundu; yeni evrak eklemek için o föyü düzenleyin.'
          : 'Föy arşivde kayıtlı.';
        output.push(entry);
        continue;
      }
      const received = findStaff(ctx, v.receivedBy || input.receivedBy, { han: true }),
        recorded = findStaff(ctx, v.recordedBy),
        responsible = findStaff(ctx, v.responsible);
      if (responsible && !manager(user)) throw bad('Dosya sorumlusunu yalnızca yönetici atayabilir.');
      const registeredOn = date(v.registeredOn || input.registrationDate || businessDate(), 'Kayıt tarihi');
      const doc = {
        ...common,
        id: id(ctx.tenant, 'excel-document', hash, group),
        client: entry.client.id,
        debtor: v.debtor,
        debtorType: partyType(v.debtorType),
        phone1: common.phone,
        phone2: '',
        created: registeredOn,
        trackingDate: registeredOn,
        receivedById: received?.id || '',
        receivedBy: received?.name || '',
        recordedBy: recorded?.id || '',
        recordedByName: recorded?.name || user.name,
        relatedStaff: responsible?.id || '',
        relatedStaffName: responsible?.name || '',
        enforcementOffice: v.enforcementOffice,
        enforcementFileNumber: v.enforcementFileNumber,
        icramatikFolioNumber: v.icramatikFolioNumber,
        status: v.status || 'Derdest',
        sourceImport: provenance(input, hash, entry.sources, v.sourceFolio),
        previousFolioNumbers: v.sourceFolio ? [v.sourceFolio] : [],
        notes: v.notes || '',
      };
      delete doc.phone;
      if (!['Derdest', 'İnfaz', 'İade', 'Bekleme', 'İcra'].includes(doc.status))
        throw bad('Dosya durumu geçersiz.');
      doc.receivables = entry.rows
        .filter((r) => r.values.gross || r.values.amount)
        .map((row) => {
          const w = row.values,
            type =
              receivables.types.find((t) => fold(t) === fold(w.docType || input.docType || 'Senet')) ||
              (fold(w.docType) === 'yediemin' ? 'Yediemin Park Ücreti' : '');
          if (!type) throw bad('Evrak türü tanınmadı: ' + w.docType);
          const unitNames = {
            tl: 'TRY',
            try: 'TRY',
            eur: 'EUR',
            euro: 'EUR',
            usd: 'USD',
            dolar: 'USD',
            xau: 'XAU',
            gramaltin: 'XAU',
            altin: 'XAU',
          };
          const currency = unitNames[fold(w.currency || 'TL')];
          if (!currency) throw bad('Para birimi TL, Euro, Dolar veya Gram Altın olmalıdır.');
          const beforeTracking = fold(w.paymentBank).includes('takiponcesi') ? w.paymentAmount : '';
          const paid = amount(w.preTrackingPayment || beforeTracking, 'Takip öncesi ödeme', {
            optional: true,
          });
          const gross = w.gross ? amount(w.gross, 'Evrak tutarı') : amount(w.amount, 'Asıl alacak') + paid;
          if (w.gross && w.amount && Math.abs(gross - paid - amount(w.amount, 'Asıl alacak')) > 0.005)
            throw bad('Evrak tutarı, takip öncesi ödeme ve asıl alacak uyuşmuyor.');
          return {
            id: id(doc.id, row.key),
            docType: type,
            currency,
            amount: gross,
            preTrackingPayment: paid,
            due: date(w.due || input.dueDate, 'Vade tarihi', {
              optional: type === 'Yediemin Park Ücreti' || type === 'İlam' || type === 'Sözleşme',
            }),
            registeredOn: date(w.registeredOn || registeredOn, 'Kayıt tarihi'),
            issued: date(w.issued, 'Düzenleme tarihi', { optional: true }),
            serial: w.serial,
            parkingEntry: date(w.parkingEntry, 'Men tarihi', { optional: type !== 'Yediemin Park Ücreti' }),
            vehicleKind: w.vehicleKind || 'Otomobil',
            vehiclePlate: w.vehiclePlate,
            parkingName: w.parkingName,
            parkingCommissionRate: w.parkingCommissionRate
              ? amount(w.parkingCommissionRate, 'Anlaşılan yüzde')
              : undefined,
          };
        });
      if (!doc.receivables.length) throw bad('Evrak tutarı içeren en az bir satır gerekli.');
      doc.receivables = receivables.normalize(doc.receivables);
      receivables.applyType(doc);
      receivables.sync(doc, businessDate(), require('../../outputs/icrapro/parking-fees.js').parkingFeeInfo);
      delete doc.mixedParkingCommissionCents;
      doc.financeInterest = amount(v.financeInterest, 'Faiz', { optional: true });
      doc.financeFee = amount(v.financeFee, 'Avukatlık ücreti', { optional: true });
      doc.financeTermsManual = !(input.autoCharges === true && !v.financeInterest && !v.financeFee);
      if (!doc.financeTermsManual)
        require('../../outputs/icrapro/legal-charges.cjs').applyAutomaticLegalCharges(
          doc,
          [],
          businessDate(),
        );
      require('../../outputs/icrapro/parking-waiting.js').syncParkingWaiting(doc, businessDate());
      if (responsible) {
        doc.assignmentVersion = 1;
        doc.assignmentHistory = [
          {
            from: '',
            to: responsible.id,
            staffName: responsible.name,
            assignedBy: user.id,
            assignedByName: user.name,
            date: new Date().toISOString(),
            reason: 'Excel dosyasındaki sorumlu; işlem süresi aktarımda başlatıldı.',
          },
        ];
      }
      const events = [];
      for (const row of entry.rows) {
        const w = row.values;
        if (
          !w.paymentAmount ||
          fold(w.paymentBank).includes('takiponcesi') ||
          input.includeHistoricalPayments === false
        )
          continue;
        if (units.hasForeign(doc))
          throw bad('Döviz/altın föyünün geçmiş tahsilatını günlük kur ekranından girin.');
        const payment = amount(w.paymentAmount, 'Tahsilat tutarı');
        if (payment <= 0) continue;
        const value = Math.round(payment * 100);
        if (!Number.isSafeInteger(value)) throw bad('Tahsilat tutarı çok büyük.');
        const staff = findStaff(ctx, w.turnoverStaff),
          account = ctx.accounts.find(
            (a) => a.active !== false && (a.id === w.paymentBank || fold(a.name) === fold(w.paymentBank)),
          );
        events.push({
          id: id(doc.id, 'payment', row.key),
          documentId: doc.id,
          type: 'payment',
          amount: value,
          date: date(w.paymentDate, 'Tahsilat tarihi'),
          accountId: account?.id || '',
          accountName: account?.name || w.paymentBank || 'Belirtilmedi',
          turnoverStaffId: staff?.id || 'unassigned',
          turnoverStaffName: staff?.name || '—',
          collectionStaffId: staff?.id || 'unassigned',
          collectionStaffName: staff?.name || '—',
          principalAtCollection: Math.round(doc.amount * 100),
          revenuePart: 0,
          closes: false,
          createdAt: new Date().toISOString(),
          operatorId: user.id,
          operatorName: user.name,
          note: 'Excel geçmiş tahsilatı; kasa/banka bakiyesine işlenmez.',
          sourceImport: {
            ...provenance(input, hash, row.sources, v.sourceFolio),
            historical: true,
            cashPosted: false,
          },
        });
      }
      const receivedCents = events.reduce((s, e) => s + e.amount, 0);
      if (
        !units.hasForeign(doc) &&
        doc.docType !== 'Yediemin Park Ücreti' &&
        receivedCents > Math.round((doc.amount + doc.financeInterest + doc.financeFee) * 100)
      )
        throw bad('Geçmiş tahsilat toplam alacağı aşıyor.');
      if (doc.status === 'İnfaz' && (units.hasForeign(doc) || receivedCents < Math.round(doc.amount * 100)))
        throw bad(
          'İnfaz dosyası için en az anapara kadar geçmiş tahsilat gerekli. Döviz/altın tahsilatını kur ekranından girin.',
        );
      for (const e of events) markRecord(null, e, user, 'note');
      markRecord(null, doc, user, 'notes');
      entry.document = doc;
      entry.events = events;
      entry.amount = doc.amount;
      entry.unitPrincipals = doc.unitPrincipals;
      entry.message = events.length
        ? events.length + ' geçmiş tahsilat kasa/bankaya işlenmeden aktarılacak.'
        : doc.docType === 'Yediemin Park Ücreti'
          ? 'Yediemin tutarı men tarihine göre hesaplandı.'
          : '';
    } catch (error) {
      entry.state = 'error';
      entry.message = error.message;
    }
    output.push(entry);
  }
  return [...output, ...errors];
}
function shown(entries) {
  return entries.map(({ key, sources, label, detail, state, message, amount, unitPrincipals, document }) => ({
    key,
    sources,
    label,
    detail,
    state,
    message,
    amount,
    unitPrincipals,
    docType: document?.docType,
  }));
}
async function options(pool, req, kind) {
  const user = await actor(pool, req);
  authorize(user, kind);
  const {
    rows: [meta],
  } = await pool.query("SELECT body->'mapsConfig' AS maps FROM han_data.metadata WHERE id=1");
  const { rows: staff } = await pool.query(
    "SELECT id,body->>'name' AS name FROM han_data.personnel WHERE active AND body->>'active' IS DISTINCT FROM 'false' ORDER BY ordinal,id",
  );
  return {
    fields: fields.fields(kind).map(({ key, label }) => ({ key, label })),
    categories: [
      ...new Set([
        ...require('../maps-settings.cjs')
          .publicConfig(meta.maps)
          .sectors.map((s) => s.label),
        'Diğer',
      ]),
    ],
    staff,
    docTypes: receivables.types,
    maxFileBytes: workbook.MAX_FILE,
    maxRows: 500,
    canAssign: manager(user),
  };
}
async function run(pool, req, input, commit = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Aktarım isteği geçersiz.');
  const user = await actor(pool, req);
  authorize(user, input.kind, commit);
  for (const key of ['mergeSheets', 'includeHistoricalPayments', 'autoCharges'])
    if (input[key] != null && typeof input[key] !== 'boolean') throw bad('Aktarım seçimi geçersiz.');
  for (const key of ['clientId', 'category', 'docType', 'receivedBy', 'registrationDate', 'dueDate'])
    if (input[key] != null && (typeof input[key] !== 'string' || input[key].length > 200))
      throw bad('Aktarım seçimi geçersiz.');
  const sheets = await workbook.readWorkbook(input),
    parsed = fields.importRows(sheets, input),
    hash = crypto.createHash('sha256').update(Buffer.from(input.fileBase64, 'base64')).digest('hex');
  if (
    commit &&
    (!Array.isArray(input.keys) ||
      !input.keys.length ||
      input.keys.length > 500 ||
      input.keys.some((k) => typeof k !== 'string' || k.length > 300) ||
      new Set(input.keys).size !== input.keys.length)
  )
    throw bad('Aktarılacak kayıtları seçin.');
  return inTransaction(pool, async (db) => {
    const current = await actor(db, req);
    authorize(current, input.kind, commit);
    if (commit) {
      await db.query('SELECT id FROM han_data.control WHERE id=1 FOR UPDATE');
      await db.query('SELECT id FROM han_data.metadata WHERE id=1 FOR UPDATE');
    }
    const ctx = await context(db, parsed.rows, input);
    const entries =
      input.kind === 'clients'
        ? clientPlan(ctx, parsed.rows, input, current, hash)
        : documentPlan(ctx, parsed.rows, input, current, hash);
    if (!commit)
      return {
        sheets: sheets.filter((s) => s.rows.length).map((s) => fields.describe(s, input.kind)),
        sheet: parsed.selected,
        items: shown(entries),
        totals: {
          ready: entries.filter((e) => e.state === 'ready').length,
          duplicate: entries.filter((e) => e.state === 'duplicate').length,
          error: entries.filter((e) => e.state === 'error').length,
        },
      };
    const selected = input.keys.map((key) => entries.find((e) => e.key === key));
    if (selected.some((e) => !e)) throw bad('Önizleme değişti. Dosyayı yeniden kontrol edin.');
    if (selected.some((e) => e.state === 'error'))
      throw bad(selected.find((e) => e.state === 'error').message);
    const ready = selected.filter((e) => e.state === 'ready'),
      created = [],
      eventIds = [];
    let ordinal = Date.now();
    for (const entry of ready) {
      const record = entry.document || entry.client;
      if (entry.document) record.number = await require('./folio-numbers.cjs').nextFolioNumber(db);
      await db.query(
        'INSERT INTO han_data.' +
          (entry.document ? 'documents' : 'clients') +
          '(id,body,ordinal,active) VALUES($1,$2::jsonb,$3,true)',
        [record.id, JSON.stringify(record), ordinal++],
      );
      for (const event of entry.events || []) {
        await db.query(
          'INSERT INTO han_data.financial_events(id,body,ordinal,active) VALUES($1,$2::jsonb,$3,true)',
          [event.id, JSON.stringify(event), ordinal++],
        );
        eventIds.push(event.id);
      }
      await db.query(
        "INSERT INTO han_private.han_audit(category,action,area,actor_id,actor_name,actor_username,record_ref,fields) VALUES('changes','import',$1,$2,$3,$4,$5,$6::text[])",
        [
          input.kind === 'clients' ? 'Excel Müvekkil Aktarımı' : 'Excel Borçlu / Evrak Aktarımı',
          current.id,
          current.name,
          current.username,
          record.number || record.name,
          [
            'Kaynak: ' + input.fileName,
            'SHA256: ' + hash,
            'Satırlar: ' + entry.sources.map((s) => s.sheet + '!' + s.row).join(', '),
            entry.events?.length ? 'Geçmiş tahsilatlar kasadan hariç tutuldu.' : 'Yeni kayıt oluşturuldu.',
            current.testAccount ? 'TEST İŞLEMİ' : 'Kullanıcı onaylı aktarım',
          ],
        ],
      );
      created.push({
        id: record.id,
        name: record.name || record.debtor,
        number: record.number || '',
        payments: entry.events?.length || 0,
      });
    }
    if (eventIds.length)
      await db.query(
        "UPDATE han_data.metadata SET body=jsonb_set(body,'{data,hanhukuk-accounting-v1,excludedFinanceIds}',(SELECT coalesce(jsonb_agg(DISTINCT value),'[]'::jsonb) FROM jsonb_array_elements(coalesce(body#>'{data,hanhukuk-accounting-v1,excludedFinanceIds}','[]'::jsonb)||$1::jsonb)),true),revision=revision+1 WHERE id=1",
        [JSON.stringify(eventIds)],
      );
    if (ready.some((e) => e.document?.receivedById)) await require('./payroll.cjs').refreshPayroll(db);
    return {
      imported: created.length,
      skipped: selected.length - created.length,
      records: created,
      payments: eventIds.length,
    };
  });
}
module.exports = { options, run };
