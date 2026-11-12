const crypto = require('node:crypto');
const { profile } = require('./account-contact.cjs');
const { smsNumber } = require('./verimor-sms.cjs');

// One-time temporary passwords sent by SMS for "Şifremi unuttum". The code is 8 digits, valid
// for 15 minutes, usable once, and dies after 5 wrong tries or when the password changes. Only
// a salted hash is stored in the office state (`smsRecovery`).

const DAY = 86400000;
const TTL_MS = 15 * 60000;
const MAX_ATTEMPTS = 5;
// SMS costs the platform money: cap requests per account.
const LIMITS = Object.freeze([
  { days: 1, max: 3 },
  { days: 7, max: 6 },
  { days: 30, max: 12 },
]);

const digest = (salt, code) => crypto.createHash('sha256').update(salt + ':' + code).digest('hex');
const fingerprint = (user) => crypto.createHash('sha256').update(String(user.hash || '')).digest('hex');

// The registered mobile number of an account (personnel record first), as 90 5xx xxx xx xx.
const smsPhone = (state, user) => smsNumber(profile({ ...state, data: state.data || {} }, user).mobilePhone);

// `force`: an operator-triggered reset still counts toward the limits but is not refused by them.
function issueCode(state, user, { now = Date.now(), force = false } = {}) {
  const rows = (state.smsRecovery || []).filter((row) => row.at > now - 30 * DAY);
  const used = rows.filter((row) => row.userId === user.id);
  if (!force && LIMITS.some(({ days, max }) => used.filter((row) => row.at > now - days * DAY).length >= max))
    return null;
  for (const row of used) if (row.expires > now) row.expires = now;
  const code = String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
  const salt = crypto.randomBytes(16).toString('hex');
  rows.push({
    userId: user.id,
    at: now,
    expires: now + TTL_MS,
    salt,
    hash: digest(salt, code),
    fingerprint: fingerprint(user),
    attempts: 0,
  });
  state.smsRecovery = rows;
  return code;
}

// Returns { ok, changed }. A wrong code counts against the live code; the caller must persist
// the state when `changed` is true so the count survives.
function checkCode(state, user, code, { now = Date.now() } = {}) {
  const row = (state.smsRecovery || []).find(
    (item) =>
      item.userId === user.id && item.expires > now && item.attempts < MAX_ATTEMPTS && item.fingerprint === fingerprint(user),
  );
  if (!row) return { ok: false, changed: false };
  const supplied = String(code ?? '').replace(/\s/g, '');
  const matches =
    /^\d{8}$/.test(supplied) &&
    crypto.timingSafeEqual(Buffer.from(digest(row.salt, supplied), 'hex'), Buffer.from(row.hash, 'hex'));
  if (!matches) {
    row.attempts++;
    if (row.attempts >= MAX_ATTEMPTS) row.expires = now;
    return { ok: false, changed: true };
  }
  row.expires = now;
  return { ok: true, changed: true };
}

// Plain ASCII keeps the message in one SMS segment.
const message = (code) =>
  `Gecici sifreniz: ${code}. 15 dk gecerli, tek kullanimlik. Giris ekraninda "Sifremi unuttum" bolumunde yeni sifrenizi belirleyin. Talep sizin degilse dikkate almayin.`;

module.exports = { issueCode, checkCode, smsPhone, message, LIMITS, TTL_MS, MAX_ATTEMPTS };
