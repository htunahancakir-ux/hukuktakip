const { LEGACY_TENANT_ID } = require('./tenant-pool.cjs');

const LABEL = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });

function hostOf(req) {
  // Host is set by the platform edge for the requested domain. Forwarded-* headers
  // are client-controllable on some deployments and are deliberately ignored.
  const raw = req.headers?.host;
  if (typeof raw !== 'string' || raw.length > 255) return '';
  return raw.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

// Maps a request host to an office. Returns { slug } for <slug>.<baseDomain>,
// { legacy: true } for the bare base domain, { platform: true } for admin.<baseDomain>
// (the operator console) and throws 404 for anything else.
function parseHost(req, baseDomain) {
  const host = hostOf(req);
  if (host === baseDomain) return { legacy: true };
  const suffix = '.' + baseDomain;
  if (!host.endsWith(suffix)) throw fail(404, 'Büro bulunamadı.');
  const slug = host.slice(0, -suffix.length);
  // A single label only: a.b.base or www-style tricks never reach the lookup.
  if (!LABEL.test(slug)) throw fail(404, 'Büro bulunamadı.');
  if (slug === 'admin') return { platform: true };
  return { slug };
}

// Resolves the request's office from the Host header. With no base domain
// configured the deployment stays single-office (the existing behavior).
// `pool` is the privileged control-plane pool: tenant status is read outside RLS.
function createTenantResolver(pool, { baseDomain = process.env.HAN_TENANT_BASE_DOMAIN, cacheMs = 30000 } = {}) {
  const base = typeof baseDomain === 'string' ? baseDomain.trim().toLowerCase() : '';
  if (base && !DOMAIN.test(base)) throw Error('HAN_TENANT_BASE_DOMAIN is not a valid domain');
  if (base && !pool) throw Error('DATABASE_URL is required when HAN_TENANT_BASE_DOMAIN is set');
  const cache = new Map();

  async function lookup(slug) {
    const { rows } = await pool.query(
      `SELECT t.id, t.slug FROM han_saas.tenants t
       JOIN han_saas.subscriptions s ON s.tenant_id = t.id
       WHERE t.slug = $1 AND t.id <> $2 AND t.status = 'enabled'
         AND s.status IN ('trialing', 'active') AND s.access_until > CURRENT_TIMESTAMP
       LIMIT 1`,
      [slug, LEGACY_TENANT_ID],
    );
    return rows[0] || null;
  }

  return {
    baseDomain: base,
    async resolve(req) {
      if (!base) return { tenantId: LEGACY_TENANT_ID, slug: null };
      const parsed = parseHost(req, base);
      if (parsed.legacy) return { tenantId: LEGACY_TENANT_ID, slug: null };
      if (parsed.platform) return { platform: true };
      const hit = cache.get(parsed.slug);
      if (hit && hit.until > Date.now()) {
        if (!hit.tenant) throw fail(403, 'Bu büroya erişilemiyor.');
        return { tenantId: hit.tenant.id, slug: hit.tenant.slug };
      }
      const tenant = await lookup(parsed.slug);
      // Short cache bounds database load; suspension takes effect within cacheMs.
      if (cache.size >= 1000) cache.clear();
      cache.set(parsed.slug, { tenant, until: Date.now() + cacheMs });
      if (!tenant) throw fail(403, 'Bu büroya erişilemiyor.');
      return { tenantId: tenant.id, slug: tenant.slug };
    },
  };
}

module.exports = { createTenantResolver, parseHost };
