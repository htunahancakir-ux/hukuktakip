const { createVerimorSms, smsNumber, maskNumber, segments } = require('../verimor-sms.cjs');
const { seal, open } = require('./totp.cjs');
const { record } = require('./platform-account.cjs');

// The selling company's own Verimor SMS account, configured in the platform console. Offices
// use it for critical messages (password recovery, an operator-triggered reset) until they set
// up their own WhatsApp integration. The API password is sealed and never returned.

const LABEL = 'hanhukuk-platform-sms-v1';
// Platform credits are paid by the selling company: cap what one office can trigger per day.
const DAILY_LIMIT_PER_OFFICE = 30;
const fail = (status, message) => Object.assign(new Error(message), { status });

async function readConfig(db) {
  const { rows } = await db.query("SELECT value, updated_at FROM han_saas.platform_settings WHERE key = 'sms'");
  return rows.length ? { ...rows[0].value, updatedAt: rows[0].updated_at } : null;
}

function publicConfig(config) {
  const saved = !!(config?.username && config?.passwordEnc);
  return {
    configured: saved,
    enabled: saved && config.enabled === true,
    username: config?.username || '',
    header: config?.header || '',
    updatedAt: config?.updatedAt || null,
  };
}

function cleanInput(input) {
  const username = String(input.username ?? '').trim();
  const header = String(input.header ?? '').trim();
  if (username && !/^\d{10,15}$/.test(username))
    throw fail(400, 'Verimor kullanıcı adı hesap numaranızdır (ör. 908501234567).');
  if (header.length > 20) throw fail(400, 'SMS başlığı en fazla 20 karakter olabilir.');
  const password = typeof input.password === 'string' ? input.password.trim() : '';
  if (password.length > 200) throw fail(400, 'API şifresi çok uzun.');
  return { username, header, password };
}

// Client for the saved settings, or for values typed into the form (a blank password uses the
// saved one) so the operator can test before saving.
async function clientFor(db, input = {}, { fetcher } = {}) {
  const saved = await readConfig(db);
  const typed = cleanInput(input);
  const username = typed.username || saved?.username;
  const password = typed.password || (saved?.passwordEnc ? open(saved.passwordEnc, LABEL) : '');
  if (!username || !password) throw fail(412, 'Önce Verimor kullanıcı adı ve API şifresini girin.');
  return createVerimorSms({ username, password, header: typed.header || saved?.header || '', fetcher });
}

async function getSettings(pool) {
  const config = publicConfig(await readConfig(pool));
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'sent' AND created_at >= date_trunc('month', CURRENT_TIMESTAMP))::int AS month_sent,
            coalesce(sum(segments) FILTER (WHERE status = 'sent' AND created_at >= date_trunc('month', CURRENT_TIMESTAMP)), 0)::int AS month_segments,
            count(*) FILTER (WHERE status = 'failed' AND created_at > CURRENT_TIMESTAMP - interval '30 days')::int AS failed30,
            count(*) FILTER (WHERE status = 'blocked' AND created_at > CURRENT_TIMESTAMP - interval '30 days')::int AS blocked30
     FROM han_saas.sms_log`,
  );
  const recent = await pool.query(
    `SELECT l.id::text AS id, l.purpose, l.dest_masked AS dest, l.status, l.error, l.created_at AS "createdAt",
            t.name AS office
     FROM han_saas.sms_log l LEFT JOIN han_saas.tenants t ON t.id = l.tenant_id
     ORDER BY l.id DESC LIMIT 50`,
  );
  const s = rows[0];
  return {
    ...config,
    usage: { monthSent: s.month_sent, monthSegments: s.month_segments, failed30: s.failed30, blocked30: s.blocked30 },
    recent: recent.rows,
    dailyLimitPerOffice: DAILY_LIMIT_PER_OFFICE,
  };
}

async function saveSettings(pool, adminId, input) {
  const saved = await readConfig(pool);
  if (input.clear === true) {
    await pool.query("DELETE FROM han_saas.platform_settings WHERE key = 'sms'");
    await record(pool, adminId, 'settings.sms_clear', 'sms');
    return publicConfig(null);
  }
  const typed = cleanInput(input);
  const next = {
    username: typed.username || saved?.username || '',
    header: input.header === undefined ? saved?.header || '' : typed.header,
    passwordEnc: typed.password ? seal(typed.password, LABEL) : saved?.passwordEnc,
    enabled: input.enabled === undefined ? saved?.enabled === true : input.enabled === true,
  };
  if (!next.username || !next.passwordEnc) throw fail(400, 'Verimor kullanıcı adı ve API şifresi birlikte girilmelidir.');
  await pool.query(
    `INSERT INTO han_saas.platform_settings(key, value, updated_by, updated_at) VALUES ('sms', $1::jsonb, $2, clock_timestamp())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(next), adminId],
  );
  await record(pool, adminId, 'settings.sms', next.enabled ? 'açık' : 'kapalı');
  return publicConfig(await readConfig(pool));
}

async function testSettings(pool, input, { fetcher } = {}) {
  const client = await clientFor(pool, input, { fetcher });
  const [balance, headers] = await Promise.all([client.balance(), client.headers()]);
  return { ok: true, balance, headers };
}

async function log(pool, entry) {
  await pool
    .query(
      `INSERT INTO han_saas.sms_log(tenant_id, purpose, dest_masked, status, provider_ref, error, segments)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.tenantId ?? null,
        entry.purpose,
        entry.dest,
        entry.status,
        entry.ref ?? null,
        entry.error ? String(entry.error).slice(0, 200) : null,
        entry.segments ?? 1,
      ],
    )
    .catch(() => console.error('SMS log write failed'));
}

// Sends one SMS through the platform account, logs it, and enforces the per-office daily cap.
async function sendSms(pool, { to, text, tenantId = null, purpose }, { fetcher, requireEnabled = true } = {}) {
  const config = await readConfig(pool);
  if (requireEnabled && !publicConfig(config).enabled) throw fail(412, 'Platform SMS hizmeti açık değil.');
  const dest = smsNumber(to);
  if (!dest) throw fail(400, 'Geçerli bir Türkiye cep telefonu gerekli.');
  if (tenantId) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM han_saas.sms_log
       WHERE tenant_id = $1 AND status = 'sent' AND created_at > CURRENT_TIMESTAMP - interval '1 day'`,
      [tenantId],
    );
    if (rows[0].n >= DAILY_LIMIT_PER_OFFICE) {
      await log(pool, { tenantId, purpose, dest: maskNumber(dest), status: 'blocked', error: 'daily limit' });
      throw fail(429, 'Bu büro için günlük SMS sınırına ulaşıldı.');
    }
  }
  const client = await clientFor(pool, {}, { fetcher });
  try {
    const result = await client.send({ to: dest, text });
    await log(pool, { tenantId, purpose, dest: maskNumber(dest), status: 'sent', ref: result.campaignId, segments: segments(text) });
    return { sent: true };
  } catch (error) {
    await log(pool, { tenantId, purpose, dest: maskNumber(dest), status: 'failed', error: error.code || error.message });
    throw error;
  }
}

// What one office's application gets: whether platform SMS is usable, and a sender bound to
// that office (for logging and the daily cap). Availability is cached briefly.
function createPlatformSms(pool, { tenantId = null, fetcher, cacheMs = 15000, now = Date.now } = {}) {
  let cached = null;
  return {
    async available() {
      if (cached && now() < cached.until) return cached.value;
      try {
        const value = publicConfig(await readConfig(pool)).enabled;
        cached = { value, until: now() + cacheMs };
        return value;
      } catch {
        return false; // recovery then falls back to "no channel", never to an unchecked send
      }
    },
    send({ to, text, purpose = 'password_recovery' }) {
      return sendSms(pool, { to, text, tenantId, purpose }, { fetcher });
    },
  };
}

module.exports = {
  getSettings,
  saveSettings,
  testSettings,
  sendSms,
  createPlatformSms,
  publicConfig,
  DAILY_LIMIT_PER_OFFICE,
};
