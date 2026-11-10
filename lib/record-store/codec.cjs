const crypto = require('node:crypto');

const collections = Object.freeze({
  clients: ['data', 'icrapro-v1', 'clients'],
  documents: ['data', 'icrapro-v1', 'docs'],
  personnel: ['data', 'icrapro-personnel-v1'],
  accounts: ['data', 'hanhukuk-accounting-v1', 'accounts'],
  financial_events: ['data', 'hanhukuk-finance-v1'],
  ledger_entries: ['data', 'hanhukuk-accounting-v1', 'entries'],
  cases: ['data', 'icrapro-cases-v1'],
  messages: ['messages'],
  work_orders: ['workOrders'],
  reminders: ['scheduledReminders'],
  document_archives: ['deletedDocuments'],
  operation_archives: ['deletedOperations'],
  daily_bonuses: ['dailyBonuses'],
  staff_breaks: ['staffBreaks'],
  workflow_notices: ['workflowNotices'],
  collection_notices: ['collectionNotices'],
});
const tables = Object.freeze([...Object.keys(collections), 'conversations', 'attachments']);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
const digest = (value) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const get = (object, path) => path.reduce((o, k) => o?.[k], object);
function set(object, path, value) {
  let o = object;
  for (const k of path.slice(0, -1)) o = o[k] ??= {};
  o[path.at(-1)] = value;
}
function rowId(body, ordinal, table) {
  if (body?.id !== undefined && body.id !== null && String(body.id)) return String(body.id);
  // A rolling notification window shifts array positions on every new item.
  // Its sequence is stable; using the ordinal here would recreate 1,000 rows.
  if (table === 'collection_notices' && Number.isSafeInteger(body?.sequence) && body.sequence > 0)
    return 'sequence:' + body.sequence;
  if (['clients', 'documents', 'personnel', 'accounts', 'financial_events', 'ledger_entries'].includes(table))
    throw Error('Kimliği olmayan kayıt: ' + table);
  return 'legacy:' + ordinal + ':' + digest(body);
}
// Reversible decomposition. Empty/missing fields and original array order survive
// export. No fuzzy merging, case conversion, money rounding or identity rewriting.
function split(state, { includeArchives = true } = {}) {
  const metadata = structuredClone(state),
    rows = Object.fromEntries(tables.map((t) => [t, []]));
  for (const [table, path] of Object.entries(collections)) {
    const source = get(metadata, path);
    if (source === undefined) continue;
    if (!Array.isArray(source)) throw Error('Geçersiz koleksiyon: ' + table);
    const seen = new Set();
    rows[table] = source.map((body, ordinal) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('Geçersiz kayıt: ' + table);
      const id = rowId(body, ordinal, table);
      if (seen.has(id)) throw Error('Tekrarlanan kayıt kimliği: ' + table);
      seen.add(id);
      return { id, body, ordinal, active: true };
    });
    set(metadata, path, []);
  }
  // Archived documents remain valid FK parents but are absent from the active list.
  const known = new Set(rows.documents.map((r) => r.id));
  for (const archive of includeArchives ? rows.document_archives : []) {
    const doc = archive.body.document;
    if (doc?.id && !known.has(String(doc.id))) {
      rows.documents.push({
        id: String(doc.id),
        body: structuredClone(doc),
        ordinal: rows.documents.length,
        active: false,
      });
      known.add(String(doc.id));
    }
  }
  for (const row of rows.documents) {
    const doc = row.body;
    if (Array.isArray(doc.attachments)) {
      doc.attachments.forEach((value, ordinal) =>
        rows.attachments.push({
          id: 'doc:' + row.id + ':attachment:' + rowId(value, ordinal, 'attachments'),
          ordinal,
          active: true,
          body: { documentId: row.id, field: 'attachments', value },
        }),
      );
      doc.attachments = [];
    }
    if (Array.isArray(doc.conversations)) {
      for (const [ordinal, body] of doc.conversations.entries())
        rows.conversations.push({
          id: row.id + ':' + rowId(body, ordinal, 'conversations'),
          ordinal,
          active: true,
          body: { documentId: row.id, value: body },
        });
      doc.conversations = [];
    }
    for (const field of ['fileData', 'photoData'])
      if (typeof doc[field] === 'string' && doc[field]) {
        rows.attachments.push({
          id: 'doc:' + row.id + ':' + field,
          ordinal: 0,
          active: true,
          body: {
            documentId: row.id,
            field,
            value: doc[field],
            sha256: crypto.createHash('sha256').update(doc[field]).digest('hex'),
          },
        });
        delete doc[field];
      }
  }
  for (const row of rows.clients)
    if (Array.isArray(row.body.attachments)) {
      row.body.attachments.forEach((value, ordinal) =>
        rows.attachments.push({
          id: 'client:' + row.id + ':' + ordinal,
          ordinal,
          active: true,
          body: { clientId: row.id, value },
        }),
      );
      row.body.attachments = [];
    }
  if (Array.isArray(metadata.personnelAttachments)) {
    metadata.personnelAttachments.forEach((record, ordinal) =>
      rows.attachments.push({
        id: record.id,
        ordinal,
        active: true,
        body: { personnelId: record.personnelId, value: record.attachment },
      }),
    );
    metadata.personnelAttachments = [];
  }
  return { metadata, rows };
}
function join(metadata, rows) {
  const state = structuredClone(metadata),
    ordered = (t) =>
      (rows[t] || []).filter((r) => r.active !== false).sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
  for (const [table, path] of Object.entries(collections))
    if (get(state, path) !== undefined)
      set(
        state,
        path,
        ordered(table).map((r) => structuredClone(r.body)),
      );
  const docs = new Map((get(state, collections.documents) || []).map((d) => [String(d.id), d]));
  const clients = new Map((get(state, collections.clients) || []).map((c) => [String(c.id), c]));
  for (const r of ordered('conversations'))
    docs.get(r.body.documentId)?.conversations?.push(structuredClone(r.body.value));
  for (const r of ordered('attachments')) {
    if (r.body.personnelId)
      (state.personnelAttachments ||= []).push({
        id: r.id,
        personnelId: r.body.personnelId,
        attachment: structuredClone(r.body.value),
      });
    if (r.body.documentId && docs.has(r.body.documentId)) {
      const doc = docs.get(r.body.documentId);
      if (r.body.field === 'attachments') (doc.attachments ||= []).push(structuredClone(r.body.value));
      else doc[r.body.field] = r.body.value;
    }
    if (r.body.clientId) clients.get(r.body.clientId)?.attachments?.push(structuredClone(r.body.value));
  }
  return state;
}
module.exports = { collections, tables, split, join, digest, get, set };
