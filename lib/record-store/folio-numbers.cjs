const { inTransaction } = require('../db-transaction.cjs');

async function nextFolioNumber(db) {
  const {
    rows: [counter],
  } = await db.query(`
    INSERT INTO han_data.document_sequences(prefix,last_value)
    SELECT 'GLOBAL',greatest(
      coalesce((SELECT last_value FROM han_data.document_sequences WHERE tenant_id=han_private.current_tenant() AND prefix='GLOBAL'),(SELECT max(last_value) FROM han_data.document_sequences WHERE tenant_id=han_private.current_tenant()),0),
      coalesce((SELECT max(substring(number FROM '([0-9]+)$')::bigint) FROM han_data.documents WHERE tenant_id=han_private.current_tenant() AND number ~ '[0-9]+$'),0)
    )+1
    ON CONFLICT(tenant_id,prefix) DO UPDATE SET last_value=greatest(han_data.document_sequences.last_value,EXCLUDED.last_value-1)+1
    RETURNING last_value::text`);
  return counter.last_value;
}

async function renumberFolios(pool, { dryRun = false, version = 1 } = {}) {
  if (![1, 2].includes(version)) throw new Error('Unsupported folio numbering version');
  return inTransaction(pool, async (db) => {
    await db.query(
      'SELECT id FROM han_data.control WHERE tenant_id=han_private.current_tenant() AND id=1 FOR UPDATE',
    );
    const {
      rows: [meta],
    } = await db.query(
      'SELECT body FROM han_data.metadata WHERE tenant_id=han_private.current_tenant() AND id=1 FOR UPDATE',
    );
    if (Number(meta.body.folioNumberingVersion || 0) >= version) return { alreadyApplied: true, count: 0 };
    await db.query('LOCK TABLE han_data.document_sequences IN EXCLUSIVE MODE');
    const { rows } = await db.query(
      `SELECT id,number,body FROM han_data.documents WHERE tenant_id=han_private.current_tenant() ORDER BY ${version === 2 ? 'active DESC,' : ''}ordinal,id FOR UPDATE`,
    );
    const mapping = rows.map((row, index) => ({ id: row.id, old: row.number, number: String(index + 1) }));
    if (dryRun) return { count: rows.length, mapping };
    await db.query(
      require('node:fs').readFileSync(
        require('node:path').resolve(
          __dirname,
          '../../scripts/',
          version === 2 ? 'renumber-folios-v2.sql' : 'renumber-numeric-folios.sql',
        ),
        'utf8',
      ),
    );
    return { count: rows.length, mapping };
  });
}
module.exports = { nextFolioNumber, renumberFolios };
