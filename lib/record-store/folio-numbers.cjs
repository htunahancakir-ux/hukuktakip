const { inTransaction } = require('../db-transaction.cjs');

async function nextFolioNumber(db) {
  const {
    rows: [counter],
  } = await db.query(`
    INSERT INTO han_data.document_sequences(prefix,last_value)
    SELECT 'GLOBAL',greatest(
      coalesce((SELECT last_value FROM han_data.document_sequences WHERE prefix='GLOBAL'),(SELECT max(last_value) FROM han_data.document_sequences),0),
      coalesce((SELECT max(substring(number FROM '([0-9]+)$')::bigint) FROM han_data.documents WHERE number ~ '[0-9]+$'),0)
    )+1
    ON CONFLICT(tenant_id,prefix) DO UPDATE SET last_value=greatest(han_data.document_sequences.last_value,EXCLUDED.last_value-1)+1
    RETURNING last_value::text`);
  return counter.last_value;
}

async function renumberFolios(pool, { dryRun = false } = {}) {
  return inTransaction(pool, async (db) => {
    await db.query('SELECT id FROM han_data.control WHERE id=1 FOR UPDATE');
    const {
      rows: [meta],
    } = await db.query('SELECT body FROM han_data.metadata WHERE id=1 FOR UPDATE');
    if (meta.body.folioNumberingVersion === 1) return { alreadyApplied: true, count: 0 };
    await db.query('LOCK TABLE han_data.document_sequences IN EXCLUSIVE MODE');
    const { rows } = await db.query(
      'SELECT id,number,body FROM han_data.documents ORDER BY ordinal,id FOR UPDATE',
    );
    const mapping = rows.map((row, index) => ({ id: row.id, old: row.number, number: String(index + 1) }));
    if (dryRun) return { count: rows.length, mapping };
    await db.query(
      require('node:fs').readFileSync(
        require('node:path').resolve(__dirname, '../../scripts/renumber-numeric-folios.sql'),
        'utf8',
      ),
    );
    return { count: rows.length, mapping };
  });
}
module.exports = { nextFolioNumber, renumberFolios };
