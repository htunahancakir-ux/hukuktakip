const { collections, get } = require('./record-store/codec.cjs');

// The account flag comes from the authenticated server-side account, never the request body.
function markRecord(previous, record, actor, noteField) {
  if (!record || typeof record !== 'object') return;
  if (previous?.testRecord) record.testRecord = structuredClone(previous.testRecord);
  else if (!previous && actor?.testAccount === true) {
    record.testRecord = {
      userId: actor.id,
      userName: actor.name,
      createdAt: new Date().toISOString(),
      note: 'TEST KAYDI — ' + actor.name + ' tarafından oluşturuldu.',
    };
  } else delete record.testRecord;
  if (noteField && record.testRecord) {
    const note = String(record[noteField] || '').trim();
    const label = record.testRecord.note;
    record[noteField] = note.includes(label) ? note : [note, label].filter(Boolean).join('\n');
  }
}

const noteFields = {
  clients: 'notes',
  documents: 'notes',
  personnel: 'notes',
  cases: 'notes',
  financial_events: 'note',
  ledger_entries: 'note',
  reminders: 'note',
};
function markRows(previous = [], records = [], actor, noteField) {
  const byId = new Map(previous.map((row, index) => [row.id ?? row.sequence ?? index, row]));
  for (const [index, row] of records.entries())
    markRecord(byId.get(row.id ?? row.sequence ?? index), row, actor, noteField);
}
function markStateRecords(previous, next, actor) {
  for (const [table, path] of Object.entries(collections)) {
    if (table.endsWith('_archives') || table.endsWith('_notices')) continue;
    markRows(get(previous, path), get(next, path), actor, noteFields[table]);
  }
  const docs = new Map((previous.data?.['icrapro-v1']?.docs || []).map((d) => [d.id, d]));
  for (const doc of next.data?.['icrapro-v1']?.docs || [])
    markRows(docs.get(doc.id)?.conversations, doc.conversations, actor, 'note');
  markRows(previous.marketingProspects, next.marketingProspects, actor, 'notes');
}
function matchesNote(record, note) {
  if (record.note === note) return true;
  const label = record.testRecord?.note;
  return !!label && record.note === [note, label].filter(Boolean).join('\n');
}
module.exports = { markRecord, markStateRecords, matchesNote };
