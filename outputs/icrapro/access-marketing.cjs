const maps = require('../../lib/maps-settings.cjs');
const places = require('../../lib/google-places.cjs');
const scraper = require('../../lib/map-scraper.cjs');
const marketing = require('../../lib/marketing-routes.cjs');
const { markRecord } = require('../../lib/test-records.cjs');
const { throttle } = require('./access-whatsapp.cjs');

const NOT_READY =
  'Google Haritalar bağlantısı kurulmadı. CEO, Ayarlar → Entegrasyonlar → Google Haritalar bölümünden API anahtarını girmelidir.';
const SCRAPER_NOT_READY =
  'Harita tarama sunucusu kurulmadı. CEO, Ayarlar → Entegrasyonlar → Google Haritalar bölümünden sunucu adresini girmelidir.';

// Search, scraping, route refresh and connection tests call outside map services
// and never write state. In the cloud they run outside the database transaction
// (see lib/application.cjs).
async function handleMarketingRoutes(ctx) {
  const { url, req, res, u } = ctx;
  if (!url.pathname.startsWith('/api/marketing/')) return false;
  const fetcher = ctx.options.mapsFetch || fetch;
  // A loopback tarama sunucusu is only reachable when the application runs locally.
  const local = { allowLocal: ctx.options.allowLocalServices === true };
  const method = (expected) => {
    if (req.method !== expected) throw ctx.fail(405, 'Yöntem desteklenmiyor.');
  };

  if (['/api/marketing/config', '/api/marketing/test'].includes(url.pathname)) {
    if (u?.role !== 'ceo') throw ctx.fail(403, 'Google Haritalar bağlantısını yalnızca CEO yönetebilir.');
    if (url.pathname === '/api/marketing/test') {
      method('POST');
      throttle(ctx, 'marketing-test', 10);
      const input = await ctx.body(req);
      if (input?.source === 'scraper')
        await scraper.listJobs({ ...maps.testScraper(ctx.state.mapsConfig, input, local), fetcher });
      else await places.testKey({ apiKey: maps.testKey(ctx.state.mapsConfig, input), fetcher });
      ctx.send(res, 200, { ok: true });
      return true;
    }
    if (req.method === 'GET') {
      ctx.send(res, 200, maps.publicConfig(ctx.state.mapsConfig, local));
      return true;
    }
    method('PUT');
    const next = structuredClone(ctx.state);
    next.mapsConfig = maps.configure(next.mapsConfig, await ctx.body(req), local);
    ctx.persistMetadata(next);
    ctx.send(res, 200, maps.publicConfig(next.mapsConfig, local));
    return true;
  }

  if (!marketing.hasMarketingAccess(ctx.state, u))
    throw ctx.fail(403, 'Pazarlama bölümüne erişim yetkiniz yok.');
  const config = maps.publicConfig(ctx.state.mapsConfig, local);

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

  if (url.pathname === '/api/marketing/scrape') {
    method('POST');
    throttle(ctx, 'marketing-scrape', 20);
    const input = await ctx.body(req);
    const criteria = marketing.criteria(input, config.sectors);
    const depth = Object.hasOwn(scraper.DEPTHS, input.depth) ? input.depth : 'normal';
    const target = maps.runtimeScraper(ctx.state.mapsConfig, local);
    if (!target) throw ctx.fail(503, SCRAPER_NOT_READY);
    const jobId = await scraper.createJob({
      ...target,
      keywords: marketing.textQuery(criteria),
      depth,
      fetcher,
    });
    ctx.send(res, 202, { jobId, depth });
    return true;
  }

  if (url.pathname === '/api/marketing/scrape-status') {
    method('POST');
    throttle(ctx, 'marketing-scrape-status', 300);
    const input = await ctx.body(req);
    if (typeof input?.jobId !== 'string' || !scraper.JOB_ID.test(input.jobId))
      throw ctx.fail(400, 'Geçersiz tarama işi.');
    const criteria = marketing.criteria(input, config.sectors);
    const target = maps.runtimeScraper(ctx.state.mapsConfig, local);
    if (!target) throw ctx.fail(503, SCRAPER_NOT_READY);
    const status = await scraper.jobStatus({ ...target, id: input.jobId, fetcher });
    if (status === 'failed')
      throw ctx.fail(502, 'Harita taraması tamamlanamadı. Daha dar bir kapsamla yeniden deneyin.');
    if (status !== 'ok') {
      ctx.send(res, 200, { status: status === 'pending' ? 'pending' : 'working' });
      return true;
    }
    const found = await scraper.jobPlaces({ ...target, id: input.jobId, fetcher });
    ctx.send(res, 200, {
      status: 'ok',
      ...marketing.annotatePlaces(found, criteria, ctx.state, u),
      received: found.length,
    });
    return true;
  }

  if (url.pathname === '/api/marketing/route-places') {
    method('POST');
    throttle(ctx, 'marketing-details', 30);
    const input = await ctx.body(req);
    const saved = marketing.findRoute(ctx.state, u, input?.routeId);
    // Scraped routes carry their own copy; only Google routes need the key.
    const apiKey = saved.source === 'scraper' ? '' : maps.runtimeKey(ctx.state.mapsConfig);
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
