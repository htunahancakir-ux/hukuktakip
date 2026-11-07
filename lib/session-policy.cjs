const crypto = require('node:crypto');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

function sessionKey(req) {
  const matches = String(req.headers.cookie || '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith('han_session='));
  // Reject ambiguous duplicate cookies instead of authenticating an arbitrary one.
  if (matches.length !== 1) return '';
  const token = matches[0].slice(12);
  return /^[a-f0-9]{64}$/.test(token) ? digest(token) : '';
}

function sessionCookie(token, { secure = false, maxAge } = {}) {
  if (token !== '' && !/^[a-f0-9]{64}$/.test(token)) throw new TypeError('Invalid session token');
  const attributes = ['han_session=' + token, 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/'];
  // Plain HTTP localhost is the only application mode that omits Secure.
  if (!secure) attributes.splice(2, 1);
  if (maxAge !== undefined) {
    if (!Number.isSafeInteger(maxAge) || maxAge < 0) throw new TypeError('Invalid cookie lifetime');
    attributes.push('Max-Age=' + maxAge);
    if (maxAge === 0) attributes.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  // No Domain attribute: the browser must not share this cookie with subdomains.
  return attributes.join('; ');
}
function attemptKey(req, secureCookies) {
  return digest(
    String(
      secureCookies
        ? req.headers['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'unknown'
        : req.socket?.remoteAddress || 'unknown',
    ),
  );
}
function requestDeviceType(req) {
  const { headers } = req;
  return headers['sec-ch-ua-mobile'] === '?1' ||
    ['"Android"', '"iOS"'].includes(headers['sec-ch-ua-platform']) ||
    /\b(?:Android|iPhone|iPad|iPod|Mobile)\b/i.test(headers['user-agent'] || '')
    ? 'mobile'
    : 'desktop';
}
function sessionIsValid(session, now = Date.now()) {
  return (
    ['desktop', 'mobile'].includes(session?.deviceType) &&
    Number.isFinite(session.until) &&
    session.until > now
  );
}
module.exports = { sessionKey, sessionCookie, attemptKey, requestDeviceType, sessionIsValid };
