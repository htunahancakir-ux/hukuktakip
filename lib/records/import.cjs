const crypto = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');
const { validateState } = require('../postgres-store.cjs');

const omit = (value, keys) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const json = (value) => JSON.stringify(value);
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
function cents(value = 0) {
  const amount = Number(value);
  const result = Math.round(amount * 100);
  if (
    !Number.isFinite(amount) ||
    !Number.isSafeInteger(result) ||
    amount < 0 ||
    Math.abs(amount * 100 - result) > 0.00001
  )
    throw new Error('Invalid monetary precision in source');
  return result;
}
function uniqueRows(rows, label) {
  const ids = new Set();
  for (const row of rows) {
    if (!row?.id || ids.has(row.id)) throw new Error('Missing or repeated ID in ' + label);
    ids.add(row.id);
  }
}
async function insert(db, table, row) {
  // table/column identifiers originate ONLY in this module's literal descriptors.
  const keys = Object.keys(row);
  await db.query(
    `INSERT INTO han_core.${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
    keys.map((key) => row[key]),
  );
}
async function importNormalized(pool) {
  return inTransaction(pool, async (db) => {
    const { rows } = await db.query(
      'SELECT payload, revision FROM han_private.han_state WHERE id = 1 FOR SHARE',
    );
    if (!rows.length) throw new Error('Source database is empty');
    const state = rows[0].payload;
    validateState(state);
    // Refuse an accidental second import or a mixed old/new write deployment.
    await insert(db, 'migration_checkpoint', {
      id: 1,
      source_revision: rows[0].revision,
      source_payload: json(state),
      source_sha256: sha(json(state)),
    });
    const data = state.data,
      clients = data['icrapro-v1'].clients,
      liveDocs = data['icrapro-v1'].docs;
    const documents = new Map(liveDocs.map((row) => [row.id, row]));
    for (const archived of state.deletedDocuments || []) {
      if (!documents.has(archived.document?.id)) documents.set(archived.document.id, archived.document);
    }
    uniqueRows(clients, 'clients');
    uniqueRows(liveDocs, 'documents');
    const partyIdentities = new Map();
    async function party(id, name, identity, kind = '') {
      const identityNo = String(identity || '').replace(/\s/g, '') || null;
      const existing = identityNo && partyIdentities.get(identityNo);
      if (existing) {
        if (existing.name.trim().toLocaleUpperCase('tr') !== String(name).trim().toLocaleUpperCase('tr'))
          throw new Error('Conflicting names for an identity; manual reconciliation required');
        return existing.id;
      }
      await insert(db, 'parties', { id, name, identity_no: identityNo, kind });
      if (identityNo) partyIdentities.set(identityNo, { id, name });
      return id;
    }
    async function contacts(partyId, row) {
      for (const key of [
        'phone',
        'phone1',
        'phone2',
        'officePhone1',
        'officePhone2',
        'referencePhone1',
        'referencePhone2',
        'address',
      ]) {
        if (row[key])
          await db.query(
            `INSERT INTO han_core.party_contacts(party_id, kind, label, value)
          VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [partyId, key === 'address' ? 'address' : 'phone', key, String(row[key])],
          );
      }
    }
    async function attachment(id, documentId, clientId, name, value, extras = {}) {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value || '');
      if (!match) throw new Error('Invalid attachment encoding; source left intact');
      const bytes = Buffer.from(match[2], 'base64');
      await insert(db, 'attachments', {
        id,
        document_id: documentId,
        client_id: clientId,
        name: name || 'evrak',
        mime: match[1],
        sha256: sha(bytes),
        size_bytes: bytes.length,
        content: bytes,
        extras: json(extras),
      });
    }
    for (const row of data['icrapro-personnel-v1'])
      await insert(db, 'personnel', {
        id: row.id,
        name: row.name,
        active: row.active !== false,
        extras: json(omit(row, ['id', 'name', 'active'])),
      });
    for (const row of clients) {
      const partyId = await party('client:' + row.id, row.name, row.identity, row.type);
      await insert(db, 'clients', {
        id: row.id,
        party_id: partyId,
        extras: json(omit(row, ['id', 'name', 'identity', 'type', 'attachments'])),
      });
      await contacts(partyId, row);
      for (const [index, file] of (row.attachments || []).entries())
        await attachment(
          'client:' + row.id + ':' + index,
          null,
          row.id,
          file.name,
          file.data,
          omit(file, ['data', 'name']),
        );
    }
    for (const row of data['hanhukuk-accounting-v1'].accounts)
      await insert(db, 'accounts', {
        id: row.id,
        name: row.name,
        kind: row.type,
        extras: json(omit(row, ['id', 'name', 'type'])),
      });
    for (const row of documents.values()) {
      if (row.client && row.clientId && row.client !== row.clientId)
        throw new Error('Conflicting client references');
      const debtorId = await party('debtor:' + row.id, row.debtor, row.identity);
      const archive = (state.deletedDocuments || []).findLast(
        (entry) => entry.document?.id === row.id && !entry.restoredAt,
      );
      await insert(db, 'documents', {
        id: row.id,
        number: row.number,
        client_id: row.client || row.clientId || null,
        assigned_staff_id: row.relatedStaff || null,
        debtor_id: debtorId,
        kind: row.docType || '',
        status: row.status || 'Derdest',
        principal_cents: cents(row.amount),
        interest_cents: cents(row.financeInterest),
        fee_cents: cents(row.financeFee),
        discount_cents: row.debtDiscountCents || 0,
        due_on: row.due || null,
        enforcement_number: row.enforcementFileNumber || null,
        deleted_at: liveDocs.some((doc) => doc.id === row.id) ? null : archive?.deletedAt || null,
        extras: json(
          omit(row, [
            'id',
            'number',
            'client',
            'clientId',
            'relatedStaff',
            'debtor',
            'identity',
            'docType',
            'status',
            'amount',
            'financeInterest',
            'financeFee',
            'debtDiscountCents',
            'due',
            'enforcementFileNumber',
            'conversations',
            'linkedDocumentIds',
            'fileData',
            'photoData',
          ]),
        ),
      });
      await contacts(debtorId, row);
      for (const key of ['file', 'photo'])
        if (row[key + 'Data'])
          await attachment(
            'document:' + row.id + ':' + key,
            row.id,
            null,
            row[key === 'file' ? 'fileName' : 'photoFileName'],
            row[key + 'Data'],
          );
      for (const c of row.conversations || [])
        await insert(db, 'conversations', {
          document_id: row.id,
          id: c.id,
          occurred_on: c.date,
          at_time: c.time,
          note: c.note || '',
          result: c.result,
          operator_id: c.operatorId || null,
          extras: json(omit(c, ['id', 'date', 'time', 'note', 'result', 'operatorId'])),
        });
    }
    for (const row of documents.values())
      for (const id of row.linkedDocumentIds || [])
        await insert(db, 'document_links', { document_id: row.id, linked_id: id });
    for (const row of state.deletedDocuments || [])
      await insert(db, 'document_archives', {
        document_id: row.document.id,
        snapshot: json(row),
      });
    for (const row of data['hanhukuk-finance-v1'])
      await insert(db, 'financial_events', {
        id: row.id,
        document_id: row.documentId,
        account_id: row.accountId || null,
        kind: row.type,
        amount_cents: row.amount,
        occurred_on: row.date,
        operator_id: row.operatorId || null,
        note: row.note || '',
        extras: json(
          omit(row, ['id', 'documentId', 'accountId', 'type', 'amount', 'date', 'operatorId', 'note']),
        ),
      });
    for (const row of data['hanhukuk-accounting-v1'].entries)
      await insert(db, 'ledger_entries', {
        id: row.id,
        account_id: row.accountId,
        destination_id: row.destination || null,
        document_id: row.documentId || null,
        kind: row.type,
        amount_cents: row.amount,
        occurred_on: row.date,
        operator_id: row.operatorId || null,
        note: row.note || '',
        extras: json(
          omit(row, [
            'id',
            'accountId',
            'destination',
            'documentId',
            'type',
            'amount',
            'date',
            'operatorId',
            'note',
          ]),
        ),
      });
    for (const row of state.messages || []) {
      await insert(db, 'messages', {
        id: row.id,
        sender_id: row.senderId,
        subject: row.subject,
        body: row.text,
        created_at: row.createdAt,
        extras: json(
          omit(row, [
            'id',
            'senderId',
            'subject',
            'text',
            'createdAt',
            'recipientIds',
            'recipientNames',
            'readBy',
          ]),
        ),
      });
      for (const [index, id] of row.recipientIds.entries())
        await insert(db, 'message_recipients', {
          message_id: row.id,
          account_id: id,
          read_at: row.readBy?.[id] || null,
          label_at_send: row.recipientNames?.[index] || null,
        });
    }
    for (const row of state.workOrders || [])
      await insert(db, 'work_orders', {
        id: row.id,
        assigner_id: row.assignerId,
        assignee_id: row.assigneeId,
        title: row.title,
        description: row.description || '',
        status: row.status,
        due_on: row.due || null,
        created_at: row.createdAt,
        extras: json(
          omit(row, ['id', 'assignerId', 'assigneeId', 'title', 'description', 'status', 'due', 'createdAt']),
        ),
      });
    for (const row of state.scheduledReminders || [])
      await insert(db, 'reminders', {
        id: row.id,
        account_id: row.accountId,
        client_id: row.targetType === 'client' ? row.targetId : null,
        document_id: row.targetType === 'document' ? row.targetId : null,
        due_at: row.dueAt,
        note: row.note,
        closed_at: row.closedAt || null,
        extras: json(omit(row, ['id', 'accountId', 'targetType', 'targetId', 'dueAt', 'note', 'closedAt'])),
      });
    for (const row of state.employeeTerms?.releases || [])
      await insert(db, 'terms_releases', {
        version: row.version,
        hash: row.hash,
        document: json(row),
      });
    for (const row of state.employeeTerms?.acceptances || [])
      await insert(db, 'terms_acceptances', {
        account_id: row.accountId,
        version: row.version,
        hash: row.hash,
        accepted_at: row.acceptedAt,
        snapshot: json(row),
      });
    for (const row of state.employeeTerms?.noticeEvents || [])
      await insert(db, 'notice_events', { account_id: row.accountId, body: json(row) });
    for (const [month, period] of Object.entries(state.payrollPeriods || {})) {
      await insert(db, 'payroll_periods', {
        month,
        closed: !!period.closed,
        extras: json(omit(period, ['rows', 'closed'])),
      });
      for (const row of period.rows || [])
        await insert(db, 'payroll_rows', { month, staff_id: row.staffId, snapshot: json(row) });
    }
    for (const row of state.dailyBonuses || [])
      await insert(db, 'daily_bonuses', {
        id: row.id,
        staff_id: row.staffId,
        occurred_on: row.date,
        amount_cents: row.amount,
        extras: json(omit(row, ['id', 'staffId', 'date', 'amount'])),
      });
    for (const row of data['icrapro-cases-v1'] || [])
      await insert(db, 'cases', { id: row.id, body: json(row) });
    await insert(db, 'settings', { key: 'application', value: json(data['icrapro-settings-v1']) });
    // Preserve fields not interpreted by this importer, including future extensions.
    await insert(db, 'settings', {
      key: 'remaining-state',
      value: json(
        omit(state, [
          'data',
          'users',
          'deletedDocuments',
          'messages',
          'workOrders',
          'scheduledReminders',
          'payrollPeriods',
          'dailyBonuses',
        ]),
      ),
    });
    const verified = await verifyNormalized(db, state);
    return { ...verified, sourceRevision: String(rows[0].revision), sourceSha256: sha(json(state)) };
  });
}
async function verifyNormalized(db, expected) {
  const { rows } = await db.query(`SELECT
    (SELECT count(*)::int FROM han_core.clients) AS clients,
    (SELECT count(*)::int FROM han_core.documents WHERE deleted_at IS NULL) AS documents,
    (SELECT count(*)::int FROM han_core.financial_events) AS finance,
    (SELECT coalesce(sum(amount_cents),0)::text FROM han_core.financial_events) AS finance_total,
    (SELECT coalesce(sum(amount_cents),0)::text FROM han_core.ledger_entries) AS ledger_total,
    (SELECT count(*)::int FROM han_core.conversations) AS conversations`);
  const value = rows[0],
    source = expected.data;
  const total = (records) => records.reduce((sum, row) => sum + BigInt(row.amount), 0n).toString();
  if (
    value.clients !== source['icrapro-v1'].clients.length ||
    value.documents !== source['icrapro-v1'].docs.length ||
    value.finance !== source['hanhukuk-finance-v1'].length ||
    value.finance_total !== total(source['hanhukuk-finance-v1']) ||
    value.ledger_total !== total(source['hanhukuk-accounting-v1'].entries)
  )
    throw new Error('Migration verification failed; transaction rolled back');
  return value;
}
module.exports = { importNormalized, verifyNormalized, cents, sha };
