const { LEGACY_TENANT_ID } = require('./tenant-pool.cjs');

// How many users this office bought. The sales console prices per user, so the application
// refuses to create or reactivate an account beyond that number. `limit()` is null when there
// is nothing to enforce (the existing office on the root domain, or no subscription row), and a
// lookup failure denies: an account must never be added because the limit could not be read.
function createSeatGate(pool, { tenantId, cacheMs = 15000, now = Date.now } = {}) {
  let cached = null;
  return {
    async limit() {
      if (tenantId === LEGACY_TENANT_ID) return null;
      if (cached && now() < cached.until) return cached.value;
      try {
        const { rows } = await pool.query('SELECT seat_limit FROM han_saas.subscriptions WHERE tenant_id = $1', [
          tenantId,
        ]);
        const value = rows.length ? Number(rows[0].seat_limit) : null;
        cached = { value, until: now() + cacheMs };
        return value;
      } catch {
        throw Object.assign(new Error('Kullanıcı sayısı bilgisi alınamadı.'), { status: 503 });
      }
    },
  };
}

module.exports = { createSeatGate };
