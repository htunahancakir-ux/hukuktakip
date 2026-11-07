const crypto = require('node:crypto');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

function sessionKey(req) {
  const token = String(req.headers.cookie || '')
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith('han_session='))
    ?.slice(12);
  return token ? digest(token) : '';
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
module.exports = { sessionKey, attemptKey, requestDeviceType, sessionIsValid };
