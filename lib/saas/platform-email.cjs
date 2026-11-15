const { createBrevoEmail, emailAddress, maskEmail, cleanName } = require('../brevo-email.cjs');
const { seal, open } = require('./totp.cjs');
const { record } = require('./platform-account.cjs');

// The selling company's own Brevo account, configured in the platform console (Yönetim →
// E-posta). Offices use it for account e-mails: "Şifremi unuttum" codes, e-mail address
// verification and a password a manager sends to a locked-out user. Messages go out from one
// platform address (noreply@hanhukuktakip.com by default) under each office's own name. The
// API key is sealed and never returned.

const LABEL = 'hanhukuk-platform-email-v1';
const DEFAULT_SENDER = 'noreply@hanhukuktakip.com';
const DEFAULT_NAME = 'Hukuk Takip Platformu';
// Brevo's free plan sends 300 e-mails a day for the whole platform: cap what one office can use.
const DAILY_LIMIT_PER_OFFICE = 60;
const PURPOSES = ['password_recovery', 'email_verification', 'password_delivery', 'test'];
const fail = (status, message) => Object.assign(new Error(message), { status });

async function readConfig(db) {
  const { rows } = await db.query("SELECT value, updated_at FROM han_saas.platform_settings WHERE key = 'email'");
  return rows.length ? { ...rows[0].value, updatedAt: rows[0].updated_at } : null;
}

function publicConfig(config) {
  const saved = !!config?.apiKeyEnc;
  return {
    configured: saved,
    enabled: saved && config.enabled === true,
    senderEmail: config?.senderEmail || DEFAULT_SENDER,
    senderName: config?.senderName || DEFAULT_NAME,
    updatedAt: config?.updatedAt || null,
  };
}

function cleanInput(input) {
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (apiKey.length > 200) throw fail(400, 'API anahtarı çok uzun.');
  if (/^xsmtpsib-/i.test(apiKey))
    throw fail(400, 'Bu bir SMTP anahtarı. Brevo → SMTP ve API → API anahtarları bölümündeki API anahtarını (xkeysib-…) girin.');
  const senderEmail = input.senderEmail === undefined ? undefined : emailAddress(input.senderEmail);
  if (input.senderEmail !== undefined && String(input.senderEmail).trim() && !senderEmail)
    throw fail(400, 'Geçerli bir gönderen e-posta adresi girin (ör. noreply@hanhukuktakip.com).');
  const senderName = input.senderName === undefined ? undefined : cleanName(input.senderName);
  return { apiKey, senderEmail, senderName };
}

// Client for the saved settings, or for values typed into the form (a blank key uses the saved
// one) so the operator can test before saving.
async function clientFor(db, input = {}, { fetcher } = {}) {
  const saved = await readConfig(db);
  const typed = cleanInput(input);
  const apiKey = typed.apiKey || (saved?.apiKeyEnc ? open(saved.apiKeyEnc, LABEL) : '');
  if (!apiKey) throw fail(412, 'Önce Brevo API anahtarını girin.');
  return {
    client: createBrevoEmail({ apiKey, fetcher }),
    senderEmail: typed.senderEmail || saved?.senderEmail || DEFAULT_SENDER,
    senderName: typed.senderName || saved?.senderName || DEFAULT_NAME,
  };
}

async function getSettings(pool) {
  const config = publicConfig(await readConfig(pool));
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'sent' AND created_at >= date_trunc('month', CURRENT_TIMESTAMP))::int AS month_sent,
            count(*) FILTER (WHERE status = 'sent' AND created_at > CURRENT_TIMESTAMP - interval '1 day')::int AS day_sent,
            count(*) FILTER (WHERE status = 'failed' AND created_at > CURRENT_TIMESTAMP - interval '30 days')::int AS failed30,
            count(*) FILTER (WHERE status = 'blocked' AND created_at > CURRENT_TIMESTAMP - interval '30 days')::int AS blocked30
     FROM han_saas.email_log`,
  );
  const recent = await pool.query(
    `SELECT l.id::text AS id, l.purpose, l.dest_masked AS dest, l.status, l.error, l.created_at AS "createdAt",
            t.name AS office
     FROM han_saas.email_log l LEFT JOIN han_saas.tenants t ON t.id = l.tenant_id
     ORDER BY l.id DESC LIMIT 50`,
  );
  const s = rows[0];
  return {
    ...config,
    usage: { monthSent: s.month_sent, daySent: s.day_sent, failed30: s.failed30, blocked30: s.blocked30 },
    recent: recent.rows,
    dailyLimitPerOffice: DAILY_LIMIT_PER_OFFICE,
  };
}

async function saveSettings(pool, adminId, input) {
  const saved = await readConfig(pool);
  if (input.clear === true) {
    await pool.query("DELETE FROM han_saas.platform_settings WHERE key = 'email'");
    await record(pool, adminId, 'settings.email_clear', 'email');
    return publicConfig(null);
  }
  const typed = cleanInput(input);
  const next = {
    apiKeyEnc: typed.apiKey ? seal(typed.apiKey, LABEL) : saved?.apiKeyEnc,
    senderEmail: typed.senderEmail || saved?.senderEmail || DEFAULT_SENDER,
    senderName: typed.senderName === undefined ? saved?.senderName || DEFAULT_NAME : typed.senderName || DEFAULT_NAME,
    enabled: input.enabled === undefined ? saved?.enabled === true : input.enabled === true,
  };
  if (!next.apiKeyEnc) throw fail(400, 'Brevo API anahtarını girin.');
  await pool.query(
    `INSERT INTO han_saas.platform_settings(key, value, updated_by, updated_at) VALUES ('email', $1::jsonb, $2, clock_timestamp())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(next), adminId],
  );
  await record(pool, adminId, 'settings.email', next.enabled ? 'açık' : 'kapalı');
  return publicConfig(await readConfig(pool));
}

// Checks the key, the remaining credits and whether the sender's domain is authenticated in
// Brevo (without it messages from noreply@… land in spam or are refused).
async function testSettings(pool, input, { fetcher } = {}) {
  const { client, senderEmail } = await clientFor(pool, input, { fetcher });
  const [account, domains] = await Promise.all([client.account(), client.domains()]);
  const domainName = senderEmail.split('@')[1];
  const domain = domains.find((item) => item.name === domainName) || null;
  return {
    ok: true,
    account: account.email,
    plan: account.plan,
    credits: account.credits,
    senderEmail,
    domain: domain ? { name: domain.name, authenticated: domain.authenticated, verified: domain.verified } : { name: domainName, missing: true },
  };
}

async function log(pool, entry) {
  await pool
    .query(
      `INSERT INTO han_saas.email_log(tenant_id, purpose, dest_masked, status, provider_ref, error)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.tenantId ?? null,
        entry.purpose,
        entry.dest || '—',
        entry.status,
        entry.ref ? String(entry.ref).slice(0, 200) : null,
        entry.error ? String(entry.error).slice(0, 200) : null,
      ],
    )
    .catch(() => console.error('E-mail log write failed'));
}

// Sends one e-mail through the platform account, logs it, and enforces the per-office daily cap.
// `fromName` is the office's name; the address is always the platform's sender.
async function sendEmail(
  pool,
  { to, toName, subject, html, text, tenantId = null, purpose, fromName },
  { fetcher, requireEnabled = true } = {},
) {
  if (!PURPOSES.includes(purpose)) throw fail(400, 'E-posta amacı geçersiz.');
  const config = await readConfig(pool);
  if (requireEnabled && !publicConfig(config).enabled) throw fail(412, 'Platform e-posta hizmeti açık değil.');
  const dest = emailAddress(to);
  if (!dest) throw fail(400, 'Geçerli bir e-posta adresi gerekli.');
  if (tenantId) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM han_saas.email_log
       WHERE tenant_id = $1 AND status = 'sent' AND created_at > CURRENT_TIMESTAMP - interval '1 day'`,
      [tenantId],
    );
    if (rows[0].n >= DAILY_LIMIT_PER_OFFICE) {
      await log(pool, { tenantId, purpose, dest: maskEmail(dest), status: 'blocked', error: 'daily limit' });
      throw fail(429, 'Bu büro için günlük e-posta sınırına ulaşıldı.');
    }
  }
  const { client, senderEmail, senderName } = await clientFor(pool, {}, { fetcher });
  try {
    const result = await client.send({
      sender: { email: senderEmail, name: cleanName(fromName) || senderName },
      to: dest,
      toName,
      subject,
      html,
      text,
      tags: [purpose],
    });
    await log(pool, { tenantId, purpose, dest: maskEmail(dest), status: 'sent', ref: result.messageId });
    return { sent: true };
  } catch (error) {
    await log(pool, { tenantId, purpose, dest: maskEmail(dest), status: 'failed', error: error.code || error.message });
    throw error;
  }
}

// What one office's application gets: whether platform e-mail is usable, and a sender bound to
// that office (for logging and the daily cap). Availability is cached briefly.
function createPlatformEmail(pool, { tenantId = null, fetcher, cacheMs = 15000, now = Date.now } = {}) {
  let cached = null;
  return {
    async available() {
      if (cached && now() < cached.until) return cached.value;
      try {
        const value = publicConfig(await readConfig(pool)).enabled;
        cached = { value, until: now() + cacheMs };
        return value;
      } catch {
        return false; // recovery then offers the other ways, never an unchecked send
      }
    },
    send({ to, toName, subject, html, text, purpose = 'password_recovery', fromName }) {
      return sendEmail(pool, { to, toName, subject, html, text, tenantId, purpose, fromName }, { fetcher });
    },
  };
}

module.exports = {
  getSettings,
  saveSettings,
  testSettings,
  sendEmail,
  createPlatformEmail,
  publicConfig,
  DAILY_LIMIT_PER_OFFICE,
  DEFAULT_SENDER,
};
