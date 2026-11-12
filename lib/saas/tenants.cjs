const { randomUUID } = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');
const { buildUser } = require('./office-users.cjs');

const SLUG = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;
const RESERVED = new Set(['www', 'api', 'app', 'admin', 'auth', 'support', 'billing', 'status']);
// Trial default only: pricing is per user and the purchased count is per office.
const TRIAL_USER_LIMIT = 3;
function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}
function text(value, min, max) {
  return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
}
function checkOffice({ slug, name, userLimit }) {
  if (typeof slug !== 'string' || !SLUG.test(slug) || RESERVED.has(slug))
    throw invalid('Geçerli bir büro kodu girin (3–63 küçük harf, rakam veya tire).');
  if (!text(name, 2, 160)) throw invalid('Büro adı 2–160 karakter olmalıdır.');
  if (!Number.isInteger(userLimit) || userLimit < 1 || userLimit > 10000)
    throw invalid('Kullanıcı sayısı 1–10000 arasında olmalıdır.');
}

// terms: trial by default; a sale passes { months, userPriceKurus, status: 'active', planCode: 'paid' }.
async function insertOffice(db, { slug, name, userLimit }, terms = {}) {
  const id = randomUUID();
  const { rows } = await db.query(
    `INSERT INTO han_saas.tenants(id, slug, name) VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO NOTHING RETURNING id, slug, name, status`,
    [id, slug, name.trim()],
  );
  if (!rows.length) throw Object.assign(new Error('Bu büro kodu kullanılıyor.'), { status: 409 });
  await db.query(
    `INSERT INTO han_saas.subscriptions(tenant_id, access_until, seat_limit, user_price_kurus, status, plan_code)
     VALUES ($1, CASE WHEN $3::int IS NULL THEN CURRENT_TIMESTAMP + interval '14 days'
                      ELSE CURRENT_TIMESTAMP + make_interval(months => $3::int) END, $2, $4, $5, $6)`,
    [id, userLimit, terms.months ?? null, terms.userPriceKurus ?? 0, terms.status ?? 'trialing', terms.planCode ?? 'trial'],
  );
  return rows[0];
}

// Internal provisioning service, not a public signup handler. The caller must
// authenticate ownerUserId before calling; creation does not enable data access.
async function createTenant(pool, { slug, name, ownerUserId, userLimit = TRIAL_USER_LIMIT }) {
  checkOffice({ slug, name, userLimit });
  if (!text(ownerUserId, 1, 200)) throw invalid('Doğrulanmış kullanıcı gerekli.');
  return inTransaction(pool, async (db) => {
    const office = await insertOffice(db, { slug, name, userLimit });
    await db.query(`INSERT INTO han_saas.memberships(tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      office.id,
      ownerUserId.trim(),
    ]);
    return office;
  });
}

// Validates and hashes everything slow *before* a transaction opens (no locks held during scrypt).
async function prepareOffice({ slug, name, admin, userLimit = TRIAL_USER_LIMIT }) {
  checkOffice({ slug, name, userLimit });
  const user = await buildUser({ ...admin, role: 'ceo' });
  // Required lazily: the template lives with the workspace implementation.
  const data = structuredClone(require('../../outputs/icrapro/access-server.cjs').defaultData);
  return { slug, name, userLimit, user, data };
}

// Tenant, subscription, empty workspace, ceo account and owner membership on an open
// transaction. The office stays in 'provisioning' unless the caller enables it.
async function insertPreparedOffice(db, prepared, terms) {
  const office = await insertOffice(db, prepared, terms);
  await db.query('INSERT INTO han_private.han_state(id, payload, tenant_id) VALUES (1, $1::jsonb, $2)', [
    JSON.stringify({ users: [prepared.user], data: prepared.data }),
    office.id,
  ]);
  await db.query(`INSERT INTO han_saas.memberships(tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [
    office.id,
    prepared.user.id,
  ]);
  return { ...office, adminUserId: prepared.user.id };
}

// Creates a whole office in one transaction. The office stays in 'provisioning';
// enabling it is a separate, deliberate step. Internal service: the browser must
// never be able to reach it unauthenticated.
async function provisionOffice(pool, input) {
  const prepared = await prepareOffice(input);
  return inTransaction(pool, (db) => insertPreparedOffice(db, prepared));
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

module.exports = {
  createTenant,
  provisionOffice,
  prepareOffice,
  insertPreparedOffice,
  requireTenantAccess,
  TRIAL_USER_LIMIT,
};
