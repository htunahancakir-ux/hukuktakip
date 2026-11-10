const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const PIN_PATTERN = /^[0-9]{4}$/;
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
const PROOF_MS = 60 * 60 * 1000;
function browserProof(req) {
  const matches = String(req.headers.cookie || '')
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith('han_pin='));
  return matches.length === 1 ? matches[0].slice(8) : '';
}

async function createPin(pin) {
  if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) throw new Error('PIN dört rakamdan oluşmalıdır.');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(pin, salt, 64)).toString('hex');
  return { salt, hash, failures: 0, lockedUntil: 0 };
}

async function checkPin(pin, record, now = Date.now()) {
  if (!record || !/^[a-f0-9]{32}$/i.test(record.salt || '') || !/^[a-f0-9]{128}$/i.test(record.hash || ''))
    throw new Error('PIN yapılandırması bulunamadı.');
  if (Number(record.lockedUntil || 0) > now)
    return { ok: false, lockedUntil: record.lockedUntil, record: { ...record } };
  const candidate = typeof pin === 'string' && PIN_PATTERN.test(pin) ? pin : '----';
  const derived = await scrypt(candidate, record.salt, 64);
  const valid = crypto.timingSafeEqual(derived, Buffer.from(record.hash, 'hex')) && candidate === pin;
  if (valid) return { ok: true, record: { ...record, failures: 0, lockedUntil: 0 } };
  const failures = Math.max(0, Number(record.failures || 0)) + 1;
  const locked = failures >= MAX_ATTEMPTS;
  const next = { ...record, failures: locked ? 0 : failures, lockedUntil: locked ? now + LOCK_MS : 0 };
  return { ok: false, lockedUntil: next.lockedUntil, record: next };
}

const scopes = ['integrations', 'permissions', 'delete'];
function scopeFor(url, method) {
  const p = url.pathname;
  if (p === '/api/operations/delete') return 'delete';
  if (
    [
      '/api/users',
      '/api/users/contact',
      '/api/users/password',
      '/api/personnel-save',
      '/api/voip/permissions',
      '/api/password-reset/send',
    ].includes(p)
  )
    return 'permissions';
  if (
    [
      '/api/ai/config',
      '/api/ai/test',
      '/api/whatsapp/config',
      '/api/whatsapp/settings',
      '/api/voip/config',
      '/api/voip/test',
    ].includes(p)
  )
    return 'integrations';
  return null;
}
function issueProof(record, session, scope, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ session, scope: '*', until: now + PROOF_MS })).toString(
    'base64url',
  );
  return payload + '.' + crypto.createHmac('sha256', record.proofKey).update(payload).digest('base64url');
}
function proofValid(record, proof, session, scope, now = Date.now()) {
  if (!record?.proofKey || typeof proof !== 'string' || proof.length > 2000) return false;
  const [payload, signature, extra] = proof.split('.');
  if (!payload || !signature || extra) return false;
  const expected = crypto.createHmac('sha256', record.proofKey).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url'));
    return (
      value.session === session &&
      value.scope === '*' &&
      Number.isSafeInteger(value.until) &&
      value.until > now &&
      value.until <= now + PROOF_MS
    );
  } catch {
    return false;
  }
}
module.exports = {
  createPin,
  checkPin,
  MAX_ATTEMPTS,
  LOCK_MS,
  PROOF_MS,
  browserProof,
  scopes,
  scopeFor,
  issueProof,
  proofValid,
};
