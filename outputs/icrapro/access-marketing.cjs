const maps = require('../../lib/maps-settings.cjs');
const places = require('../../lib/google-places.cjs');
const scraper = require('../../lib/map-scraper.cjs');
const marketing = require('../../lib/marketing-routes.cjs');
const route = require('./workspace-marketing-route.js');
const { markRecord } = require('../../lib/test-records.cjs');
const { throttle } = require('./access-whatsapp.cjs');

const NOT_READY =
  'Google Haritalar bağlantısı kurulmadı. CEO, Ayarlar → Entegrasyonlar → Google Haritalar bölümünden API anahtarını girmelidir.';
const SCRAPER_NOT_READY =
  'Harita tarama sunucusu kurulmadı. CEO, Ayarlar → Entegrasyonlar → Google Haritalar bölümünden sunucu adresini girmelidir.';
const OWN_NOT_SOLD =
  'Kendi harita anahtarınızla arama, “Pazarlama ve rota” modülüne dahildir. Büronuz hazır harita servisine abonedir; kaynak olarak onu seçin.';
const SERVICE_LABEL = 'Hazır harita servisi (abonelik)';
const SERVICE_OFF = 'Hazır harita servisi şu anda kullanılamıyor. Platform yöneticinize başvurun.';
const serviceQuota = (limit) =>
  `Bu ayki arama hakkınız doldu (${limit} arama). Hak ay başında yenilenir; daha fazlası için platform yöneticinize başvurun.`;
const DETAILS_QUOTA =
  'Bu ayki rota yenileme hakkınız doldu. Hak ay başında yenilenir; daha fazlası için platform yöneticinize başvurun.';

// Search, scraping, route refresh and connection tests call outside map services
// and never write state. In the cloud they run outside the database transaction
// (see lib/application.cjs).
//
// Rota Bulma is sold two ways (lib/saas/platform-maps.cjs). `options.mapsOwn` is false when
// the office did not buy the module that runs on its own keys; `options.platformMaps` is the
// selling company's map service for a subscribed office ({ ready, reason, apiKey, … }).
async function handleMarketingRoutes(ctx) {
  const { url, req, res, u } = ctx;
  if (!url.pathname.startsWith('/api/marketing/')) return false;
  const fetcher = ctx.options.mapsFetch || fetch;
  // A loopback tarama sunucusu is only reachable when the application runs locally.
  const local = { allowLocal: ctx.options.allowLocalServices === true };
  const own = ctx.options.mapsOwn !== false;
  const service = ctx.options.platformMaps || null;
  // An office that also runs on its own keys hears about the service only while it can be
  // used or its allowance ran out: a service the selling company never switched on is not
  // mentioned, so such an office sees exactly what it saw before.
  const offered = !!service && (service.ready || service.reason === 'quota' || !own);
  // This month's searches by source ({ google, scraper, platform }), when they are counted.
  const usage = ctx.options.mapsUsage || null;
  const usageAfter = (source) => (usage ? { usage: { ...usage, [source]: usage[source] + 1 } } : {});
  const method = (expected) => {
    if (req.method !== expected) throw ctx.fail(405, 'Yöntem desteklenmiyor.');
  };

  if (['/api/marketing/config', '/api/marketing/test'].includes(url.pathname)) {
    if (u?.role !== 'ceo') throw ctx.fail(403, 'Google Haritalar bağlantısını yalnızca CEO yönetebilir.');
    if (url.pathname === '/api/marketing/test') {
      method('POST');
      if (!own) throw ctx.fail(403, OWN_NOT_SOLD);
      throttle(ctx, 'marketing-test', 10);
      const input = await ctx.body(req);
      if (input?.source === 'scraper')
        await scraper.listJobs({ ...maps.testScraper(ctx.state.mapsConfig, input, local), fetcher });
      else await places.testKey({ apiKey: maps.testKey(ctx.state.mapsConfig, input), fetcher });
      ctx.send(res, 200, { ok: true });
      return true;
    }
    // `ownKeys` tells the settings page whether the office may enter its own keys;
    // `service` whether it searches on the selling company's map service.
    const shown = (config) => ({ ...config, ownKeys: own, service: offered });
    if (req.method === 'GET') {
      ctx.send(res, 200, shown(maps.publicConfig(ctx.state.mapsConfig, local)));
      return true;
    }
    method('PUT');
    const input = await ctx.body(req);
    const next = structuredClone(ctx.state);
    const current = maps.publicConfig(next.mapsConfig, local);
    // A subscription-only office edits its sector list; its key fields stay as they are.
    next.mapsConfig = maps.configure(
      next.mapsConfig,
      own ? input : { enabled: current.enabled && current.apiKeySaved, sectors: input?.sectors },
      local,
    );
    ctx.persistMetadata(next);
    ctx.send(res, 200, shown(maps.publicConfig(next.mapsConfig, local)));
    return true;
  }

  if (!marketing.hasMarketingAccess(ctx.state, u))
    throw ctx.fail(403, 'Pazarlama bölümüne erişim yetkiniz yok.');
  const config = maps.publicConfig(ctx.state.mapsConfig, local);
  const serviceProblem = service && !service.ready;
  const serviceMessage = () =>
    service?.reason === 'quota' ? serviceQuota(service.monthlySearches) : SERVICE_OFF;

  if (url.pathname === '/api/marketing/overview') {
    method('GET');
    const sources = [
      ...(offered ? [{ id: 'platform', label: SERVICE_LABEL, ready: service.ready }] : []),
      ...(own ? config.sources : []),
    ];
    const browserKey = (own && config.browserKey) || service?.browserKey || '';
    ctx.send(res, 200, {
      ...marketing.overview(ctx.state, u, {
        ...config,
        ready: own && config.ready,
        sources,
        // The office's own choice wins while it is usable; otherwise the service it subscribed to.
        defaultSource:
          service?.ready && !(own && sources.some((item) => item.id === config.defaultSource && item.ready))
            ? 'platform'
            : config.defaultSource,
        map: maps.mapFor(browserKey),
      }),
      canConfigure: u.role === 'ceo' && own,
      ...(usage ? { usage } : {}),
      ...(offered
        ? {
            service: {
              ready: service.ready,
              monthlySearches: service.monthlySearches ?? null,
              searchesLeft: service.searchesLeft ?? null,
              ...(serviceProblem ? { message: serviceMessage() } : {}),
            },
          }
        : {}),
    });
    return true;
  }

  if (url.pathname === '/api/marketing/search') {
    method('POST');
    throttle(ctx, 'marketing-search', 40);
    const input = await ctx.body(req);
    const criteria = marketing.criteria(input, config.sectors);
    const pageToken = marketing.pageToken(input.pageToken);
    let apiKey;
    if (input.source === 'platform') {
      if (!service) throw ctx.fail(403, 'Büronuzun hazır harita servisi aboneliği yok.');
      if (!service.ready) throw ctx.fail(service.reason === 'quota' ? 429 : 503, serviceMessage());
      apiKey = service.apiKey;
    } else {
      if (!own) throw ctx.fail(403, OWN_NOT_SOLD);
      apiKey = maps.runtimeKey(ctx.state.mapsConfig);
      if (!apiKey) throw ctx.fail(503, NOT_READY);
    }
    const found = await places.searchText({
      apiKey,
      textQuery: marketing.textQuery(criteria),
      pageToken,
      rectangle: criteria.region ? route.regionBounds(criteria.region) : null,
      fetcher,
    });
    // Counted after the response is sent (lib/application.cjs): one paid request.
    res.hanMapsUsage = input.source === 'platform' ? { searches: 1 } : { google: 1 };
    ctx.send(res, 200, {
      ...marketing.annotatePlaces(found.places, criteria, ctx.state, u),
      received: found.places.length,
      nextPageToken: found.nextPageToken,
      ...usageAfter(input.source === 'platform' ? 'platform' : 'google'),
      ...(input.source === 'platform' && Number.isSafeInteger(service.searchesLeft)
        ? { searchesLeft: Math.max(0, service.searchesLeft - 1) }
        : {}),
    });
    return true;
  }

  if (url.pathname === '/api/marketing/scrape') {
    method('POST');
    if (!own) throw ctx.fail(403, OWN_NOT_SOLD);
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
      geo: criteria.region ? marketing.regionGeo(criteria.region) : null,
      fetcher,
    });
    res.hanMapsUsage = { scraper: 1 };
    ctx.send(res, 202, { jobId, depth, ...usageAfter('scraper') });
    return true;
  }

  if (url.pathname === '/api/marketing/scrape-status') {
    method('POST');
    if (!own) throw ctx.fail(403, OWN_NOT_SOLD);
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
    // Scraped routes carry their own copy; Google routes refresh with the key of the
    // source that found them.
    let apiKey = '';
    if (saved.source === 'platform') {
      if (service?.apiKey && service.detailsLeft < saved.stops.length) throw ctx.fail(429, DETAILS_QUOTA);
      apiKey = service?.apiKey || '';
    } else if (saved.source !== 'scraper') apiKey = own ? maps.runtimeKey(ctx.state.mapsConfig) : '';
    const result = await marketing.routePlaces(ctx.state, u, input, { apiKey, fetcher });
    if (saved.source === 'platform') res.hanMapsUsage = { details: saved.stops.length };
    ctx.send(res, 200, result);
    return true;
  }

  if (url.pathname === '/api/marketing/routes') {
    method('POST');
    const { route: saved, next } = marketing.saveRoute(ctx.state, u, await ctx.body(req), config.sectors);
    if (next) {
      markRecord(undefined, saved, u);
      ctx.persistMetadata(next);
    }
    ctx.send(res, next ? 201 : 200, { route: marketing.routeSummary(saved, next || ctx.state) });
    return true;
  }

  throw ctx.fail(404, 'İşlem bulunamadı.');
}

module.exports = { handleMarketingRoutes };
