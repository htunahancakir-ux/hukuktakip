const crypto = require('node:crypto');
const { profile } = require('./account-contact.cjs');
const { emailAddress } = require('./brevo-email.cjs');

// E-mail codes of an account, kept hashed in the office state (`emailRecovery`):
//
//   verify  6 digits, 24 hours: proves the account's e-mail address belongs to its user. It is
//           entered inside a signed-in session (Hesabım, or a manager for a staff account),
//           never on the sign-in screen. A verified address carries a tick on the personnel
//           screens and may receive "Şifremi unuttum" codes. A changed address is no longer
//           verified.
//   reset   8 digits, 15 minutes: a one-time password for "Şifremi unuttum", sent only to a
//           verified address. It dies when the password changes.
//
// Every code is usable once and dies after 5 wrong tries.

const DAY = 86400000;
const KINDS = Object.freeze({
  verify: { digits: 6, ttl: DAY, limits: [{ days: 1, max: 5 }, { days: 7, max: 12 }] },
  reset: {
    digits: 8,
    ttl: 15 * 60000,
    limits: [
      { days: 1, max: 3 },
      { days: 7, max: 6 },
      { days: 30, max: 12 },
    ],
  },
});
const MAX_ATTEMPTS = 5;

const digest = (salt, code) =>
  crypto
    .createHash('sha256')
    .update(salt + ':' + code)
    .digest('hex');
const fingerprint = (user) =>
  crypto
    .createHash('sha256')
    .update(String(user.hash || ''))
    .digest('hex');

// The account's e-mail address (personnel record first), lower-cased, or ''.
const accountEmail = (state, user) => emailAddress(profile({ ...state, data: state.data || {} }, user).email);
const isVerified = (state, user) =>
  !!user && profile({ ...state, data: state.data || {} }, user).emailVerified === true;

// Returns the new code, or null when the account reached its limit for this kind of code.
// `force`: a manager's request still counts toward the limits but is not refused by them.
function issueCode(state, user, kind, { now = Date.now(), force = false } = {}) {
  const spec = KINDS[kind];
  const address = accountEmail(state, user);
  if (!spec || !address) return null;
  const rows = (state.emailRecovery || []).filter((row) => row.at > now - 30 * DAY);
  const used = rows.filter((row) => row.userId === user.id && row.kind === kind);
  if (!force && spec.limits.some(({ days, max }) => used.filter((row) => row.at > now - days * DAY).length >= max))
    return null;
  for (const row of used) if (row.expires > now) row.expires = now;
  const code = String(crypto.randomInt(0, 10 ** spec.digits)).padStart(spec.digits, '0');
  const salt = crypto.randomBytes(16).toString('hex');
  rows.push({
    userId: user.id,
    kind,
    address,
    at: now,
    expires: now + spec.ttl,
    salt,
    hash: digest(salt, code),
    ...(kind === 'reset' && { fingerprint: fingerprint(user) }),
    attempts: 0,
  });
  state.emailRecovery = rows;
  return code;
}

// When a code of this kind was last sent to the account's current address (ms), or 0. A code
// sent to an earlier address does not count.
function lastIssued(state, user, kind) {
  const address = accountEmail(state, user);
  return Math.max(
    0,
    ...(state.emailRecovery || [])
      .filter((row) => row.userId === user.id && row.kind === kind && row.address === address)
      .map((row) => row.at),
  );
}

// Checks a code against the account's live code of the kind its length names (6 digits: verify,
// 8: reset). Returns { ok, kind, changed }; the caller persists the state when `changed` so a
// wrong-attempt count survives. A correct verify code marks the address verified.
function checkCode(state, user, code, { kinds = ['verify', 'reset'], now = Date.now() } = {}) {
  const supplied = String(code ?? '').replace(/\s/g, '');
  const kind = kinds.find((name) => new RegExp(`^\\d{${KINDS[name].digits}}$`).test(supplied));
  if (!kind) return { ok: false, kind: null, changed: false };
  const address = accountEmail(state, user);
  const row = (state.emailRecovery || []).find(
    (item) =>
      item.userId === user.id &&
      item.kind === kind &&
      item.expires > now &&
      item.attempts < MAX_ATTEMPTS &&
      item.address === address &&
      (kind !== 'reset' || item.fingerprint === fingerprint(user)),
  );
  if (!row) return { ok: false, kind, changed: false };
  const matches = crypto.timingSafeEqual(
    Buffer.from(digest(row.salt, supplied), 'hex'),
    Buffer.from(row.hash, 'hex'),
  );
  if (!matches) {
    row.attempts++;
    if (row.attempts >= MAX_ATTEMPTS) row.expires = now;
    return { ok: false, kind, changed: true };
  }
  row.expires = now;
  if (kind === 'verify') user.emailVerified = { address, at: new Date(now).toISOString() };
  return { ok: true, kind, changed: true };
}

const html = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// A plain, readable message: the office's name on top, one code in large type, a short note.
function layout({ office, heading, lines, code, footer }) {
  const text = [office, '', heading, '', ...lines, ...(code ? ['', code, ''] : ['']), footer].join('\n');
  const body = `<!doctype html><html lang="tr"><body style="margin:0;padding:24px;background:#f4f4f2;font-family:Arial,Helvetica,sans-serif;color:#1d2433">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e3e3df;border-radius:8px">
<tr><td style="padding:20px 24px;border-bottom:1px solid #e3e3df;font-size:15px;font-weight:bold">${html(office)}</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 12px;font-size:20px">${html(heading)}</h1>
${lines.map((line) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5">${html(line)}</p>`).join('')}
${code ? `<p style="margin:20px 0;font-size:32px;font-weight:bold;letter-spacing:6px;font-family:Consolas,Menlo,monospace">${html(code)}</p>` : ''}
<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:#5b6270">${html(footer)}</p>
</td></tr></table>
<p style="font-size:12px;color:#8a909b">Bu e-posta otomatik gönderilmiştir; yanıtlamayın.</p>
</td></tr></table></body></html>`;
  return { text, html: body };
}

function verifyMessage({ office, code }) {
  return {
    subject: `${office} — E-posta doğrulama kodu`,
    ...layout({
      office,
      heading: 'E-posta adresinizi doğrulayın',
      lines: [
        'Hesabınızdaki e-posta adresini doğrulamak için aşağıdaki 6 haneli kodu uygulamada Hesabım → İletişim bilgilerim bölümüne girin.',
        'Doğrulanan adrese ileride “Şifremi unuttum” kodu gönderilebilir.',
      ],
      code,
      footer: 'Kod 24 saat geçerlidir ve bir kez kullanılır. Bu isteği siz yapmadıysanız bu e-postayı dikkate almayın.',
    }),
  };
}

function resetMessage({ office, code }) {
  return {
    subject: `${office} — Şifre yenileme kodu`,
    ...layout({
      office,
      heading: 'Şifre yenileme kodunuz',
      lines: ['“Şifremi unuttum” ekranında bu 8 haneli kodu girin ve yeni şifrenizi belirleyin.'],
      code,
      footer: 'Kod 15 dakika geçerlidir ve bir kez kullanılır. Talep sizin değilse bu e-postayı dikkate almayın; şifreniz değişmez.',
    }),
  };
}

// A password a manager set for a locked-out user ("Yöneticiden iste").
function passwordMessage({ office, username, password, manager }) {
  return {
    subject: `${office} — Yeni şifreniz`,
    ...layout({
      office,
      heading: 'Şifreniz yenilendi',
      lines: [
        `${manager || 'Yöneticiniz'} talebiniz üzerine hesabınıza yeni bir şifre belirledi.`,
        `Kullanıcı adınız: ${username}`,
        'Yeni şifreniz aşağıdadır. Giriş yaptıktan sonra Hesabım bölümünden kendi şifrenizle değiştirin.',
      ],
      code: password,
      footer: 'Bu talebi siz yapmadıysanız hemen büro yönetiminize haber verin.',
    }),
  };
}

module.exports = {
  accountEmail,
  isVerified,
  issueCode,
  checkCode,
  lastIssued,
  verifyMessage,
  resetMessage,
  passwordMessage,
  KINDS,
  MAX_ATTEMPTS,
};
