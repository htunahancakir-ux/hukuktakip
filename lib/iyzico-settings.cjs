const crypto = require('node:crypto');
const { KEY_PATTERN, createIyzico } = require('./iyzico.cjs');

// An office's own iyzico merchant credentials (Settings → Integrations → iyzico). The API key
// and secret are stored sealed with AES-256-GCM and are never returned to the browser; only
// whether they are saved and the last characters of the API key are shown.

const MODES = new Set(['sandbox', 'live']);

const bad = (message) => Object.assign(new Error(message), { status: 400 });
function credentialKey() {
  const raw = process.env.IYZICO_ENCRYPTION_KEY || process.env.AI_ENCRYPTION_KEY || process.env.BACKUP_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(raw))
    throw Object.assign(new Error('iyzico anahtarlarını saklamak için sunucu şifreleme anahtarı tanımlı değil.'), { status: 503 });
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(raw, 'hex'), Buffer.alloc(0), 'hanhukuk-iyzico-settings-v1', 32));
}
function seal(value) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', credentialKey(), nonce);
  return Buffer.concat([nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
function open(value) {
  const bytes = Buffer.from(String(value || ''), 'base64');
  if (bytes.length < 29) throw Object.assign(new Error('Kayıtlı iyzico anahtarı okunamadı.'), { status: 503 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', credentialKey(), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  try {
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
  } catch {
    throw Object.assign(new Error('Kayıtlı iyzico anahtarı okunamadı.'), { status: 503 });
  }
}
const cleanMode = (value) => (MODES.has(value) ? value : 'sandbox');

function publicConfig(config) {
  const saved = !!(config?.apiKeyEnc && config?.secretKeyEnc);
  return {
    configured: saved,
    mode: cleanMode(config?.mode),
    apiKeyHint: saved ? config.apiKeyHint || '' : '',
    updatedAt: config?.updatedAt || null,
  };
}

// Merges a form submission into the stored config. A blank key keeps the saved one, so the
// form can change the mode without retyping secrets; `clear` removes everything.
function configure(previous, input = {}) {
  if (input.clear === true) return undefined;
  const mode = input.mode === undefined ? cleanMode(previous?.mode) : input.mode;
  if (!MODES.has(mode)) throw bad('Ortam "deneme" veya "canlı" olmalıdır.');
  const next = { mode, apiKeyEnc: previous?.apiKeyEnc, secretKeyEnc: previous?.secretKeyEnc, apiKeyHint: previous?.apiKeyHint };
  for (const [field, target, label] of [['apiKey', 'apiKeyEnc', 'API anahtarı'], ['secretKey', 'secretKeyEnc', 'Gizli anahtar']]) {
    const value = typeof input[field] === 'string' ? input[field].trim() : '';
    if (!value) continue;
    if (!KEY_PATTERN.test(value)) throw bad(`${label} geçersiz.`);
    next[target] = seal(value);
    if (field === 'apiKey') next.apiKeyHint = '…' + value.slice(-4);
  }
  if (!next.apiKeyEnc || !next.secretKeyEnc) throw bad('API anahtarı ve gizli anahtar birlikte girilmelidir.');
  return { ...next, updatedAt: new Date().toISOString() };
}

// A client from the saved credentials, or from the ones typed in the form (to test before saving).
function clientFor(config, input = {}, { fetcher } = {}) {
  const typedKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const typedSecret = typeof input.secretKey === 'string' ? input.secretKey.trim() : '';
  const mode = input.mode === undefined ? cleanMode(config?.mode) : input.mode;
  if (!MODES.has(mode)) throw bad('Ortam "deneme" veya "canlı" olmalıdır.');
  const apiKey = typedKey || (config?.apiKeyEnc ? open(config.apiKeyEnc) : '');
  const secretKey = typedSecret || (config?.secretKeyEnc ? open(config.secretKeyEnc) : '');
  if (!apiKey || !secretKey) throw bad('Önce iyzico API anahtarı ve gizli anahtarı girin.');
  if (!KEY_PATTERN.test(apiKey) || !KEY_PATTERN.test(secretKey)) throw bad('iyzico anahtarları geçersiz.');
  return createIyzico({ apiKey, secretKey, baseUrl: mode, ...(fetcher ? { fetcher } : {}) });
}

module.exports = { publicConfig, configure, clientFor, MODES };
