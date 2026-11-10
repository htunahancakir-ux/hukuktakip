const crypto = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');
const { validDate, businessDate } = require('../business-time.cjs');
const { event: auditEvent } = require('../audit.cjs');
const { sha } = require('./import.cjs');
const error = (status, message) => Object.assign(new Error(message), { status });
const manager = (user) => ['ceo', 'admin'].includes(user.role);
function pageSize(value = 50) {
  const size = Number(value);
  if (!Number.isInteger(size) || size < 1 || size > 100) throw error(400, 'Sayfa boyutu 1–100 olmalı.');
  return size;
}
function page(rows, limit) {
  return { items: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1].id : null };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function positiveCents(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw error(400, 'Tutar pozitif tam kuruş olmalı.');
  return value;
}
async function actor(db, tokenHash, locking = false) {
  const { rows } = await db.query(
    `SELECT a.body, a.terms_required FROM han_private.han_account_index a
    JOIN han_private.han_sessions s ON s.account_id = a.id
    WHERE s.token_hash = $1 AND s.expires_at > $2 AND s.device_type IN ('desktop','mobile') AND a.enabled
    ${locking ? 'FOR SHARE OF a, s' : ''}`,
    [tokenHash, Date.now()],
  );
  if (!rows.length) throw error(401, 'Giriş yapın.');
  if (rows[0].terms_required && rows[0].body.role !== 'ceo')
    throw error(428, 'Güncel gizlilik sözleşmesini kabul edin.');
  return rows[0].body;
}
async function audit(db, user, action, area, ref, fields = []) {
  const row = auditEvent(user, 'changes', action, area, ref, fields);
  await db.query(
    `INSERT INTO han_private.han_audit(category, action, area, actor_id, actor_name, actor_username, record_ref, fields)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      row.category,
      row.action,
      row.area,
      row.actor_id,
      row.actor_name,
      row.actor_username,
      row.record_ref,
      row.fields,
    ],
  );
}
async function visibleDocument(db, user, id, locking = false) {
  const { rows } = await db.query(
    `SELECT * FROM han_core.documents WHERE id = $1 AND deleted_at IS NULL
    AND ($2::boolean OR assigned_staff_id = $3) ${locking ? 'FOR UPDATE' : ''}`,
    [id, manager(user), user.staffId || null],
  );
  if (!rows.length) throw error(404, 'Evrak bulunamadı.');
  return rows[0];
}
async function balance(db, accountId) {
  const { rows } = await db.query(
    `SELECT
    coalesce((SELECT sum(CASE WHEN kind = 'payment' THEN amount_cents ELSE -amount_cents END)
      FROM han_core.financial_events WHERE account_id = $1),0) +
    coalesce((SELECT sum(CASE WHEN kind = 'in' THEN amount_cents ELSE -amount_cents END)
      FROM han_core.ledger_entries WHERE account_id = $1),0) +
    coalesce((SELECT sum(amount_cents) FROM han_core.ledger_entries WHERE destination_id = $1),0) AS cents`,
    [accountId],
  );
  return BigInt(rows[0].cents);
}
function createRecordRepository(pool) {
  async function command(token, key, name, input, work) {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(key))
      throw error(400, 'Geçerli işlem anahtarı gerekli.');
    const fingerprint = sha(JSON.stringify(canonical({ name, input })));
    return inTransaction(pool, async (db) => {
      const user = await actor(db, token, true);
      const reserved = await db.query(
        `INSERT INTO han_core.commands(actor_id, key, request_hash, response)
        VALUES ($1,$2,$3,'{}') ON CONFLICT (actor_id,key) DO NOTHING RETURNING key`,
        [user.id, key, fingerprint],
      );
      if (!reserved.rows.length) {
        const { rows } = await db.query(
          'SELECT request_hash, response FROM han_core.commands WHERE actor_id=$1 AND key=$2',
          [user.id, key],
        );
        if (rows[0].request_hash !== fingerprint)
          throw error(409, 'İşlem anahtarı farklı bir istek için kullanılmış.');
        return rows[0].response;
      }
      const result = await work(db, user);
      await db.query('UPDATE han_core.commands SET response=$3::jsonb WHERE actor_id=$1 AND key=$2', [
        user.id,
        key,
        JSON.stringify(result),
      ]);
      return result;
    });
  }
  return {
    async listDocuments(token, { after = '', limit = 50, query = '' } = {}) {
      limit = pageSize(limit);
      if (String(after).length > 120 || typeof query !== 'string' || query.length > 80)
        throw error(400, 'Geçersiz arama.');
      const user = await actor(pool, token);
      const { rows } = await pool.query(
        `SELECT d.id, d.number, p.name AS debtor, cp.name AS client,
        d.status, d.revision::text, d.principal_cents::text, d.assigned_staff_id
        FROM han_core.documents d JOIN han_core.parties p ON p.id=d.debtor_id
        LEFT JOIN han_core.clients c ON c.id=d.client_id LEFT JOIN han_core.parties cp ON cp.id=c.party_id
        WHERE d.deleted_at IS NULL AND d.id > $1 AND ($2::boolean OR d.assigned_staff_id=$3)
        AND ($4::text = '' OR d.search_vector @@ plainto_tsquery('simple',$4)
          OR p.search_vector @@ plainto_tsquery('simple',$4))
        ORDER BY d.id LIMIT $5`,
        [after, manager(user), user.staffId || null, query, limit + 1],
      );
      return page(rows, limit);
    },
    async listClients(token, { after = '', limit = 50 } = {}) {
      limit = pageSize(limit);
      const user = await actor(pool, token);
      if (!manager(user) && !user.permissions?.includes('clients'))
        throw error(403, 'Müvekkil yetkisi gerekli.');
      const { rows } = await pool.query(
        `SELECT c.id, c.revision::text, p.name, p.kind, p.identity_no
        FROM han_core.clients c JOIN han_core.parties p ON p.id=c.party_id
        WHERE c.deleted_at IS NULL AND c.id>$1 ORDER BY c.id LIMIT $2`,
        [after, limit + 1],
      );
      return page(rows, limit);
    },
    async updateDocumentNote(token, key, input) {
      if (
        typeof input.note !== 'string' ||
        input.note.length > 5000 ||
        !/^[1-9]\d*$/.test(String(input.revision))
      )
        throw error(400, 'Geçerli not ve sürüm gerekli.');
      return command(token, key, 'document.note', input, async (db, user) => {
        const doc = await visibleDocument(db, user, input.id, true);
        if (String(doc.revision) !== String(input.revision))
          throw error(409, 'Evrak değişti. Yeniden yükleyin.');
        const { rows } = await db.query(
          `UPDATE han_core.documents SET extras=jsonb_set(extras,'{notes}',$2::jsonb),
          revision=revision+1 WHERE id=$1 RETURNING id, revision::text`,
          [doc.id, JSON.stringify(input.note)],
        );
        await audit(db, user, 'update', 'Evraklar', doc.id, ['Notlar']);
        return rows[0];
      });
    },
    async recordPayment(token, key, input) {
      const amount = positiveCents(input.amountCents);
      if (
        !validDate(input.date) ||
        input.date > businessDate() ||
        typeof input.note !== 'string' ||
        input.note.length > 3000
      )
        throw error(400, 'Geçerli tarih ve açıklama girin.');
      return command(token, key, 'finance.payment', input, async (db, user) => {
        if (!manager(user) && !user.permissions?.includes('cashIn'))
          throw error(403, 'Tahsilat yetkisi gerekli.');
        const doc = await visibleDocument(db, user, input.documentId, true);
        if (['İade', 'İnfaz'].includes(doc.status)) throw error(409, 'Kapalı dosyaya tahsilat eklenemez.');
        const account = await db.query('SELECT id FROM han_core.accounts WHERE id=$1 FOR UPDATE', [
          input.accountId,
        ]);
        if (!account.rows.length) throw error(400, 'Geçerli kasa veya banka hesabı gerekli.');
        const { rows } = await db.query(
          `SELECT coalesce(sum(amount_cents) FILTER (WHERE kind='payment'),0) AS paid,
          coalesce(sum(amount_cents) FILTER (WHERE kind='expense'),0) AS expenses
          FROM han_core.financial_events WHERE document_id=$1`,
          [doc.id],
        );
        const remaining =
          BigInt(doc.principal_cents) +
          BigInt(doc.interest_cents) +
          BigInt(doc.fee_cents) +
          BigInt(rows[0].expenses) -
          BigInt(doc.discount_cents) -
          BigInt(rows[0].paid);
        if (BigInt(amount) > remaining) throw error(409, 'Tahsilat kalan borcu aşamaz.');
        // Parking commission/revenue allocation remains a domain-specific operation.
        if (doc.kind === 'Yediemin Park Ücreti')
          throw error(409, 'Yediemin tahsilatı için doğrulanmış park hesaplama işlemini kullanın.');
        const id = crypto.randomUUID(),
          closes = BigInt(amount) === remaining;
        await db.query(
          `INSERT INTO han_core.financial_events
          (id,document_id,account_id,kind,amount_cents,occurred_on,operator_id,note)
          VALUES ($1,$2,$3,'payment',$4,$5,$6,$7)`,
          [id, doc.id, input.accountId, amount, input.date, user.id, input.note],
        );
        await db.query(
          `UPDATE han_core.documents SET revision=revision+1,
          status=CASE WHEN $2 THEN 'İnfaz' ELSE status END,
          extras=CASE WHEN $2 THEN jsonb_set(extras,'{closedDate}',$3::jsonb) ELSE extras END WHERE id=$1`,
          [doc.id, closes, JSON.stringify(input.date)],
        );
        await audit(db, user, 'create', 'Finans', id);
        return { id, documentId: doc.id, remainingCents: (remaining - BigInt(amount)).toString(), closes };
      });
    },
    async transfer(token, key, input) {
      const amount = positiveCents(input.amountCents);
      if (
        input.from === input.to ||
        !validDate(input.date) ||
        input.date > businessDate() ||
        typeof input.note !== 'string' ||
        !input.note.trim() ||
        input.note.length > 3000
      )
        throw error(400, 'Geçerli transfer bilgileri girin.');
      return command(token, key, 'ledger.transfer', input, async (db, user) => {
        if (!manager(user)) throw error(403, 'Transfer için yönetici yetkisi gerekli.');
        const accounts = await db.query(
          'SELECT id FROM han_core.accounts WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',
          [[input.from, input.to]],
        );
        if (accounts.rows.length !== 2) throw error(400, 'İki farklı geçerli hesap seçin.');
        if ((await balance(db, input.from)) < BigInt(amount)) throw error(409, 'Bakiye yetersiz.');
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO han_core.ledger_entries
          (id,account_id,destination_id,kind,amount_cents,occurred_on,operator_id,note)
          VALUES ($1,$2,$3,'transfer',$4,$5,$6,$7)`,
          [id, input.from, input.to, amount, input.date, user.id, input.note],
        );
        await audit(db, user, 'create', 'Muhasebe Hareketleri', id);
        return { id };
      });
    },
    async enqueueMessage(token, key, input) {
      if (
        typeof input.subject !== 'string' ||
        !input.subject.trim() ||
        input.subject.length > 150 ||
        typeof input.text !== 'string' ||
        !input.text.trim() ||
        input.text.length > 10000 ||
        !Array.isArray(input.recipientIds) ||
        !input.recipientIds.length ||
        input.recipientIds.length > 100
      )
        throw error(400, 'Mesaj ve alıcı bilgileri geçersiz.');
      return command(token, key, 'messages.create', input, async (db, user) => {
        const ids = [...new Set(input.recipientIds)];
        const recipients = await db.query(
          'SELECT id FROM han_private.han_account_index WHERE enabled AND id=ANY($1::text[])',
          [ids],
        );
        if (recipients.rows.length !== ids.length) throw error(400, 'Aktif alıcıları seçin.');
        const id = crypto.randomUUID();
        await db.query(
          'INSERT INTO han_core.messages(id,sender_id,subject,body,created_at) VALUES ($1,$2,$3,$4,clock_timestamp())',
          [id, user.id, input.subject, input.text],
        );
        for (const recipient of ids) {
          await db.query('INSERT INTO han_core.message_recipients(message_id,account_id) VALUES ($1,$2)', [
            id,
            recipient,
          ]);
          if (input.whatsapp === true)
            await db.query(
              `INSERT INTO han_core.outbox(id,dedupe_key,topic,body)
            VALUES ($1,$2,'message',$3::jsonb)`,
              [
                crypto.randomUUID(),
                id + ':' + recipient,
                JSON.stringify({ messageId: id, recipientId: recipient }),
              ],
            );
        }
        await audit(db, user, 'create', 'Mesajlar', id);
        return { id };
      });
    },
  };
}
module.exports = { createRecordRepository, balance };
