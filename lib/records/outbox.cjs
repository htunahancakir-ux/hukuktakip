const crypto = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');
// Dispatch must recheck the recipient's current consent and retrieve credentials
// server-side. No secret, reset token or attachment bytes are stored in the outbox.
function createOutboxDispatcher(pool, dispatch) {
  return async function run(limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid batch size');
    const lease = crypto.randomUUID();
    const jobs = await inTransaction(pool, async (db) => {
      await db.query(`UPDATE han_core.outbox SET status='unknown',updated_at=clock_timestamp()
        WHERE status='sending' AND lease_until < clock_timestamp()`);
      const { rows } = await db.query(
        `WITH claimed AS (
        SELECT id FROM han_core.outbox WHERE status='pending' AND available_at <= clock_timestamp()
        ORDER BY available_at,id LIMIT $1 FOR UPDATE SKIP LOCKED
      ) UPDATE han_core.outbox o SET status='sending', lease_token=$2,
        lease_until=clock_timestamp()+interval '3 minutes', attempts=attempts+1,updated_at=clock_timestamp()
        FROM claimed WHERE o.id=claimed.id RETURNING o.id,o.topic,o.body`,
        [limit, lease],
      );
      return rows;
    });
    for (const job of jobs) {
      let status = 'unknown',
        providerId = null;
      try {
        const result = await dispatch(job);
        if (result?.providerId) {
          status = 'accepted';
          providerId = String(result.providerId);
        } else if (result?.rejected === true) status = 'failed';
      } catch {}
      await pool.query(
        `UPDATE han_core.outbox SET status=$3,provider_id=$4,updated_at=clock_timestamp()
        WHERE id=$1 AND lease_token=$2 AND status='sending'`,
        [job.id, lease, status, providerId],
      );
    }
    return { processed: jobs.length };
  };
}
module.exports = { createOutboxDispatcher };
