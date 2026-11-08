const { isDeepStrictEqual } = require('node:util');
const { inTransaction } = require('../db-transaction.cjs');
const { actor } = require('./queries.cjs');
const { businessDate } = require('../business-time.cjs');
const fail = (message, status = 400) => Object.assign(Error(message), { status });
const prefixes = Object.freeze({
  Senet: 'S',
  Çek: 'Ç',
  Sözleşme: 'SÖZ',
  'Cari Ekstre': 'CARİ',
  'Yediemin Park Ücreti': 'Y',
  İlam: 'İLAM',
  Fatura: 'F',
  Diğer: 'D',
});
const identity = (value) => String(value || '').replace(/\s/g, '');
const personName = (value) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleUpperCase('tr');
const immutable = new Set(['id', 'number', 'created', 'trackingDate', 'docType']);
const intakeFields = new Set(
  'client clientParty debtor identity phone1 phone2 referencePhone1 referencePhone2 officePhone1 officePhone2 additionalPhones additionalAddresses city district address address2 address2City address2District officeAddress3 officeAddress3City officeAddress3District amount originalAmount preTrackingPayment due issued serial receivedBy receivedById recordedBy recordedByName deliveredBy relatedStaff relatedStaffName originalDocument fileName fileData photoFileName photoData notes guarantors tapuStatus tapuDetails vehicleStatus vehicleDetails sgkStatus sgkDetails captureStatus captureDetails bank branch account contractSubject periodStart periodEnd court courtFile decisionDate vehiclePlate vehicleKind chassisNumber parkingName parkingEntry parkingExit parkingCommissionRate parkingDailyPricing invoiceSubject otherDocumentDescription updatedAt'.split(
    ' ',
  ),
);

async function prepareIntakePatch(db, scope, original, request) {
  const user = await actor(db, request.req);
  if (!['ceo', 'admin'].includes(user.role) && !user.permissions?.includes('documents'))
    throw fail('Evrak kaydetme yetkiniz yok.', 403);
  const patch = JSON.parse(request.raw);
  const old = original.data['icrapro-v1'].docs[0];
  for (const change of patch.changes) {
    if (
      change.field !== undefined &&
      !(change.field === 'docType' && old && !old.docType && change.after?.value === 'Senet') &&
      (!intakeFields.has(change.field) || immutable.has(change.field))
    )
      throw fail('Bu alan evrak kabul ekranından değiştirilemez.');
    if (change.field === undefined) {
      if (old || change.before !== null || !change.value) throw fail('Güncel evrakı yeniden açın.', 409);
      const doc = change.value;
      if (!Object.hasOwn(prefixes, doc.docType)) throw fail('Geçerli bir evrak türü seçin.');
      if (Object.keys(doc).some((field) => !intakeFields.has(field) && !immutable.has(field)))
        throw fail('Yeni evrakta desteklenmeyen alan.');
      const prefix = prefixes[doc.docType];
      const {
        rows: [counter],
      } = await db.query(
        `INSERT INTO han_data.document_sequences(prefix,last_value) VALUES($1,1)
        ON CONFLICT(tenant_id,prefix) DO UPDATE SET last_value=document_sequences.last_value+1 RETURNING last_value::text`,
        [prefix],
      );
      doc.number = prefix + '-' + counter.last_value.padStart(4, '0');
      doc.created = new Date().toISOString();
      doc.trackingDate = businessDate();
      if (!['ceo', 'admin'].includes(user.role) && doc.relatedStaff)
        throw fail('Dosya sorumlusunu yalnızca yönetici atayabilir.', 403);
    }
  }
  return patch;
}

async function validateIntake(db, original, next) {
  const before = new Map(original.data['icrapro-v1'].docs.map((d) => [d.id, d]));
  for (const doc of next.data['icrapro-v1'].docs) {
    const old = before.get(doc.id);
    if (!next.data['icrapro-v1'].clients.some((c) => c.id === doc.client))
      throw fail('Geçerli bir müvekkil seçin.');
    if (!String(doc.debtor || '').trim() || !Object.hasOwn(prefixes, doc.docType))
      throw fail('Evrak türü ve borçlu adı gerekli.');
    const amount = Math.round(Number(doc.amount) * 100);
    if (!Number.isSafeInteger(amount) || amount < 0) throw fail('Geçerli evrak tutarı girin.');
    if (old) {
      const locked = old.repaymentPlan || original.data['hanhukuk-finance-v1'].length > 0;
      if (locked) {
        const comparable = structuredClone(old);
        require('../../outputs/icrapro/parking-fees.js').applyParkingFee(comparable, businessDate());
        for (const field of [
          'amount',
          'originalAmount',
          'preTrackingPayment',
          'due',
          'parkingCommissionRate',
          'parkingEntry',
          'vehicleKind',
        ]) {
          const fallback =
            field === 'originalAmount' && ['Senet', 'Diğer'].includes(old.docType)
              ? comparable.amount
              : field === 'preTrackingPayment'
                ? 0
                : '';
          const money = ['amount', 'originalAmount', 'preTrackingPayment', 'parkingCommissionRate'].includes(
            field,
          );
          if (
            money
              ? Number(doc[field] ?? fallback) !== Number(comparable[field] ?? fallback)
              : String(doc[field] ?? '') !== String(comparable[field] ?? '')
          )
            throw fail(
              'Finansal hareket veya yapılandırma bulunan evrakın tutar, vade ve oranı değiştirilemez.',
              409,
            );
        }
      }
      for (const field of immutable)
        if (
          !(field === 'trackingDate' && !old[field]) &&
          !(field === 'docType' && !old[field] && doc[field] === 'Senet') &&
          !isDeepStrictEqual(doc[field], old[field])
        )
          throw fail('Evrak kimliği, türü ve numarası korunmalıdır.', 409);
    }
    const key = identity(doc.identity);
    if (
      /^\d{10,11}$/.test(key) &&
      (!old || identity(old.identity) !== key || personName(old.debtor) !== personName(doc.debtor))
    ) {
      const { rows } = await db.query(
        `SELECT 1 FROM han_data.clients WHERE active
          AND regexp_replace(coalesce(body->>'identity',''),'[[:space:]]','','g')=$1
        UNION ALL SELECT 1 FROM han_data.documents WHERE active AND id<>$2
          AND regexp_replace(coalesce(body->>'identity',''),'[[:space:]]','','g')=$1
          AND ($3='' OR upper(translate(regexp_replace(trim(coalesce(body->>'debtor','')),'[[:space:]]+',' ','g'),'iı','İI'))<>$3) LIMIT 1`,
        [key, doc.id, personName(doc.debtor)],
      );
      if (rows.length)
        throw fail(
          'Bu TC kimlik / vergi numarası başka bir müvekkil veya borçluda kayıtlı. Kayıt yapılamadı.',
          409,
        );
    }
  }
}

async function intakeBatch(pool, req, { ids = '[]' } = {}) {
  try {
    ids = JSON.parse(ids);
  } catch {
    throw fail('Geçersiz teslim grubu.');
  }
  if (
    !Array.isArray(ids) ||
    ids.length > 100 ||
    ids.some((id) => typeof id !== 'string' || !id || id.length > 200)
  )
    throw fail('Teslim grubu 100 evraktan fazla olamaz.');
  return inTransaction(
    pool,
    async (db) => {
      await actor(db, req);
      const { rows } = await db.query(
        `SELECT jsonb_build_object('id',d.id,'client',d.client_id,'number',d.number,'docType',d.kind,
          'debtor',d.body->'debtor','amount',d.body->'amount','due',d.body->'due',
          'originalDocument',d.body->'originalDocument','deliveredBy',d.body->'deliveredBy',
          'receivedBy',d.body->'receivedBy','relatedStaff',d.staff_id,
          'phone1',d.body->'phone1','whatsappPhone',d.body->'whatsappPhone') AS record,
          jsonb_build_object('id',c.id,'name',c.name) AS client
      FROM han_data.documents d LEFT JOIN han_data.clients c ON c.id=d.client_id WHERE d.active AND d.id=ANY($1::text[])`,
        [ids],
      );
      return { items: rows };
    },
    { readOnly: true },
  );
}

async function relatedDocuments(pool, req, { id, after = '' } = {}) {
  if (typeof id !== 'string' || id.length > 200 || typeof after !== 'string' || after.length > 200)
    throw fail('Geçersiz dosya.');
  return inTransaction(
    pool,
    async (db) => {
      await actor(db, req);
      const {
        rows: [source],
      } = await db.query(
        "SELECT body->>'identity' AS identity FROM han_data.documents WHERE active AND id=$1",
        [id],
      );
      if (!source) throw fail('Evrak bulunamadı.', 404);
      const key = identity(source.identity);
      if (!/^\d{10,11}$/.test(key)) return { items: [], next: null };
      const { rows } = await db.query(
        `SELECT id,number,status,body->>'debtor' AS debtor,body->>'identity' AS identity
      FROM han_data.documents WHERE active AND id<>$1 AND id>$2
        AND regexp_replace(coalesce(body->>'identity',''),'[[:space:]]','','g')=$3 ORDER BY id LIMIT 51`,
        [id, after, key],
      );
      return { items: rows.slice(0, 50), next: rows.length > 50 ? rows[49].id : null };
    },
    { readOnly: true },
  );
}
module.exports = { prepareIntakePatch, validateIntake, intakeBatch, relatedDocuments };
