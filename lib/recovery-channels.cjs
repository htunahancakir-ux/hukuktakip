const crypto = require('node:crypto');
const sms = require('./sms-settings.cjs');
const wa = require('./whatsapp.cjs');
const { officeIdentity, plainSms } = require('./office-identity.cjs');

// The ways "Şifremi unuttum" can reach a user, and the order they are tried in.
//
//   whatsapp  the office's own WhatsApp Business integration (a password link)
//   sms       the office's own Verimor account, or else the platform's SMS service
//   email     the platform's e-mail service (Brevo)
//
// The office's own WhatsApp and SMS count only after a live delivery test: the CEO sends a real
// test message with the saved settings and the recipient confirms it arrived (Ayarlar → SMS /
// WhatsApp → Şifre kurtarma canlı testi). A provider accepting a message proves nothing about
// delivery, and a changed sender, credential or template needs a new test.
//
// The office CEO picks the first way (Ayarlar → Entegrasyonlar → Şifre Yenileme, saved as
// `recoveryPolicy.primary`); the others stay offered when a code does not arrive. Without a
// choice the long-standing order applies: WhatsApp, then SMS, then e-mail. When none is open, or
// none reaches the user, "Yöneticiden iste" sends the request to the office's managers.

const CHANNELS = Object.freeze(['whatsapp', 'sms', 'email']);
const LABELS = Object.freeze({ whatsapp: 'WhatsApp', sms: 'SMS', email: 'E-posta' });
const TTL = 15 * 60000;
const DAY = 86400000;
const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

// What the saved setup of a channel looks like; '' when the channel cannot send a recovery
// message at all. A live test is bound to this, so any change to it asks for a new test.
function stamp(state, channel) {
  const c = channel === 'sms' ? state.smsConfig : state.whatsappConfig;
  if (channel === 'sms') {
    if (!sms.publicConfig(c).enabled || !c.header) return '';
    return digest(JSON.stringify([c.enabled, c.username, c.passwordEnc, c.header]));
  }
  if (!c?.enabled || !c.sealedToken || !c.phoneNumberId || !c.resetTemplate) return '';
  return digest(
    JSON.stringify([c.enabled, c.phoneNumberId, c.sealedToken, c.version, c.language, c.resetTemplate]),
  );
}
// The office's own channel passed a live test with its current setup.
function ready(state, channel) {
  const current = stamp(state, channel);
  return !!current && state.recoveryChannelReadiness?.[channel]?.stamp === current;
}
function invalidate(state, channel) {
  if (state.recoveryChannelReadiness) delete state.recoveryChannelReadiness[channel];
  for (const row of state.recoveryChannelTests || []) if (row.channel === channel) row.expires = 0;
}
function pass(state, row) {
  row.expires = 0;
  state.recoveryChannelReadiness = {
    ...state.recoveryChannelReadiness,
    [row.channel]: { stamp: row.stamp, verifiedAt: new Date().toISOString() },
  };
}

// Which SMS account sends a recovery code: the office's own once it passed the live test,
// otherwise the platform's SMS service when the office may use it. Null: SMS is not open.
function recoverySmsAccount(state, options = {}) {
  if (ready(state, 'sms')) return 'office';
  return options.smsAvailable === true ? 'platform' : null;
}
// Which SMS account sends a message whose result the sender sees on screen (a password a
// manager sends): the office's own whenever it is switched on, otherwise the platform's.
function deliverySmsAccount(state, options = {}) {
  if (sms.publicConfig(state.smsConfig).enabled) return 'office';
  return options.smsAvailable === true ? 'platform' : null;
}

function availableChannels(state, options = {}) {
  return {
    whatsapp: ready(state, 'whatsapp'),
    sms: recoverySmsAccount(state, options) !== null,
    email: options.emailAvailable === true,
  };
}

// Open channels, the office's first choice first.
function channelOrder(state, available) {
  const open = CHANNELS.filter((channel) => available[channel]);
  const primary = state.recoveryPolicy?.primary;
  return open.includes(primary) ? [primary, ...open.filter((channel) => channel !== primary)] : open;
}

function cleanPolicy(input, fail) {
  const primary = input?.primary;
  if (!CHANNELS.includes(primary)) throw fail(400, 'İlk yöntem olarak WhatsApp, SMS veya e-posta seçin.');
  return { primary };
}

// The live delivery tests. Signed out (`publicOnly`): only the page a WhatsApp test link opens.
// Signed in: the CEO starts a test and, for SMS, enters the code the recipient received.
async function handle(ctx, publicOnly = false) {
  const { req, res, url, send, fail } = ctx;
  const path = url.pathname;
  const link = path === '/api/password-reset/channel-test-link';
  const channel =
    path === '/api/sms/recovery-test' ? 'sms' : path === '/api/whatsapp/recovery-test' ? 'whatsapp' : '';
  if (!link && (!channel || publicOnly)) return false;
  if (req.method !== 'POST') throw fail(405, 'İşlem desteklenmiyor.');
  if (!link && ctx.u?.role !== 'ceo') throw fail(403, 'Canlı kurtarma testini yalnızca CEO yapabilir.');
  if (!ctx.options.rateChecked) {
    const key = 'recovery-channel-test:' + path + ':' + String(req.socket?.remoteAddress || 'unknown');
    const now = Date.now(),
      previous = ctx.attempts.get(key);
    const rate = previous?.until > now ? previous : { count: 0, until: now + 900000 };
    if (++rate.count > 12) throw fail(429, 'Çok fazla deneme yapıldı. Daha sonra tekrar deneyin.');
    ctx.attempts.set(key, rate);
  }
  const input = await ctx.body(req);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw fail(400, 'Geçerli test bilgileri girin.');
  const next = structuredClone(ctx.state);
  const rows = (next.recoveryChannelTests = (next.recoveryChannelTests || []).filter(
    (r) => r.at > Date.now() - DAY,
  ));
  if (link) {
    const token =
      typeof input.token === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(input.token) ? input.token : '';
    const row = token && rows.find((r) => r.channel === 'whatsapp' && r.hash === digest(token));
    if (!row) {
      send(res, 200, { test: false });
      return true;
    }
    const usable = row.expires > Date.now() && row.stamp === stamp(next, 'whatsapp');
    if (input.confirm !== true) {
      send(res, 200, { test: true, usable });
      return true;
    }
    if (!usable) throw fail(400, 'Test bağlantısı geçersiz veya süresi dolmuş. Yeni test başlatın.');
    pass(next, row);
    ctx.persist(next);
    send(res, 200, { ok: true, test: true });
    return true;
  }
  const current = stamp(next, channel);
  if (!current)
    throw fail(412, 'Önce kanalı etkinleştirip onaylı şifre kurtarma gönderim ayarlarını kaydedin.');
  if (channel === 'sms' && input.code !== undefined) {
    const row = rows.find(
      (r) =>
        r.channel === channel &&
        r.actorId === ctx.u.id &&
        r.stamp === current &&
        r.expires > Date.now() &&
        r.attempts < 5,
    );
    const code = typeof input.code === 'string' ? input.code.trim() : '';
    const ok =
      !!row &&
      /^\d{8}$/.test(code) &&
      crypto.timingSafeEqual(Buffer.from(row.hash, 'hex'), Buffer.from(digest(row.salt + ':' + code), 'hex'));
    if (!ok) {
      if (row) {
        row.attempts++;
        if (row.attempts >= 5) row.expires = 0;
        ctx.persist(next);
      }
      send(res, 200, { ok: false, error: 'Test kodu hatalı veya süresi dolmuş.' });
      return true;
    }
    pass(next, row);
    ctx.persist(next);
    res.hanAuditEvents = [{ action: 'update', area: 'SMS kurtarma testi', fields: ['Teslim doğrulandı'] }];
    send(res, 200, { ok: true, ready: true });
    return true;
  }
  if (rows.filter((r) => r.channel === channel && r.actorId === ctx.u.id).length >= 3)
    throw fail(429, 'Bu kanal için günde en fazla üç canlı test başlatabilirsiniz.');
  const phone =
    channel === 'sms' ? require('./verimor-sms.cjs').smsNumber(input.phone) : wa.normalizePhone(input.phone);
  if (!phone) throw fail(400, 'Geçerli bir test alıcısı cep telefonu girin.');
  for (const row of rows) if (row.channel === channel && row.actorId === ctx.u.id) row.expires = 0;
  const row = {
    channel,
    actorId: ctx.u.id,
    stamp: current,
    at: Date.now(),
    expires: Date.now() + TTL,
    attempts: 0,
  };
  if (channel === 'sms') {
    const code = String(crypto.randomInt(0, 100000000)).padStart(8, '0');
    row.salt = crypto.randomBytes(16).toString('hex');
    row.hash = digest(row.salt + ':' + code);
    res.hanSms = {
      config: next.smsConfig,
      to: phone,
      // Every office's test message carries that office's own name.
      text: `${plainSms(officeIdentity(next, ctx.options).name)} SMS kurtarma test kodu: ${code}. 15 dk gecerli. Bu kodu SMS ayarlarindaki canli test alanina girin.`,
      silent: false,
    };
  } else {
    const token = crypto.randomBytes(32).toString('base64url');
    row.hash = digest(token);
    wa.queueDirect(
      res,
      next,
      'resetTemplate',
      { to: phone, values: ['1', '3', '8'], linkSuffix: token },
      { silent: false },
    );
  }
  rows.push(row);
  ctx.persist(next);
  send(res, 200, { ok: true, requiresConfirmation: true });
  return true;
}

module.exports = {
  CHANNELS,
  LABELS,
  availableChannels,
  channelOrder,
  cleanPolicy,
  recoverySmsAccount,
  deliverySmsAccount,
  handle,
  ready,
  stamp,
  invalidate,
};
