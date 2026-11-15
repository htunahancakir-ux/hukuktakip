const wa = require('../../lib/whatsapp.cjs');
const smsRecovery = require('../../lib/sms-recovery.cjs');
const smsSettings = require('../../lib/sms-settings.cjs');
const emailRecovery = require('../../lib/email-recovery.cjs');
const channels = require('../../lib/recovery-channels.cjs');
const { emailAddress, maskEmail } = require('../../lib/brevo-email.cjs');
const { smsNumber } = require('../../lib/verimor-sms.cjs');
const { profile } = require('../../lib/account-contact.cjs');
const { officeIdentity } = require('../../lib/office-identity.cjs');
const { throttle, requestReset } = require('./access-whatsapp.cjs');

// "Şifremi unuttum" over every open channel (WhatsApp link, SMS code, e-mail code), e-mail
// address verification, and the last resort "Yöneticiden iste": the request lands in the
// managers' inbox, and a manager sets a new password and passes it on.

const DAY = 86400000;
const MANAGERS = ['ceo', 'admin'];
// A help request nobody answered stops blocking a new one after three days.
const HELP_OPEN_MS = 3 * DAY;
const HELP_PER_DAY = 3;
const CODE_ERROR = 'Kod hatalı veya süresi dolmuş. Yeni kod isteyin.';

const PUBLIC_ROUTES = Object.freeze([
  '/api/password-reset/channels',
  '/api/password-reset/request',
  '/api/password-reset/sms-complete',
  '/api/password-reset/email-complete',
  '/api/password-reset/ask-manager',
]);

const officeName = (ctx) => officeIdentity(ctx.state, ctx.options).name;
const openChannels = (ctx) =>
  channels.channelOrder(ctx.state, channels.availableChannels(ctx.state, ctx.options));
const officeSmsOn = (state) => smsSettings.publicConfig(state.smsConfig).enabled;

// E-mail goes out after the request committed (lib/application.cjs → finalizeEmail).
function queueEmail(res, job, { silent }) {
  res.hanEmail = { jobs: [...(res.hanEmail?.jobs || []), job], silent };
}

// The one enabled account whose username, registered mobile, WhatsApp number or verified
// e-mail address is `input`, or null when none or several match. `anyEmail` also accepts an
// unverified address (only for "Yöneticiden iste", which sends nothing to that address).
function findAccount(ctx, input, { anyEmail = false } = {}) {
  const text = String(input || '').trim();
  const username = text.toLocaleLowerCase('tr');
  const email = emailAddress(text);
  const phone = !email && smsNumber(text);
  const waPhone = !email && wa.normalizePhone(text);
  const matches = ctx.state.users.filter(
    (user) =>
      ctx.userEnabled(user) &&
      !user.platformSupport &&
      (user.username === username ||
        (email &&
          emailRecovery.accountEmail(ctx.state, user) === email &&
          (anyEmail || emailRecovery.isVerified(ctx.state, user))) ||
        (phone && smsRecovery.smsPhone(ctx.state, user) === phone) ||
        (waPhone && wa.contactPhone(ctx.state, user) === waPhone)),
  );
  return matches.length === 1 ? matches[0] : null;
}

function readAccount(input, fail) {
  const account = String(input.account || '').trim();
  if (!account || account.length > 120) throw fail(400, 'Kullanıcı adı, cep telefonu veya e-posta girin.');
  return account;
}
function readPassword(input, fail) {
  const { password } = input;
  if (typeof password !== 'string' || password.length < 10 || password.length > 128)
    throw fail(400, 'Yeni şifre 10–128 karakter olmalı.');
  return password;
}

// Each sender stays silent about accounts that do not exist or have nowhere to send to.
function sendSmsCode(ctx, user) {
  const phone = user && smsRecovery.smsPhone(ctx.state, user);
  if (!phone) return;
  const next = structuredClone(ctx.state);
  const code = smsRecovery.issueCode(
    next,
    next.users.find((row) => row.id === user.id),
  );
  if (!code) return;
  ctx.persist(next);
  ctx.res.hanSms = {
    ...(officeSmsOn(ctx.state) ? { config: ctx.state.smsConfig } : {}),
    to: phone,
    text: smsRecovery.message(code),
    silent: true,
  };
}
// A verified address gets the 8-digit reset code. An unverified one first gets a 6-digit
// verification code; entering it verifies the address and sends the reset code.
function sendEmailCode(ctx, user) {
  const address = user && emailRecovery.accountEmail(ctx.state, user);
  if (!address) return;
  const next = structuredClone(ctx.state);
  const target = next.users.find((row) => row.id === user.id);
  const verified = emailRecovery.isVerified(next, target);
  const code = emailRecovery.issueCode(next, target, verified ? 'reset' : 'verify');
  if (!code) return;
  ctx.persist(next);
  const office = officeName(ctx);
  queueEmail(
    ctx.res,
    {
      to: address,
      toName: user.name,
      fromName: office,
      purpose: verified ? 'password_recovery' : 'email_verification',
      ...(verified
        ? emailRecovery.resetMessage({ office, code })
        : emailRecovery.verifyMessage({ office, code, during: 'recovery' })),
    },
    { silent: true },
  );
}

async function setPassword(ctx, next, target, password) {
  target.salt = ctx.crypto.randomBytes(16).toString('hex');
  target.hash = await ctx.hash(password, target.salt);
  target.passwordChangedAt = new Date().toISOString();
  target.passwordChangedBy = target.id;
  closeHelp(next, target.id, target.id);
  ctx.invalidate(target.id);
  ctx.res.hanAuditActor = { id: target.id, name: target.name, username: target.username };
}

// Managers who may set this account's password: CEOs for a CEO, CEOs and admins otherwise.
function helpRecipients(ctx, user) {
  return ctx.state.users.filter(
    (manager) =>
      manager.id !== user.id &&
      !manager.platformSupport &&
      ctx.userEnabled(manager) &&
      (user.role === 'ceo' ? manager.role === 'ceo' : MANAGERS.includes(manager.role)),
  );
}
function closeHelp(state, userId, by, status = 'done') {
  const at = new Date().toISOString();
  for (const row of state.passwordHelp || [])
    if (row.userId === userId && row.status === 'open')
      Object.assign(row, { status, closedAt: at, closedBy: by });
}
function askManager(ctx, user, note) {
  const now = Date.now();
  const managers = helpRecipients(ctx, user);
  const rows = (ctx.state.passwordHelp || []).filter((row) => Date.parse(row.at) > now - 30 * DAY);
  const mine = rows.filter((row) => row.userId === user.id);
  if (
    !managers.length ||
    mine.some((row) => row.status === 'open' && Date.parse(row.at) > now - HELP_OPEN_MS) ||
    mine.filter((row) => Date.parse(row.at) > now - DAY).length >= HELP_PER_DAY
  )
    return;
  const next = structuredClone(ctx.state);
  const at = new Date(now).toISOString();
  const request = { id: ctx.crypto.randomUUID(), userId: user.id, at, note, status: 'open' };
  next.passwordHelp = [...rows, request];
  const text =
    `${user.name} (${user.username}) giriş yapamadığını bildirdi ve yeni şifre istedi.` +
    (note ? `\nNot: ${note}` : '') +
    '\n\nKimliğini doğruladıktan sonra Kullanıcı Yönetimi ekranındaki “Bekleyen şifre talepleri” listesinden yeni şifre belirleyip iletin.';
  next.messages = [
    ...(next.messages || []),
    {
      id: ctx.crypto.randomUUID(),
      senderId: user.id,
      senderName: user.name,
      recipientIds: managers.map((manager) => manager.id),
      recipientNames: managers.map((manager) => manager.name),
      subject: ('Şifre Talebi · ' + user.name).slice(0, 150),
      text,
      systemType: 'passwordHelp',
      passwordHelpId: request.id,
      createdAt: at,
      readBy: {},
    },
  ];
  next.workflowNotices = [
    ...(next.workflowNotices || []),
    ...managers.map((manager) => ({
      id: ctx.crypto.randomUUID(),
      userId: manager.id,
      type: 'passwordHelp',
      text: `${user.name} giriş yapamıyor ve yeni şifre istiyor.`,
      helpUserId: user.id,
      createdAt: at,
      acknowledgedAt: null,
    })),
  ];
  ctx.persist(next);
}

// The account a verification request is about: the caller's own, or (for a manager) a staff
// account. Only a CEO manages a CEO account.
function verificationTarget(ctx, userId) {
  const { u, fail } = ctx;
  if (u.platformSupport) throw fail(403, 'Destek oturumunda e-posta doğrulanamaz.');
  if (!userId || userId === u.id) return u;
  if (!MANAGERS.includes(u.role)) throw fail(403, 'Yalnızca kendi e-posta adresinizi doğrulayabilirsiniz.');
  const target = ctx.state.users.find((user) => user.id === userId && !user.platformSupport);
  if (!target) throw fail(404, 'Kullanıcı bulunamadı.');
  if (target.role === 'ceo' && u.role !== 'ceo') throw fail(403, 'CEO hesabını yalnızca CEO yönetebilir.');
  return target;
}

function verificationView(ctx, user) {
  return {
    ...profile(ctx.state, user),
    emailVerification: ctx.options.emailAvailable === true,
  };
}

// A manager's new password for a locked-out user, sent to the user's registered mobile or
// e-mail address. Called by /api/users/password after the password changed in `next`.
function deliverPassword(ctx, next, account, password, deliver) {
  if (!deliver || deliver === 'none') return;
  const office = officeName(ctx);
  if (deliver === 'sms') {
    const phone = smsRecovery.smsPhone(next, account);
    if (!phone)
      throw ctx.fail(
        409,
        'Kullanıcının kayıtlı cep telefonu yok. Önce E-posta / Cep Telefonu bölümünden ekleyin.',
      );
    if (!channels.availableChannels(ctx.state, ctx.options).sms)
      throw ctx.fail(412, 'Büroda SMS gönderimi açık değil.');
    const plain = (text) =>
      String(text)
        .replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => 'cCgGiIoOsSuU'['çÇğĞıİöÖşŞüÜ'.indexOf(c)])
        .replace(/[^\x20-\x7e]/g, '');
    ctx.res.hanSms = {
      ...(officeSmsOn(ctx.state) ? { config: ctx.state.smsConfig } : {}),
      to: phone,
      text: `${plain(office)}: Sifreniz yoneticiniz tarafindan yenilendi. Kullanici adi: ${account.username} Yeni sifre: ${password} Giristen sonra Hesabim bolumunden degistirin.`,
      silent: false,
    };
    return;
  }
  if (deliver === 'email') {
    const address = emailRecovery.accountEmail(next, account);
    if (!address)
      throw ctx.fail(
        409,
        'Kullanıcının kayıtlı e-posta adresi yok. Önce E-posta / Cep Telefonu bölümünden ekleyin.',
      );
    if (ctx.options.emailAvailable !== true) throw ctx.fail(412, 'Büroda e-posta gönderimi açık değil.');
    queueEmail(
      ctx.res,
      {
        to: address,
        toName: account.name,
        fromName: office,
        purpose: 'password_delivery',
        ...emailRecovery.passwordMessage({
          office,
          username: account.username,
          password,
          manager: ctx.u.name,
        }),
      },
      { silent: false },
    );
    return;
  }
  throw ctx.fail(400, 'İletim yöntemi geçersiz.');
}

async function handlePublicRecovery(ctx) {
  const { req, res, url, send, fail, body } = ctx;
  const route = url.pathname;
  if (route === '/api/password-reset/channels' && req.method === 'GET') {
    send(res, 200, { channels: openChannels(ctx) });
    return true;
  }
  if (route === '/api/password-reset/request' && req.method === 'POST') {
    throttle(ctx, 'password-wa-request', 8);
    const input = await body(req);
    const account = readAccount(input, fail);
    const open = openChannels(ctx);
    if (input.channel !== undefined && !open.includes(input.channel))
      throw fail(409, 'Bu yöntem büronuzda açık değil.');
    const channel = input.channel ?? open[0];
    // Nothing set up: the screen offers "Yöneticiden iste".
    if (!channel) {
      send(res, 200, { ok: true, channel: 'none', alternatives: [] });
      return true;
    }
    // The answer never says whether the account exists or has anywhere to send to.
    const user = findAccount(ctx, account);
    if (channel === 'whatsapp') requestReset(ctx, user, { silent: true });
    else if (channel === 'sms') sendSmsCode(ctx, user);
    else sendEmailCode(ctx, user);
    send(res, 200, { ok: true, channel, alternatives: open.filter((item) => item !== channel) });
    return true;
  }
  if (route === '/api/password-reset/sms-complete' && req.method === 'POST') {
    throttle(ctx, 'password-sms-complete', 12);
    const input = await body(req);
    const password = readPassword(input, fail);
    const user = findAccount(ctx, readAccount(input, fail));
    const next = structuredClone(ctx.state);
    const target = user && next.users.find((row) => row.id === user.id);
    const check = target ? smsRecovery.checkCode(next, target, input.code) : { ok: false, changed: false };
    if (!check.ok) {
      // 200 so the wrong-attempt count commits; the body says it failed.
      if (check.changed) ctx.persist(next);
      send(res, 200, { ok: false, error: 'Geçici şifre hatalı veya süresi dolmuş. Yeni şifre isteyin.' });
      return true;
    }
    await setPassword(ctx, next, target, password);
    ctx.persist(next);
    send(res, 200, { ok: true, username: target.username });
    return true;
  }
  if (route === '/api/password-reset/email-complete' && req.method === 'POST') {
    throttle(ctx, 'password-email-complete', 12);
    const input = await body(req);
    const password = readPassword(input, fail);
    const user = findAccount(ctx, readAccount(input, fail));
    const next = structuredClone(ctx.state);
    const target = user && next.users.find((row) => row.id === user.id);
    const check = target ? emailRecovery.checkCode(next, target, input.code) : { ok: false, changed: false };
    if (!check.ok) {
      if (check.changed) ctx.persist(next);
      send(res, 200, { ok: false, error: CODE_ERROR });
      return true;
    }
    if (check.kind === 'verify') {
      // The address is now verified: the reset code follows to the same address.
      const code = emailRecovery.issueCode(next, target, 'reset');
      ctx.persist(next);
      if (code) {
        const office = officeName(ctx);
        queueEmail(
          res,
          {
            to: emailRecovery.accountEmail(next, target),
            toName: target.name,
            fromName: office,
            purpose: 'password_recovery',
            ...emailRecovery.resetMessage({ office, code }),
          },
          { silent: true },
        );
      }
      send(res, 200, {
        ok: false,
        verified: true,
        error: code
          ? 'E-posta adresiniz doğrulandı. Şifre yenileme kodu aynı adrese gönderildi; e-postadaki 8 haneli kodu girin.'
          : 'E-posta adresiniz doğrulandı, ancak bugünkü şifre yenileme hakkınız doldu. Yarın tekrar deneyin veya yöneticinizden isteyin.',
      });
      return true;
    }
    await setPassword(ctx, next, target, password);
    ctx.persist(next);
    send(res, 200, { ok: true, username: target.username });
    return true;
  }
  if (route === '/api/password-reset/ask-manager' && req.method === 'POST') {
    throttle(ctx, 'password-help', 5);
    const input = await body(req);
    const account = readAccount(input, fail);
    const note = String(input.note ?? '').trim();
    if (note.length > 300) throw fail(400, 'Not en fazla 300 karakter olabilir.');
    const user = findAccount(ctx, account, { anyEmail: true });
    if (user) askManager(ctx, user, note);
    send(res, 200, { ok: true });
    return true;
  }
  return false;
}

async function handleRecoveryRoutes(ctx) {
  const { req, res, url, u, send, fail, body } = ctx;
  const route = url.pathname;
  if (PUBLIC_ROUTES.includes(route)) return handlePublicRecovery(ctx);
  if (
    !route.startsWith('/api/email-verification/') &&
    !route.startsWith('/api/password-help') &&
    route !== '/api/recovery/settings'
  )
    return false;
  if (!u) throw fail(401, 'Giriş yapın.');
  const manager = MANAGERS.includes(u.role);

  if (route === '/api/email-verification/send' && req.method === 'POST') {
    const target = verificationTarget(ctx, (await body(req)).userId);
    if (ctx.options.emailAvailable !== true) throw fail(412, 'E-posta gönderimi bu büroda henüz açık değil.');
    const address = emailRecovery.accountEmail(ctx.state, target);
    if (!address) throw fail(409, 'Önce e-posta adresini kaydedin.');
    if (emailRecovery.isVerified(ctx.state, target)) throw fail(409, 'Bu e-posta adresi zaten doğrulandı.');
    const next = structuredClone(ctx.state);
    const code = emailRecovery.issueCode(
      next,
      next.users.find((row) => row.id === target.id),
      'verify',
    );
    if (!code) throw fail(429, 'Bu hesap için doğrulama kodu sınırına ulaşıldı. Yarın tekrar deneyin.');
    ctx.persist(next);
    const office = officeName(ctx);
    queueEmail(
      res,
      {
        to: address,
        toName: target.name,
        fromName: office,
        purpose: 'email_verification',
        ...emailRecovery.verifyMessage({ office, code }),
      },
      { silent: false },
    );
    send(res, 200, { ok: true, sentTo: maskEmail(address) });
    return true;
  }
  if (route === '/api/email-verification/confirm' && req.method === 'POST') {
    const input = await body(req);
    const target = verificationTarget(ctx, input.userId);
    const next = structuredClone(ctx.state);
    const account = next.users.find((row) => row.id === target.id);
    const check = emailRecovery.checkCode(next, account, input.code, { kinds: ['verify'] });
    if (!check.ok) {
      if (check.changed) ctx.persist(next);
      send(res, 200, { ok: false, error: 'Doğrulama kodu hatalı veya süresi dolmuş. Yeni kod isteyin.' });
      return true;
    }
    ctx.persist(next);
    send(res, 200, { ok: true, ...verificationView(ctx, account) });
    return true;
  }
  if (route === '/api/email-verification/send-all' && req.method === 'POST') {
    if (!manager) throw fail(403, 'Yönetici yetkisi gerekli.');
    if (ctx.options.emailAvailable !== true) throw fail(412, 'E-posta gönderimi bu büroda henüz açık değil.');
    const next = structuredClone(ctx.state);
    const office = officeName(ctx);
    const now = Date.now();
    const result = { queued: 0, verified: 0, missing: 0, recent: 0 };
    for (const account of next.users) {
      if (account.platformSupport || !ctx.userEnabled(account)) continue;
      const address = emailRecovery.accountEmail(next, account);
      if (!address) result.missing++;
      else if (emailRecovery.isVerified(next, account)) result.verified++;
      // A code sent within the last day is still valid: do not flood the mailbox.
      else if (emailRecovery.lastIssued(next, account, 'verify') > now - DAY) result.recent++;
      else {
        const code = emailRecovery.issueCode(next, account, 'verify', { now });
        if (!code) {
          result.recent++;
          continue;
        }
        result.queued++;
        queueEmail(
          res,
          {
            to: address,
            toName: account.name,
            fromName: office,
            purpose: 'email_verification',
            ...emailRecovery.verifyMessage({ office, code }),
          },
          { silent: true },
        );
      }
    }
    if (result.queued) ctx.persist(next);
    send(res, 200, { ok: true, ...result });
    return true;
  }
  if (route === '/api/recovery/settings') {
    if (!manager) throw fail(403, 'Yönetici yetkisi gerekli.');
    if (req.method === 'PUT') {
      if (u.role !== 'ceo') throw fail(403, 'Şifre yenileme ayarını yalnızca CEO değiştirebilir.');
      const policy = channels.cleanPolicy(await body(req), fail);
      if (!channels.availableChannels(ctx.state, ctx.options)[policy.primary])
        throw fail(409, 'Bu yöntem henüz kurulu değil. Önce ilgili entegrasyonu açın.');
      const next = structuredClone(ctx.state);
      next.recoveryPolicy = policy;
      ctx.persist(next);
    } else if (req.method !== 'GET') throw fail(405, 'Yöntem desteklenmiyor.');
    const accounts = { total: 0, verified: 0, unverified: 0, missing: 0 };
    for (const account of ctx.state.users) {
      if (account.platformSupport || !ctx.userEnabled(account)) continue;
      accounts.total++;
      if (!emailRecovery.accountEmail(ctx.state, account)) accounts.missing++;
      else if (emailRecovery.isVerified(ctx.state, account)) accounts.verified++;
      else accounts.unverified++;
    }
    send(res, 200, {
      primary: ctx.state.recoveryPolicy?.primary || null,
      order: openChannels(ctx),
      available: channels.availableChannels(ctx.state, ctx.options),
      officeSms: officeSmsOn(ctx.state),
      accounts,
    });
    return true;
  }
  if (route === '/api/password-help' && req.method === 'GET') {
    if (!manager) throw fail(403, 'Yönetici yetkisi gerekli.');
    const now = Date.now();
    const requests = (ctx.state.passwordHelp || [])
      .filter((row) => row.status === 'open' && Date.parse(row.at) > now - HELP_OPEN_MS)
      .map((row) => ({ row, account: ctx.state.users.find((user) => user.id === row.userId) }))
      .filter(
        ({ account }) => account && ctx.userEnabled(account) && (account.role !== 'ceo' || u.role === 'ceo'),
      )
      .map(({ row, account }) => {
        const contact = profile(ctx.state, account);
        return {
          id: row.id,
          userId: account.id,
          name: account.name,
          username: account.username,
          role: account.role,
          at: row.at,
          note: row.note || '',
          email: contact.email,
          emailVerified: contact.emailVerified,
          mobilePhone: contact.mobilePhone,
        };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
    const available = channels.availableChannels(ctx.state, ctx.options);
    send(res, 200, { requests, delivery: { sms: available.sms, email: available.email } });
    return true;
  }
  if (route === '/api/password-help/close' && req.method === 'POST') {
    if (!manager) throw fail(403, 'Yönetici yetkisi gerekli.');
    const { id } = await body(req);
    const row = (ctx.state.passwordHelp || []).find((item) => item.id === id && item.status === 'open');
    if (!row) throw fail(404, 'Açık şifre talebi bulunamadı.');
    const account = ctx.state.users.find((user) => user.id === row.userId);
    if (account?.role === 'ceo' && u.role !== 'ceo')
      throw fail(403, 'CEO hesabını yalnızca CEO yönetebilir.');
    const next = structuredClone(ctx.state);
    Object.assign(
      next.passwordHelp.find((item) => item.id === id),
      { status: 'closed', closedAt: new Date().toISOString(), closedBy: u.id },
    );
    ctx.persist(next);
    send(res, 200, { ok: true });
    return true;
  }
  return false;
}

module.exports = { handleRecoveryRoutes, deliverPassword, closeHelp, findAccount, PUBLIC_ROUTES };
