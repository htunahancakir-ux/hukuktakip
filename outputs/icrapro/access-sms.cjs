const smsSettings = require('../../lib/sms-settings.cjs');

// Settings → Integrations → SMS: the office's own Verimor SMS account. CEO only; the API
// password is never returned. Sending happens after the request commits (lib/application.cjs).
// lib/sms-settings.cjs and lib/verimor-sms.cjs report HTTP statuses as `status`; this handler's
// errors carry it as `code`. Translate so the CEO sees the real reason (bad account number, IP
// not allowed, no credit) instead of a generic server error.
async function handleSmsRoutes(ctx) {
  try {
    return await smsRoutes(ctx);
  } catch (error) {
    if (Number.isInteger(error.status) && !Number.isInteger(error.code))
      throw ctx.fail(error.status, error.message);
    throw error;
  }
}

async function smsRoutes(ctx) {
  const { req, res, url, u, send, fail, body } = ctx;
  if (!url.pathname.startsWith('/api/sms/')) return false;
  if (u.role !== 'ceo') throw fail(403, 'SMS ayarlarını yalnızca CEO yönetebilir.');
  const fetcher = ctx.options.smsFetch;
  if (url.pathname === '/api/sms/config') {
    if (req.method === 'GET') {
      send(res, 200, smsSettings.publicConfig(ctx.state.smsConfig));
      return true;
    }
    if (req.method !== 'PUT') throw fail(405, 'İşlem desteklenmiyor.');
    const next = structuredClone(ctx.state);
    const config = smsSettings.configure(next.smsConfig, await body(req));
    if (config) next.smsConfig = config;
    else delete next.smsConfig;
    ctx.persist(next);
    send(res, 200, smsSettings.publicConfig(config));
    return true;
  }
  if (url.pathname === '/api/sms/test' && req.method === 'POST') {
    const client = smsSettings.clientFor(ctx.state.smsConfig, await body(req), { fetcher });
    const [balance, headers] = await Promise.all([client.balance(), client.headers()]);
    send(res, 200, { ok: true, balance, headers });
    return true;
  }
  if (url.pathname === '/api/sms/send-test' && req.method === 'POST') {
    const input = await body(req);
    if (!smsSettings.publicConfig(ctx.state.smsConfig).configured)
      throw fail(412, 'Önce SMS ayarlarını kaydedin.');
    const { smsNumber } = require('../../lib/verimor-sms.cjs');
    if (!smsNumber(input.phone)) throw fail(400, 'Geçerli bir Türkiye cep telefonu girin (05xx xxx xx xx).');
    res.hanSms = {
      config: ctx.state.smsConfig,
      to: input.phone,
      text: 'Han Hukuk SMS denemesi. Bu mesaji aldiysaniz SMS ayarlari calisiyor.',
      silent: false,
    };
    send(res, 200, { ok: true });
    return true;
  }
  return false;
}

module.exports = { handleSmsRoutes };
