const maps = require('../../lib/maps-settings.cjs');
const places = require('../../lib/google-places.cjs');
const marketing = require('../../lib/marketing-routes.cjs');
const { markRecord } = require('../../lib/test-records.cjs');
const { throttle } = require('./access-whatsapp.cjs');

const NOT_READY =
  'Google Haritalar bağlantısı kurulmadı. CEO, Ayarlar → Entegrasyonlar → Google Haritalar bölümünden API anahtarını girmelidir.';

// Search, route refresh and key test call Google and never write state. In the
// cloud they run outside the database transaction (see lib/application.cjs).
async function handleMarketingRoutes(ctx) {
  const { url, req, res, u } = ctx;
  if (!url.pathname.startsWith('/api/marketing/')) return false;
  const fetcher = ctx.options.placesFetch || fetch;
  const method = (expected) => {
    if (req.method !== expected) throw ctx.fail(405, 'Yöntem desteklenmiyor.');
  };

  if (['/api/marketing/config', '/api/marketing/test'].includes(url.pathname)) {
    if (u?.role !== 'ceo') throw ctx.fail(403, 'Google Haritalar bağlantısını yalnızca CEO yönetebilir.');
    if (url.pathname === '/api/marketing/test') {
      method('POST');
      throttle(ctx, 'marketing-test', 10);
      const apiKey = maps.testKey(ctx.state.mapsConfig, await ctx.body(req));
      await places.testKey({ apiKey, fetcher });
      ctx.send(res, 200, { ok: true });
      return true;
    }
    if (req.method === 'GET') {
      ctx.send(res, 200, maps.publicConfig(ctx.state.mapsConfig));
      return true;
    }
    method('PUT');
    const next = structuredClone(ctx.state);
    next.mapsConfig = maps.configure(next.mapsConfig, await ctx.body(req));
    ctx.persistMetadata(next);
    ctx.send(res, 200, maps.publicConfig(next.mapsConfig));
    return true;
  }

  if (!marketing.hasMarketingAccess(ctx.state, u))
    throw ctx.fail(403, 'Pazarlama bölümüne erişim yetkiniz yok.');
  const config = maps.publicConfig(ctx.state.mapsConfig);

  if (url.pathname === '/api/marketing/overview') {
    method('GET');
    ctx.send(res, 200, marketing.overview(ctx.state, u, config));
    return true;
  }

  if (url.pathname === '/api/marketing/search') {
    method('POST');
    throttle(ctx, 'marketing-search', 40);
    const input = await ctx.body(req);
    const criteria = marketing.criteria(input, config.sectors);
    const pageToken = marketing.pageToken(input.pageToken);
    const apiKey = maps.runtimeKey(ctx.state.mapsConfig);
    if (!apiKey) throw ctx.fail(503, NOT_READY);
    const found = await places.searchText({
      apiKey,
      textQuery: marketing.textQuery(criteria),
      pageToken,
      fetcher,
    });
    ctx.send(res, 200, {
      ...marketing.annotatePlaces(found.places, criteria, ctx.state, u),
      received: found.places.length,
      nextPageToken: found.nextPageToken,
    });
    return true;
  }

  if (url.pathname === '/api/marketing/route-places') {
    method('POST');
    throttle(ctx, 'marketing-details', 30);
    const input = await ctx.body(req);
    const apiKey = maps.runtimeKey(ctx.state.mapsConfig);
    if (!apiKey) throw ctx.fail(503, NOT_READY);
    ctx.send(res, 200, await marketing.routePlaces(ctx.state, u, input, { apiKey, fetcher }));
    return true;
  }

  if (url.pathname === '/api/marketing/routes') {
    method('POST');
    const { route, next } = marketing.saveRoute(ctx.state, u, await ctx.body(req), config.sectors);
    if (next) {
      markRecord(undefined, route, u);
      ctx.persistMetadata(next);
    }
    ctx.send(res, next ? 201 : 200, { route: marketing.routeSummary(route, next || ctx.state) });
    return true;
  }

  throw ctx.fail(404, 'İşlem bulunamadı.');
}

module.exports = { handleMarketingRoutes };
