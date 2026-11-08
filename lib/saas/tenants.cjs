const { randomUUID } = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');

const SLUG = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;
const RESERVED = new Set(['www', 'api', 'app', 'admin', 'auth', 'support', 'billing', 'status']);
function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}
function text(value, min, max) {
  return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
}

// Internal provisioning service, not a public signup handler. The caller must
// authenticate ownerUserId before calling; creation does not enable data access.
async function createTenant(pool, { slug, name, ownerUserId }) {
  if (typeof slug !== 'string' || !SLUG.test(slug) || RESERVED.has(slug))
    throw invalid('Geçerli bir büro kodu girin (3–63 küçük harf, rakam veya tire).');
  if (!text(name, 2, 160)) throw invalid('Büro adı 2–160 karakter olmalıdır.');
  if (!text(ownerUserId, 1, 200)) throw invalid('Doğrulanmış kullanıcı gerekli.');
  return inTransaction(pool, async (db) => {
    const id = randomUUID();
    const { rows } = await db.query(
      `INSERT INTO han_saas.tenants(id, slug, name) VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO NOTHING RETURNING id, slug, name, status`,
      [id, slug, name.trim()],
    );
    if (!rows.length) throw Object.assign(new Error('Bu büro kodu kullanılıyor.'), { status: 409 });
    await db.query(`INSERT INTO han_saas.memberships(tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      id,
      ownerUserId.trim(),
    ]);
    await db.query(
      `INSERT INTO han_saas.subscriptions(tenant_id, access_until, seat_limit)
       VALUES ($1, CURRENT_TIMESTAMP + interval '14 days', 3)`,
      [id],
    );
    return rows[0];
  });
}

// Authorization for the future tenant-aware runtime. This does NOT scope legacy
// SQL queries: do not expose tenants on the current application with this alone.
async function requireTenantAccess(db, { slug, userId }) {
  const denied = () => Object.assign(new Error('Bu büroya erişilemiyor.'), { status: 403 });
  if (typeof slug !== 'string' || !SLUG.test(slug) || !text(userId, 1, 200)) throw denied();
  const { rows } = await db.query(
    `SELECT t.id, t.slug, t.name, m.role, s.plan_code, s.seat_limit
     FROM han_saas.tenants t
     JOIN han_saas.memberships m ON m.tenant_id = t.id
     JOIN han_saas.subscriptions s ON s.tenant_id = t.id
     WHERE t.slug = $1 AND m.user_id = $2 AND m.status = 'active'
       AND t.status = 'enabled' AND s.status IN ('trialing', 'active')
       AND s.access_until > CURRENT_TIMESTAMP`,
    [slug, userId],
  );
  if (!rows.length) throw denied();
  return rows[0];
}

module.exports = { createTenant, requireTenantAccess };
