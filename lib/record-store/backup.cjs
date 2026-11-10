const { inTransaction } = require('../db-transaction.cjs');
const { load } = require('./storage.cjs');
const { join, digest } = require('./codec.cjs');
async function exportBackup(pool, { records = false } = {}) {
  return inTransaction(
    pool,
    async (db) => {
      let state;
      if (records) {
        await require('./adapter.cjs').requireActive(db);
        const data = await load(db);
        state = join(data.metadata, data.rows);
      } else
        state = (await db.query('SELECT payload FROM han_private.han_state WHERE id=1')).rows[0]?.payload;
      if (!state) throw Error('Yedeklenecek kayıt bulunamadı.');
      const { rows: audit } = await db.query(`SELECT id::text,occurred_at::text,category,action,area,
      actor_id,actor_name,actor_username,record_ref,fields FROM han_private.han_audit ORDER BY id`);
      return {
        ...state,
        ...(await require('../voip-store.cjs').exportData(db)),
        _hanBackup: {
          version: 2,
          source: records ? 'records' : 'legacy',
          audit,
          auditDigest: digest(audit),
          createdAt: new Date().toISOString(),
        },
      };
    },
    { readOnly: true },
  );
}
function validateAudit(bundle) {
  if (!bundle) return;
  if (bundle.version !== 2 || !Array.isArray(bundle.audit) || digest(bundle.audit) !== bundle.auditDigest)
    throw Error('Denetim yedeği bütünlük kontrolü başarısız.');
}
async function restoreAudit(db, bundle) {
  if (!bundle) return;
  validateAudit(bundle);
  if ((await db.query('SELECT 1 FROM han_private.han_audit LIMIT 1')).rows.length)
    throw Error('Denetim hedefi boş olmalıdır.');
  for (let i = 0; i < bundle.audit.length; i += 250)
    await db.query(
      `INSERT INTO han_private.han_audit
    (id,occurred_at,category,action,area,actor_id,actor_name,actor_username,record_ref,fields) OVERRIDING SYSTEM VALUE
    SELECT id,occurred_at,category,action,area,actor_id,actor_name,actor_username,record_ref,fields
    FROM jsonb_to_recordset($1::jsonb) AS a(id bigint,occurred_at timestamptz,category text,action text,area text,
      actor_id text,actor_name text,actor_username text,record_ref text,fields text[])`,
      [JSON.stringify(bundle.audit.slice(i, i + 250))],
    );
  await db.query(
    "SELECT setval(pg_get_serial_sequence('han_private.han_audit','id'),coalesce((SELECT max(id) FROM han_private.han_audit),1),EXISTS(SELECT 1 FROM han_private.han_audit))",
  );
}
module.exports = { exportBackup, restoreAudit, validateAudit };
