const { seal, open } = require('./totp.cjs');
const { record } = require('./platform-account.cjs');
const { API_KEY } = require('../maps-settings.cjs');
const places = require('../google-places.cjs');

// The selling company's own Google Maps account ("hazır harita servisi"), configured in the
// platform console. Rota Bulma is sold two ways:
//   marketing-routes          the module; the office enters its own map keys in Ayarlar
//   marketing-routes-service  a monthly subscription; searches run on this account
// A subscribed office needs no key. Its searches are counted per day in han_saas.usage_daily
// and capped per month, because every request is billed to the selling company.
// The Places key is sealed and never returned; the map key is a browser key (public by design).

const LABEL = 'hanhukuk-platform-maps-v1';
const SERVICE_MODULE = 'marketing-routes-service';
const DEFAULT_LIMITS = Object.freeze({ monthlySearches: 300, monthlyDetails: 3000 });
const MAX_LIMIT = 1_000_000;
const MONTH_START = "date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Istanbul')::date";
const fail = (status, message) => Object.assign(new Error(message), { status });

async function readConfig(db) {
  const { rows } = await db.query("SELECT value, updated_at FROM han_saas.platform_settings WHERE key = 'maps'");
  return rows.length ? { ...rows[0].value, updatedAt: rows[0].updated_at } : null;
}

const limitOf = (value, fallback) => (Number.isSafeInteger(value) && value >= 1 && value <= MAX_LIMIT ? value : fallback);

function publicConfig(config) {
  const saved = !!config?.apiKeyEnc;
  return {
    configured: saved,
    enabled: saved && config.enabled === true,
    browserKey: typeof config?.browserKey === 'string' ? config.browserKey : '',
    monthlySearches: limitOf(config?.monthlySearches, DEFAULT_LIMITS.monthlySearches),
    monthlyDetails: limitOf(config?.monthlyDetails, DEFAULT_LIMITS.monthlyDetails),
    updatedAt: config?.updatedAt || null,
  };
}

function keyInput(value, label) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !API_KEY.test(value.trim()))
    throw fail(400, `${label} biçimi geçersiz. Anahtar "AIza" ile başlar ve 39 karakterdir.`);
  return value.trim();
}

function limitInput(value, label, current) {
  if (value === undefined) return current;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT)
    throw fail(400, `${label} 1 ile ${MAX_LIMIT.toLocaleString('tr-TR')} arasında bir tam sayı olmalıdır.`);
  return value;
}

async function getSettings(pool) {
  const config = publicConfig(await readConfig(pool));
  const { rows } = await pool.query(
    `SELECT t.id AS "tenantId", t.name,
            coalesce(sum(u.quantity) FILTER (WHERE u.metric = 'maps_searches'), 0)::int AS searches,
            coalesce(sum(u.quantity) FILTER (WHERE u.metric = 'maps_details'), 0)::int AS details
     FROM han_saas.usage_daily u JOIN han_saas.tenants t ON t.id = u.tenant_id
     WHERE u.metric IN ('maps_searches', 'maps_details') AND u.day >= ${MONTH_START}
     GROUP BY t.id, t.name ORDER BY searches DESC, t.name LIMIT 50`,
  );
  return {
    ...config,
    usage: {
      monthSearches: rows.reduce((sum, row) => sum + row.searches, 0),
      monthDetails: rows.reduce((sum, row) => sum + row.details, 0),
      offices: rows,
    },
  };
}

async function saveSettings(pool, adminId, input) {
  const saved = await readConfig(pool);
  if (input.clear === true) {
    await pool.query("DELETE FROM han_saas.platform_settings WHERE key = 'maps'");
    await record(pool, adminId, 'settings.maps_clear', 'maps');
    return publicConfig(null);
  }
  const apiKey = keyInput(input.apiKey, 'Google Places API anahtarı');
  const browserKey =
    input.browserKey === undefined ? saved?.browserKey || '' : keyInput(input.browserKey, 'Harita anahtarı');
  const next = {
    apiKeyEnc: apiKey ? seal(apiKey, LABEL) : saved?.apiKeyEnc,
    browserKey,
    enabled: input.enabled === undefined ? saved?.enabled === true : input.enabled === true,
    monthlySearches: limitInput(
      input.monthlySearches,
      'Aylık arama sınırı',
      limitOf(saved?.monthlySearches, DEFAULT_LIMITS.monthlySearches),
    ),
    monthlyDetails: limitInput(
      input.monthlyDetails,
      'Aylık rota yenileme sınırı',
      limitOf(saved?.monthlyDetails, DEFAULT_LIMITS.monthlyDetails),
    ),
  };
  if (!next.apiKeyEnc) throw fail(400, 'Google Places API anahtarını girin.');
  // The secret key must never be handed to browsers as the map key.
  if (browserKey && browserKey === (apiKey || open(next.apiKeyEnc, LABEL)))
    throw fail(
      400,
      'Harita anahtarı, Places API anahtarından farklı olmalıdır: harita anahtarı büroların tarayıcısına gönderilir.',
    );
  await pool.query(
    `INSERT INTO han_saas.platform_settings(key, value, updated_by, updated_at) VALUES ('maps', $1::jsonb, $2, clock_timestamp())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(next), adminId],
  );
  await record(pool, adminId, 'settings.maps', next.enabled ? 'açık' : 'kapalı');
  return publicConfig(await readConfig(pool));
}

// Tests the typed key, or the saved one when the field is blank, with a free ID-only search.
async function testSettings(pool, input, { fetcher } = {}) {
  const saved = await readConfig(pool);
  const apiKey = keyInput(input.apiKey, 'Google Places API anahtarı') || (saved?.apiKeyEnc ? open(saved.apiKeyEnc, LABEL) : '');
  if (!apiKey) throw fail(412, 'Önce Google Places API anahtarını girin.');
  try {
    await places.testKey({ apiKey, fetcher });
  } catch (error) {
    throw fail(error.code === 429 ? 429 : 502, error.message);
  }
  return { ok: true };
}

async function monthUsage(pool, tenantId) {
  const { rows } = await pool.query(
    `SELECT coalesce(sum(quantity) FILTER (WHERE metric = 'maps_searches'), 0)::int AS searches,
            coalesce(sum(quantity) FILTER (WHERE metric = 'maps_details'), 0)::int AS details
     FROM han_saas.usage_daily
     WHERE tenant_id = $1 AND metric IN ('maps_searches', 'maps_details') AND day >= ${MONTH_START}`,
    [tenantId],
  );
  return rows[0];
}

// What one subscribed office's application gets. `runtime()` never throws: when the control
// plane cannot be asked the service is simply not ready, it never falls back to an unchecked
// call on the selling company's account.
function createPlatformMaps(pool, { tenantId, cacheMs = 15000, now = Date.now } = {}) {
  let cached = null;
  async function config() {
    if (cached && now() < cached.until) return cached.value;
    cached = { value: await readConfig(pool), until: now() + cacheMs };
    return cached.value;
  }
  const safe = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);
  return {
    async runtime() {
      try {
        const saved = await config();
        const shown = publicConfig(saved);
        if (!shown.enabled) return { ready: false, reason: 'off', browserKey: '' };
        const used = await monthUsage(pool, tenantId);
        const searchesLeft = Math.max(0, shown.monthlySearches - used.searches);
        const detailsLeft = Math.max(0, shown.monthlyDetails - used.details);
        return {
          ready: searchesLeft > 0,
          reason: searchesLeft > 0 ? '' : 'quota',
          apiKey: open(saved.apiKeyEnc, LABEL),
          browserKey: shown.browserKey,
          monthlySearches: shown.monthlySearches,
          searchesLeft,
          monthlyDetails: shown.monthlyDetails,
          detailsLeft,
        };
      } catch {
        console.error('Platform map service could not be read');
        return { ready: false, reason: 'error', browserKey: '' };
      }
    },
    // Counts what a finished request used. Metering never fails the request that searched.
    async record(usage) {
      const searches = safe(usage?.searches);
      const details = safe(usage?.details);
      if (!searches && !details) return;
      try {
        await pool.query(
          `INSERT INTO han_saas.usage_daily(tenant_id, day, metric, quantity)
           SELECT $1, (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Istanbul')::date, m.metric, m.quantity
           FROM (VALUES ('maps_searches', $2::bigint), ('maps_details', $3::bigint)) AS m(metric, quantity)
           WHERE m.quantity > 0
           ON CONFLICT (tenant_id, day, metric) DO UPDATE SET quantity = han_saas.usage_daily.quantity + EXCLUDED.quantity`,
          [tenantId, searches, details],
        );
      } catch {
        console.error('Map service usage could not be metered');
      }
    },
  };
}

module.exports = {
  SERVICE_MODULE,
  DEFAULT_LIMITS,
  getSettings,
  saveSettings,
  testSettings,
  createPlatformMaps,
  publicConfig,
};
