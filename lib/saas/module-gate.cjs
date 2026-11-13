const { LEGACY_TENANT_ID } = require('./tenant-pool.cjs');

// Paid add-on modules that the application actually enforces. An office that was sold
// without one of these has the feature switched off: its API answers 403 and its screens
// stay hidden. Everything else in the catalog is only recorded for billing today.
// Rota Bulma has two: `marketing-routes` (the office searches with its own map keys) and
// `marketing-routes-service` (a subscription to the selling company's map service). Either
// one opens the feature; see lib/saas/platform-maps.cjs.
const GATED_MODULES = ['voip', 'ai-assistant', 'whatsapp', 'marketing-routes', 'marketing-routes-service'];

// The existing office (served on the root domain, before add-ons were sold) keeps every
// feature. Any other office gets exactly the modules recorded as active in the sales
// console, plus free trials until they end; a sale or removal there applies within `cacheMs`. A lookup failure denies: a
// feature must never switch on because the control plane could not be asked.
function createModuleGate(pool, { tenantId, cacheMs = 15000, now = Date.now } = {}) {
  let cached = null;
  async function active() {
    if (tenantId === LEGACY_TENANT_ID) return new Set(GATED_MODULES);
    if (cached && now() < cached.until) return cached.codes;
    try {
      const { rows } = await pool.query(
        `SELECT module_code FROM han_saas.tenant_modules WHERE tenant_id = $1
         AND (status = 'active' OR (status = 'trial' AND trial_until > CURRENT_TIMESTAMP))`,
        [tenantId],
      );
      cached = { codes: new Set(rows.map((r) => r.module_code)), until: now() + cacheMs };
      return cached.codes;
    } catch {
      throw Object.assign(new Error('Modül bilgisi alınamadı.'), { status: 503 });
    }
  }
  return {
    async enabled(code) {
      return (await active()).has(code);
    },
    async all() {
      const codes = await active();
      return Object.fromEntries(GATED_MODULES.map((code) => [code, codes.has(code)]));
    },
  };
}

module.exports = { createModuleGate, GATED_MODULES };
