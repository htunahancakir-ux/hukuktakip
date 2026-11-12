const crypto = require('node:crypto');
const settings = require('../../lib/iyzico-settings.cjs');

// Settings → Integrations → iyzico: the office saves its own merchant keys, tests them and
// creates payment links for its own customers. Only the CEO may do any of this. Keys are
// sealed in the workspace state and never sent back to the browser.
const ROUTES = ['/api/iyzico/config', '/api/iyzico/test', '/api/iyzico/link'];

function text(ctx, value, label, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max)
    throw ctx.fail(400, `${label} ${min}–${max} karakter olmalıdır.`);
  return value.trim();
}

async function handleIyzicoRoutes(ctx) {
  const route = ctx.url.pathname;
  if (!ROUTES.includes(route)) return false;
  if (ctx.u?.role !== 'ceo') throw ctx.fail(403, 'iyzico bağlantısını yalnızca CEO yönetebilir.');
  const fetcher = ctx.options.iyzicoFetch;
  // Library errors carry an HTTP status; anything unexpected stays a server error.
  const guarded = async (work) => {
    try {
      return await work();
    } catch (error) {
      if (Number.isInteger(error.status) && error.status < 500 && !error.response)
        throw ctx.fail(error.status, error.message);
      if (Number.isInteger(error.status) && error.status === 502) throw ctx.fail(400, error.message);
      throw error;
    }
  };

  if (route === '/api/iyzico/config') {
    if (ctx.req.method === 'GET') {
      ctx.send(ctx.res, 200, settings.publicConfig(ctx.state.iyzicoConfig));
      return true;
    }
    if (ctx.req.method !== 'PUT') throw ctx.fail(405, 'Yöntem desteklenmiyor.');
    const body = await ctx.body(ctx.req);
    const next = structuredClone(ctx.state);
    const configured = await guarded(async () => settings.configure(next.iyzicoConfig, body));
    if (configured) next.iyzicoConfig = configured;
    else delete next.iyzicoConfig;
    ctx.persist(next);
    ctx.send(ctx.res, 200, settings.publicConfig(next.iyzicoConfig));
    return true;
  }

  if (ctx.req.method !== 'POST') throw ctx.fail(405, 'Yöntem desteklenmiyor.');
  const body = await ctx.body(ctx.req);

  if (route === '/api/iyzico/test') {
    // Tests the typed keys when given, otherwise the saved ones; nothing is stored.
    const result = await guarded(async () =>
      settings.clientFor(ctx.state.iyzicoConfig, body, { fetcher }).testCredentials(),
    );
    ctx.send(ctx.res, 200, result);
    return true;
  }

  // /api/iyzico/link: a shareable iyzico payment page for an amount the office chooses.
  const name = text(ctx, body.name, 'Başlık', 2, 60);
  const description = text(ctx, body.description, 'Açıklama', 2, 200);
  if (!Number.isSafeInteger(body.amountKurus) || body.amountKurus < 100 || body.amountKurus > 100_000_000)
    throw ctx.fail(400, 'Tutar 1,00 TL ile 1.000.000,00 TL arasında olmalıdır.');
  const link = await guarded(async () => {
    const client = settings.clientFor(ctx.state.iyzicoConfig, {}, { fetcher });
    return client.createPaymentLink({
      name,
      description,
      amountKurus: body.amountKurus,
      conversationId: crypto.randomUUID(),
    });
  });
  ctx.send(ctx.res, 200, { url: link.url });
  return true;
}

module.exports = { handleIyzicoRoutes };
