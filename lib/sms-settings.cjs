const crypto = require('node:crypto');
const { createVerimorSms } = require('./verimor-sms.cjs');

// The office's own Verimor SMS account (Settings → Integrations → SMS). Used for critical
// messages such as "Şifremi unuttum" when the office has no WhatsApp integration. The API
// password is stored sealed with AES-256-GCM and never returned to the browser.

const fail = (status, message) => Object.assign(new Error(message), { status });

function sealingKey() {
  const raw =
    process.env.SMS_ENCRYPTION_KEY ||
    process.env.AI_ENCRYPTION_KEY ||
    process.env.BACKUP_ENCRYPTION_KEY ||
    '';
  if (!/^[a-f0-9]{64}$/i.test(raw))
    throw fail(503, 'SMS şifresini saklamak için sunucu şifreleme anahtarı tanımlı değil.');
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(raw, 'hex'), Buffer.alloc(0), 'hanhukuk-sms-settings-v1', 32),
  );
}
function seal(value) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sealingKey(), nonce);
  return Buffer.concat([nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString(
    'base64',
  );
}
function open(value) {
  const bytes = Buffer.from(String(value || ''), 'base64');
  const unreadable = () => fail(503, 'Kayıtlı SMS şifresi okunamadı.');
  if (bytes.length < 29) throw unreadable();
  const decipher = crypto.createDecipheriv('aes-256-gcm', sealingKey(), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  try {
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
  } catch {
    throw unreadable();
  }
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

function clean(input) {
  const username = String(input.username ?? '').trim();
  const header = String(input.header ?? '').trim();
  const password = typeof input.password === 'string' ? input.password.trim() : '';
  if (username && !/^\d{10,15}$/.test(username))
    throw fail(400, 'Verimor kullanıcı adı hesap numaranızdır (ör. 908501234567).');
  if (header.length > 20) throw fail(400, 'SMS başlığı en fazla 20 karakter olabilir.');
  if (password.length > 200) throw fail(400, 'API şifresi çok uzun.');
  return { username, header, password };
}

// Merges a form submission into the saved settings. A blank password keeps the saved one;
// `clear` removes everything.
function configure(previous, input = {}) {
  if (input.clear === true) return undefined;
  const typed = clean(input);
  const next = {
    username: typed.username || previous?.username || '',
    header: input.header === undefined ? previous?.header || '' : typed.header,
    passwordEnc: typed.password ? seal(typed.password) : previous?.passwordEnc,
    enabled: input.enabled === undefined ? previous?.enabled === true : input.enabled === true,
  };
  if (!next.username || !next.passwordEnc)
    throw fail(400, 'Verimor kullanıcı adı ve API şifresi birlikte girilmelidir.');
  return { ...next, updatedAt: new Date().toISOString() };
}

// A client for the saved settings, or for values typed into the form (blank password = saved).
function clientFor(config, input = {}, { fetcher } = {}) {
  const typed = clean(input);
  const username = typed.username || config?.username;
  const password = typed.password || (config?.passwordEnc ? open(config.passwordEnc) : '');
  if (!username || !password) throw fail(412, 'Önce Verimor kullanıcı adı ve API şifresini girin.');
  return createVerimorSms({ username, password, header: typed.header || config?.header || '', fetcher });
}

module.exports = { publicConfig, configure, clientFor };
