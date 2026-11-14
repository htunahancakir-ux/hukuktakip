const codes = require('./sms-recovery.cjs');
const { profile } = require('./account-contact.cjs');

const email = (value) =>
  typeof value === 'string' &&
  value.length <= 254 &&
  /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value.trim())
    ? value.trim().toLowerCase()
    : '';
const contactEmail = (state, user) => email(profile(state, user).email);
// Enrollment is independent of personnel/contact edits by another administrator.
const addressFor = (state, user) =>
  user && email(user.recoveryEmail) === contactEmail(state, user) ? email(user.recoveryEmail) : '';
function withCodes(state, user, address, kind, operation) {
  const box = { smsRecovery: (state.emailRecovery || []).filter((r) => r.kind === kind) };
  const bound = { ...user, hash: user.hash + ':' + address };
  const result = operation(box, bound);
  state.emailRecovery = [
    ...(state.emailRecovery || []).filter((r) => r.kind !== kind),
    ...box.smsRecovery.map((r) => ({ ...r, kind })),
  ];
  return result;
}
function queue(res, to, code, enrollment) {
  res.hanEmail = {
    to,
    subject: enrollment ? 'Şifre kurtarma e-postanızı doğrulayın' : 'HAN Hukuk · Şifre sıfırlama kodunuz',
    text: `${enrollment ? 'E-posta doğrulama' : 'Şifre sıfırlama'} kodunuz: ${code}\n\nKod 15 dakika geçerlidir ve yalnızca bir kez kullanılabilir. Talep size ait değilse bu e-postayı dikkate almayın.`,
  };
}
async function handleEmailRecovery(ctx) {
  const { req, res, url, send, fail } = ctx;
  const path = url.pathname;
  const enrollment = path === '/api/account/recovery-email';
  if (
    !enrollment &&
    !['/api/password-reset/email-request', '/api/password-reset/email-complete'].includes(path)
  )
    return false;
  if (enrollment && !ctx.u) throw fail(401, 'Giriş yapın.');
  if (enrollment && req.method === 'GET') {
    send(res, 200, { available: !!ctx.options.emailAvailable, verified: !!addressFor(ctx.state, ctx.u) });
    return true;
  }
  if (req.method !== 'POST') throw fail(405, 'İşlem desteklenmiyor.');
  if (!ctx.options.emailAvailable) throw fail(503, 'E-posta gönderimi henüz etkin değil.');
  // PostgreSQL uses the persistent per-IP limiter. Local mode keeps its own limiter.
  if (!ctx.options.rateChecked) {
    const key = 'email-recovery:' + path + ':' + String(req.socket?.remoteAddress || 'unknown');
    const now = Date.now();
    const previous = ctx.attempts.get(key);
    const rate = previous?.until > now ? previous : { count: 0, until: now + 900000 };
    if (++rate.count > 8) throw fail(429, 'Çok fazla deneme yapıldı. Daha sonra tekrar deneyin.');
    ctx.attempts.set(key, rate);
  }
  const input = await ctx.body(req);
  const account = typeof input.account === 'string' ? input.account.trim() : '';
  if (!enrollment && (!account || account.length > 254)) throw fail(400, 'E-posta veya kullanıcı adı girin.');
  const matches = enrollment
    ? [ctx.u]
    : ctx.state.users.filter(
        (u) =>
          ctx.userEnabled(u) &&
          !u.platformSupport &&
          (u.username === account.toLocaleLowerCase('tr') ||
            (email(account) && addressFor(ctx.state, u) === email(account))),
      );
  const user = matches.length === 1 ? matches[0] : null;
  const address = user && (enrollment ? contactEmail(ctx.state, user) : addressFor(ctx.state, user));
  const next = structuredClone(ctx.state);
  const target = user && next.users.find((u) => u.id === user.id);
  const kind = enrollment ? 'enroll' : 'reset';
  if (enrollment && !input.code) {
    if (!(await ctx.passwordOK(input.password, user))) throw fail(403, 'Mevcut şifrenizi doğrulayın.');
    if (!address) throw fail(400, 'Önce iletişim bilgilerinizde geçerli bir e-posta kaydedin.');
  }
  if (enrollment ? !input.code : path.endsWith('email-request')) {
    if (address) {
      const code = withCodes(next, target, address, kind, (s, u) => codes.issueCode(s, u));
      if (code) {
        ctx.persist(next);
        queue(res, address, code, enrollment);
      }
    }
    send(res, 200, { ok: true }); // Identical for unknown, unverified and rate-limited accounts.
    return true;
  }
  if (
    !enrollment &&
    (typeof input.password !== 'string' || input.password.length < 10 || input.password.length > 128)
  )
    throw fail(400, 'Yeni şifre 10–128 karakter olmalı.');
  const checked = address
    ? withCodes(next, target, address, kind, (s, u) => codes.checkCode(s, u, input.code))
    : { ok: false };
  if (!checked.ok) {
    if (checked.changed) ctx.persist(next);
    send(res, 200, { ok: false, error: 'Kod hatalı veya süresi dolmuş. Yeni kod isteyin.' });
    return true;
  }
  if (enrollment) target.recoveryEmail = address;
  else {
    target.salt = ctx.crypto.randomBytes(16).toString('hex');
    target.hash = await ctx.hash(input.password, target.salt);
    ctx.invalidate(target.id);
    res.hanAuditActor = { id: target.id, name: target.name, username: target.username };
  }
  ctx.persist(next);
  send(res, 200, { ok: true, ...(enrollment ? { verified: true } : { username: target.username }) });
  return true;
}
function fromEnv(env = process.env) {
  if (!env.BREVO_SMTP_LOGIN || !env.BREVO_SMTP_KEY) return null;
  const from = email(env.BREVO_FROM_EMAIL);
  if (!from) throw new Error('BREVO_FROM_EMAIL must be a valid sender address');
  const transport = require('nodemailer').createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: env.BREVO_SMTP_LOGIN, pass: env.BREVO_SMTP_KEY },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    verify: () => transport.verify(),
    send: (job) =>
      transport.sendMail({
        from: { name: 'HAN Hukuk Takip', address: from },
        to: { address: job.to },
        subject: job.subject,
        text: job.text,
        headers: { 'X-Mailin-Track-Clicks': '0', 'X-Mailin-Track-Opens': '0' },
      }),
  };
}
module.exports = { handleEmailRecovery, fromEnv, email, addressFor };
