// One connection owns the transaction, its locks and all associated audit writes.
async function inTransaction(pool, work, { readOnly = false } = {}) {
  const db = await pool.connect();
  try {
    await db.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    await db.query("SET LOCAL lock_timeout = '10s'");
    await db.query("SET LOCAL statement_timeout = '15s'");
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    db.release();
  }
}
module.exports = { inTransaction };
