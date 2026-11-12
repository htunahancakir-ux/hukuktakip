const { inTransaction } = require('../db-transaction.cjs');
const { advanceRepeatingReminders } = require('../reminder-repeat.cjs');
async function refreshRepeatingReminders(pool, accountId, now = Date.now()) {
  return inTransaction(pool, async (db) => {
    await db.query('SELECT id FROM han_private.han_account_index WHERE id=$1 FOR UPDATE', [accountId]);
    const { rows } = await db.query(
      `SELECT id,body FROM han_data.reminders WHERE active AND body->>'accountId'=$1
   AND body->>'repeat' IN ('daily','weekly','monthly','yearly') AND coalesce(body->>'nextReminderId','')=''
   AND coalesce(body->>'closedAt','')='' AND body->>'dueAt'<=$2 ORDER BY id FOR UPDATE`,
      [accountId, new Date(now).toISOString()],
    );
    if (!rows.length) return;
    const state = { scheduledReminders: rows.map((row) => structuredClone(row.body)) };
    if (!advanceRepeatingReminders(state, now, accountId)) return;
    const existing = new Set(rows.map((row) => row.id));
    for (const row of state.scheduledReminders) {
      if (existing.has(row.id))
        await db.query(
          'UPDATE han_data.reminders SET body=$2::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1',
          [row.id, JSON.stringify(row)],
        );
      else
        await db.query(
          'INSERT INTO han_data.reminders(id,body,ordinal,active) VALUES($1,$2::jsonb,$3,true) ON CONFLICT(id) DO NOTHING',
          [row.id, JSON.stringify(row), now],
        );
    }
  });
}
module.exports = { refreshRepeatingReminders };
