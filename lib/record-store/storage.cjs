const { isDeepStrictEqual } = require('node:util');
const { inTransaction } = require('../db-transaction.cjs');
const { tables, split, join, digest } = require('./codec.cjs');
const conflict = () =>
  Object.assign(Error('Kayıt başka bir işlemle değişti. Güncel kaydı yükleyin.'), { status: 409 });
function tableName(table) {
  if (!tables.includes(table)) throw Error('Bilinmeyen kayıt tablosu');
  return 'han_data.' + table;
}
async function load(db, scope = null) {
  const meta = await db.query('SELECT body,revision FROM han_data.metadata WHERE id=1');
  if (!meta.rows.length) throw Error('Kayıt aktarımı henüz yapılmadı.');
  const rows = {};
  for (const table of tables) {
    if (scope?.tables && !scope.tables.includes(table)) {
      rows[table] = [];
      continue;
    }
    const { where, params } = require('./scope.cjs').selection(table, scope);
    rows[table] = (
      await db.query(
        'SELECT id,body,ordinal,revision,active FROM ' + tableName(table) + where + ' ORDER BY ordinal,id',
        params,
      )
    ).rows;
  }
  return { metadata: meta.rows[0].body, metadataRevision: meta.rows[0].revision, rows, scoped: !!scope };
}
async function insertRows(db, table, rows) {
  for (let offset = 0; offset < rows.length; offset += 250)
    await db.query(
      'INSERT INTO ' +
        tableName(table) +
        '(id,body,ordinal,active) SELECT id,body,ordinal,active FROM jsonb_to_recordset($1::jsonb) AS r(id text,body jsonb,ordinal bigint,active boolean)',
      [JSON.stringify(rows.slice(offset, offset + 250))],
    );
}
async function importRecords(pool) {
  return inTransaction(pool, async (db) => {
    await db.query('LOCK TABLE han_data.control IN EXCLUSIVE MODE');
    if ((await db.query('SELECT id FROM han_data.control')).rows.length)
      throw Error('Aktarılmış hedefin üzerine yazılamaz.');
    const {
      rows: [source],
    } = await db.query('SELECT payload,revision FROM han_private.han_state WHERE id=1 FOR SHARE');
    if (!source) throw Error('Kaynak bulunamadı.');
    const { metadata, rows } = split(source.payload);
    await db.query('INSERT INTO han_data.metadata(id,body) VALUES(1,$1::jsonb)', [JSON.stringify(metadata)]);
    for (const table of tables) await insertRows(db, table, rows[table]);
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    const roundtrip = await load(db),
      restored = join(roundtrip.metadata, roundtrip.rows);
    const checksum = digest(source.payload);
    if (digest(restored) !== checksum) throw Error('Aktarım bütünlüğü uyuşmuyor; işlem geri alındı.');
    await db.query(
      "INSERT INTO han_data.control(id,mode,source_revision,source_digest) VALUES(1,'shadow',$1,$2)",
      [source.revision, checksum],
    );
    return {
      digest: checksum,
      sourceRevision: String(source.revision),
      counts: Object.fromEntries(tables.map((t) => [t, rows[t].length])),
    };
  });
}
async function exportRecords(pool) {
  return inTransaction(
    pool,
    async (db) => {
      const data = await load(db);
      return join(data.metadata, data.rows);
    },
    { readOnly: true },
  );
}
async function activateRecords(pool) {
  return inTransaction(pool, async (db) => {
    const {
      rows: [source],
    } = await db.query('SELECT payload,revision FROM han_private.han_state WHERE id=1 FOR UPDATE');
    const {
      rows: [control],
    } = await db.query('SELECT * FROM han_data.control WHERE id=1 FOR UPDATE');
    if (!source || !control || control.mode !== 'shadow')
      throw Error('Geçiş kaynağı veya hazırlık kaydı bulunamadı.');
    const data = await load(db),
      current = join(data.metadata, data.rows);
    if (digest(source.payload) !== control.source_digest || digest(current) !== control.source_digest)
      throw Error('Kaynak değişti; son kayıtlar tekrar aktarılıp doğrulanmadan geçiş yapılamaz.');
    await db.query("UPDATE han_data.control SET mode='active' WHERE id=1");
    return { active: true, digest: control.source_digest };
  });
}
async function syncShadow(pool) {
  return inTransaction(pool, async (db) => {
    const {
      rows: [source],
    } = await db.query('SELECT payload,revision FROM han_private.han_state WHERE id=1 FOR SHARE');
    const {
      rows: [control],
    } = await db.query('SELECT mode FROM han_data.control WHERE id=1 FOR UPDATE');
    if (!source || control?.mode !== 'shadow') throw Error('Yalnız hazırlık deposu eşitlenebilir.');
    const before = await load(db);
    await writeChanges(db, before, source.payload);
    const copied = await load(db);
    if (digest(join(copied.metadata, copied.rows)) !== digest(source.payload))
      throw Error('Son eşitlemede bütünlük uyuşmuyor.');
    await db.query('UPDATE han_data.control SET source_revision=$1,source_digest=$2 WHERE id=1', [
      source.revision,
      digest(source.payload),
    ]);
    return { sourceRevision: String(source.revision), digest: digest(source.payload) };
  });
}
async function returnToLegacy(pool) {
  return inTransaction(pool, async (db) => {
    await db.query('SELECT id FROM han_private.han_state WHERE id=1 FOR UPDATE');
    const {
      rows: [control],
    } = await db.query('SELECT mode FROM han_data.control WHERE id=1 FOR UPDATE');
    if (control?.mode !== 'active') throw Error('Kayıt deposu etkin değil.');
    const data = await load(db),
      state = join(data.metadata, data.rows);
    await db.query("UPDATE han_data.control SET mode='shadow' WHERE id=1");
    await db.query(
      'UPDATE han_private.han_state SET payload=$1::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE id=1',
      [JSON.stringify(state)],
    );
    return { active: false, digest: digest(state) };
  });
}
// Compare-and-swap only changed records, in a deterministic lock order. A stale
// version rejects the entire operation, including its associated audit entries.
async function writeChanges(db, before, next) {
  const after = split(next, { includeArchives: !before.scoped });
  const changedDocuments = new Set();
  if (!isDeepStrictEqual(after.metadata, before.metadata)) {
    const result = await db.query(
      'UPDATE han_data.metadata SET body=$1::jsonb,revision=revision+1 WHERE id=1 AND revision=$2 RETURNING id',
      [JSON.stringify(after.metadata), before.metadataRevision],
    );
    if (!result.rows.length) throw conflict();
  }
  for (const table of [...tables].sort()) {
    const prior = new Map(before.rows[table].map((r) => [r.id, r])),
      current = new Map(after.rows[table].map((r) => [r.id, r]));
    for (const id of [...new Set([...prior.keys(), ...current.keys()])].sort()) {
      const old = prior.get(id),
        row = current.get(id);
      if (before.scoped && row && old) row.ordinal = Number(old.ordinal);
      if (before.scoped && row && !old) row.ordinal = Date.now();
      const changed =
        !old ||
        !row ||
        !isDeepStrictEqual(old.body, row.body) ||
        old.active !== row.active ||
        Number(old.ordinal) !== row.ordinal;
      if (changed && table === 'documents') changedDocuments.add(id);
      if (changed && table === 'financial_events')
        for (const r of [old, row]) if (r?.body.documentId) changedDocuments.add(r.body.documentId);
      if (!row) {
        // Retain parent/evidence rows. Export excludes inactive records.
        if (old.active) {
          const r = await db.query(
            'UPDATE ' +
              tableName(table) +
              ' SET active=false,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND revision=$2 RETURNING id',
            [id, old.revision],
          );
          if (!r.rows.length) throw conflict();
        }
      } else if (!old) await insertRows(db, table, [row]);
      else if (
        !isDeepStrictEqual(old.body, row.body) ||
        old.active !== row.active ||
        Number(old.ordinal) !== row.ordinal
      ) {
        const r = await db.query(
          'UPDATE ' +
            tableName(table) +
            ' SET body=$2::jsonb,ordinal=$3,active=$4,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND revision=$5 RETURNING id',
          [id, JSON.stringify(row.body), row.ordinal, row.active, old.revision],
        );
        if (!r.rows.length) throw conflict();
      }
    }
  }
  if (changedDocuments.size)
    await db.query('DELETE FROM han_data.document_balances WHERE document_id=ANY($1::text[])', [
      [...changedDocuments],
    ]);
}
module.exports = {
  tableName,
  load,
  insertRows,
  importRecords,
  exportRecords,
  writeChanges,
  activateRecords,
  returnToLegacy,
  syncShadow,
};
