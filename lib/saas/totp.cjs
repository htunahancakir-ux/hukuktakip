const crypto = require('node:crypto');

// RFC 6238 time-based one-time passwords (HMAC-SHA1, 6 digits, 30 s), the profile every
// authenticator app supports. The shared secret is sealed with AES-256-GCM before it is
// stored; nothing here talks to the database.

const STEP_SECONDS = 30;
const DIGITS = 6;
const SKEW_STEPS = 1; // accept the previous and next 30 s window for clock drift
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(text) {
  const clean = String(text || '')
    .toUpperCase()
    .replace(/[\s=-]/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('Invalid base32');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

const newSecret = () => base32(crypto.randomBytes(20));

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', fromBase32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const binary =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

const stepAt = (now) => Math.floor(now / 1000 / STEP_SECONDS);

// Returns the matching time step, or null. The caller stores the step and refuses any step
// it has already accepted, so one code can never sign in twice.
function matchStep(secret, code, now = Date.now()) {
  const supplied = String(code || '').trim();
  if (!/^\d{6}$/.test(supplied)) return null;
  const current = stepAt(now);
  let found = null;
  for (let step = current - SKEW_STEPS; step <= current + SKEW_STEPS; step++) {
    const expected = codeAt(secret, step);
    // Compare every window so timing does not reveal which one matched.
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)) && found === null) found = step;
  }
  return found;
}

function otpauthUri(secret, account, issuer = 'Hukuk Takip Platformu') {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(account);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// Eight single-use recovery codes for a lost phone. Only their hashes are stored.
function newRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () => {
    const raw = base32(crypto.randomBytes(7)).slice(0, 10);
    return raw.slice(0, 5) + '-' + raw.slice(5);
  });
}
const normalizeRecovery = (code) => String(code || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
const recoveryHash = (code) => crypto.createHash('sha256').update('recovery:' + normalizeRecovery(code)).digest('hex');
const looksLikeRecovery = (code) => normalizeRecovery(code).length === 10;

// Platform secrets (TOTP secrets, the platform SMS password) are sealed with a key derived per
// purpose from one server key, so a value sealed for one purpose cannot be opened as another.
function sealingKey(label = 'hanhukuk-platform-totp-v1') {
  const raw =
    process.env.PLATFORM_ENCRYPTION_KEY || process.env.AI_ENCRYPTION_KEY || process.env.BACKUP_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(raw))
    throw Object.assign(
      new Error('Sunucuda platform şifreleme anahtarı (PLATFORM_ENCRYPTION_KEY) tanımlı değil.'),
      { status: 412 },
    );
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(raw, 'hex'), Buffer.alloc(0), label, 32),
  );
}
function seal(value, label) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sealingKey(label), nonce);
  return Buffer.concat([nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
function open(value, label) {
  const bytes = Buffer.from(String(value || ''), 'base64');
  const unreadable = () =>
    Object.assign(new Error('İki aşamalı doğrulama anahtarı okunamadı.'), { status: 503 });
  if (bytes.length < 29) throw unreadable();
  const decipher = crypto.createDecipheriv('aes-256-gcm', sealingKey(label), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  try {
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
  } catch {
    throw unreadable();
  }
}

module.exports = {
  newSecret,
  codeAt,
  stepAt,
  matchStep,
  otpauthUri,
  newRecoveryCodes,
  recoveryHash,
  looksLikeRecovery,
  seal,
  open,
  base32,
  fromBase32,
  STEP_SECONDS,
};
