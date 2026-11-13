// The selling company's map service: Rota Bulma sold as a monthly subscription that searches
// on the platform's own Google account, next to the module that runs on the office's own keys.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createModuleGate } = require('../lib/saas/module-gate.cjs');
const { createPlatformAdmin } = require('../lib/saas/platform-auth.cjs');
const { createPlatformHandler } = require('../lib/platform-app.cjs');
const platformMaps = require('../lib/saas/platform-maps.cjs');
const platform = require('../lib/saas/platform.cjs');
const profit = require('../lib/saas/profit.cjs');
const places = require('../lib/google-places.cjs');

process.env.PLATFORM_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
// Synthetic keys in Google's format. They are never sent anywhere: every fetch is stubbed.
const SERVICE_KEY = 'AIza' + 'S'.repeat(35);
const BROWSER_KEY = 'AIza' + 'B'.repeat(35);
const opPassword = 'Synthetic-Platform-Maps-Test!';

const openOffice = async (pool, op, slug, moduleCodes = []) =>
  (
    await platform.openOffice(pool, op, {
      slug,
      name: slug.toUpperCase(),
      admin: { name: 'Y', username: slug, password: opPassword },
      userCount: 2,
      userPriceKurus: 1000,
      termMonths: 1,
      moduleCodes,
      paid: true,
    })
  ).office;

test('map service settings: the Places key is sealed, the map key is separate, limits are per office and month', async () => {
  const { pg, pool } = await database();
  try {
    const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Op', password: opPassword })).id;
    assert.deepEqual(await platformMaps.getSettings(pool), {
      configured: false,
      enabled: false,
      browserKey: '',
      monthlySearches: platformMaps.DEFAULT_LIMITS.monthlySearches,
      monthlyDetails: platformMaps.DEFAULT_LIMITS.monthlyDetails,
      updatedAt: null,
      usage: { monthSearches: 0, monthDetails: 0, offices: [] },
    });
    for (const input of [
      { enabled: true },
      { apiKey: 'not-a-key' },
      { apiKey: SERVICE_KEY, browserKey: 'not-a-key' },
      { apiKey: SERVICE_KEY, browserKey: SERVICE_KEY },
      { apiKey: SERVICE_KEY, monthlySearches: 0 },
      { apiKey: SERVICE_KEY, monthlyDetails: 1.5 },
    ])
      await assert.rejects(
        () => platformMaps.saveSettings(pool, op, input),
        (error) => error.status === 400,
        JSON.stringify(input),
      );

    const saved = await platformMaps.saveSettings(pool, op, {
      apiKey: SERVICE_KEY,
      browserKey: BROWSER_KEY,
      monthlySearches: 3,
      monthlyDetails: 5,
      enabled: true,
    });
    assert.deepEqual(
      { ...saved, updatedAt: null },
      { configured: true, enabled: true, browserKey: BROWSER_KEY, monthlySearches: 3, monthlyDetails: 5, updatedAt: null },
    );
    const stored = JSON.stringify((await pool.query("SELECT value FROM han_saas.platform_settings WHERE key = 'maps'")).rows);
    assert.equal(stored.includes(SERVICE_KEY), false, 'the Places key is stored sealed');
    assert.equal(JSON.stringify(await platformMaps.getSettings(pool)).includes(SERVICE_KEY), false);

    // A blank key keeps the saved one; the saved secret is refused as the map key too.
    assert.equal((await platformMaps.saveSettings(pool, op, { monthlySearches: 4 })).monthlySearches, 4);
    await assert.rejects(
      () => platformMaps.saveSettings(pool, op, { browserKey: SERVICE_KEY }),
      (error) => error.status === 400 && /farklı olmalıdır/.test(error.message),
    );
    assert.equal((await platformMaps.saveSettings(pool, op, { browserKey: '' })).browserKey, '');

    const calls = [];
    const fetcher = async (url, init) => {
      calls.push({ url, key: init.headers['X-Goog-Api-Key'], mask: init.headers['X-Goog-FieldMask'] });
      return Response.json({ places: [] });
    };
    assert.deepEqual(await platformMaps.testSettings(pool, {}, { fetcher }), { ok: true });
    assert.deepEqual(calls, [{ url: places.SEARCH_URL, key: SERVICE_KEY, mask: 'places.id' }], 'the free ID-only search');
    await assert.rejects(
      () => platformMaps.testSettings(pool, {}, { fetcher: async () => Response.json({ error: {} }, { status: 403 }) }),
      (error) => error.status === 502,
    );

    const audit = (await pool.query('SELECT action, detail FROM han_saas.platform_audit ORDER BY id')).rows;
    assert.ok(audit.some((row) => row.action === 'settings.maps'));
    assert.equal(JSON.stringify(audit).includes(SERVICE_KEY), false);

    assert.deepEqual(await platformMaps.saveSettings(pool, op, { clear: true }), {
      configured: false,
      enabled: false,
      browserKey: '',
      monthlySearches: platformMaps.DEFAULT_LIMITS.monthlySearches,
      monthlyDetails: platformMaps.DEFAULT_LIMITS.monthlyDetails,
      updatedAt: null,
    });
    await assert.rejects(() => platformMaps.testSettings(pool, {}, { fetcher }), (error) => error.status === 412);
  } finally {
    await pg.close();
  }
});

test('map service for one office: ready while its monthly allowance lasts, counted per office', async () => {
  const { pg, pool } = await database();
  try {
    const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Op', password: opPassword })).id;
    const a = await openOffice(pool, op, 'harita-a');
    const b = await openOffice(pool, op, 'harita-b');
    const serviceA = platformMaps.createPlatformMaps(pool, { tenantId: a.id, cacheMs: 0 });
    const serviceB = platformMaps.createPlatformMaps(pool, { tenantId: b.id, cacheMs: 0 });

    assert.deepEqual(await serviceA.runtime(), { ready: false, reason: 'off', browserKey: '' }, 'nothing configured');
    await platformMaps.saveSettings(pool, op, { apiKey: SERVICE_KEY, monthlySearches: 3, monthlyDetails: 5 });
    assert.equal((await serviceA.runtime()).ready, false, 'saved but not switched on');
    await platformMaps.saveSettings(pool, op, { enabled: true, browserKey: BROWSER_KEY });

    assert.deepEqual(await serviceA.runtime(), {
      ready: true,
      reason: '',
      apiKey: SERVICE_KEY,
      browserKey: BROWSER_KEY,
      monthlySearches: 3,
      searchesLeft: 3,
      monthlyDetails: 5,
      detailsLeft: 5,
    });
    await serviceA.record({ searches: 1 });
    await serviceA.record({ searches: 1, details: 4 });
    await serviceA.record({});
    await serviceA.record({ searches: -3, details: 1.5 });
    const used = await serviceA.runtime();
    assert.deepEqual([used.ready, used.searchesLeft, used.detailsLeft], [true, 1, 1]);
    await serviceA.record({ searches: 1 });
    const empty = await serviceA.runtime();
    assert.deepEqual([empty.ready, empty.reason, empty.searchesLeft], [false, 'quota', 0]);
    assert.equal((await serviceB.runtime()).searchesLeft, 3, 'another office has its own allowance');

    // Last month's searches do not count against this month.
    await pool.query(
      `INSERT INTO han_saas.usage_daily(tenant_id, day, metric, quantity)
       VALUES ($1, (date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Istanbul') - interval '1 day')::date, 'maps_searches', 50)`,
      [b.id],
    );
    assert.equal((await serviceB.runtime()).searchesLeft, 3);
    await serviceB.record({ searches: 2 });

    const settings = await platformMaps.getSettings(pool);
    assert.deepEqual(settings.usage, {
      monthSearches: 5,
      monthDetails: 4,
      offices: [
        { tenantId: a.id, name: 'HARITA-A', searches: 3, details: 4 },
        { tenantId: b.id, name: 'HARITA-B', searches: 2, details: 0 },
      ],
    });

    // Raising the limit opens the service again; switching it off closes it for everyone.
    await platformMaps.saveSettings(pool, op, { monthlySearches: 10 });
    assert.equal((await serviceA.runtime()).searchesLeft, 7);
    await platformMaps.saveSettings(pool, op, { enabled: false });
    assert.deepEqual(await serviceA.runtime(), { ready: false, reason: 'off', browserKey: '' });

    // The control plane cannot be asked: not ready, and metering does not throw.
    const broken = platformMaps.createPlatformMaps(
      { query: async () => Promise.reject(new Error('down')) },
      { tenantId: a.id, cacheMs: 0 },
    );
    const logged = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(await broken.runtime(), { ready: false, reason: 'error', browserKey: '' });
      await broken.record({ searches: 1 });
    } finally {
      console.error = logged;
    }
  } finally {
    await pg.close();
  }
});

test('two products: the subscription opens the service, the module opens the office’s own keys', async (t) => {
  const { pg, pool } = await database();
  await importState(pool, fixture());
  await importRecords(pool);
  await activateRecords(pool);
  const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Op', password: opPassword })).id;

  // The migration seeds the subscription as an unpriced draft that the application enforces.
  const seeded = (await platform.listModules(pool)).find((item) => item.code === 'marketing-routes-service');
  assert.deepEqual(
    [seeded.kind, seeded.status, seeded.active, seeded.monthlyPriceKurus, seeded.gated],
    ['module', 'draft', false, 0, true],
  );
  assert.ok(seeded.features.length >= 3);
  const own = (await platform.listModules(pool)).find((item) => item.code === 'marketing-routes');
  assert.match(own.description, /kendi harita API anahtarını girer/);

  await platform.upsertModule(pool, { code: 'marketing-routes-service', name: 'Rota Bulma harita servisi', monthlyPriceKurus: 90000, status: 'selling' }, op);
  await platform.upsertModule(pool, { code: 'marketing-routes', name: 'Pazarlama ve rota', monthlyPriceKurus: 40000, status: 'selling' }, op);
  const office = await openOffice(pool, op, 'abone');
  await platformMaps.saveSettings(pool, op, { apiKey: SERVICE_KEY, monthlySearches: 2, enabled: true });

  const googleCalls = [];
  const mapsFetch = async (url, init) => {
    googleCalls.push(init.headers['X-Goog-Api-Key']);
    return Response.json({
      places: [
        {
          id: 'ChIJfirma00001',
          displayName: { text: 'Firma' },
          formattedAddress: 'Sk. No:1, 06420 Çankaya/Ankara, Türkiye',
          location: { latitude: 39.92, longitude: 32.85 },
        },
      ],
    });
  };
  // The office's application with the real gate and the real service, bound to that office.
  const app = await serve(
    createApplication({
      store: createStore(pool, { records: true }),
      mapsFetch,
      modules: createModuleGate(pool, { tenantId: office.id, cacheMs: 0 }),
      platformMaps: platformMaps.createPlatformMaps(pool, { tenantId: office.id, cacheMs: 0 }),
    }),
  );
  t.after(async () => {
    await app.close();
    await pg.close();
  });
  const headers = { 'X-Han-Request': '1', 'Content-Type': 'application/json' };
  const login = await fetch(app.url + '/api/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: 'test', password }),
  });
  assert.equal(login.status, 200);
  const authed = { ...headers, cookie: login.headers.get('set-cookie').split(';')[0] };
  const call = async (path, body) => {
    const res = await fetch(app.url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: authed,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  // Sold neither product: Rota Bulma is closed.
  assert.equal((await call('/api/marketing/overview')).status, 403);
  assert.equal((await call('/api/modules')).body['marketing-routes-service'], false);

  // The subscription: searches run on the platform key and are counted for this office.
  await platform.addModule(pool, op, { tenantId: office.id, moduleCode: 'marketing-routes-service', paid: true });
  const overview = (await call('/api/marketing/overview')).body;
  assert.deepEqual(overview.sources, [{ id: 'platform', label: 'Hazır harita servisi (abonelik)', ready: true }]);
  assert.deepEqual(overview.service, { ready: true, monthlySearches: 2, searchesLeft: 2 });
  const found = await call('/api/marketing/search', { city: 'Ankara', source: 'platform' });
  assert.equal(found.status, 200);
  assert.equal(found.body.places[0].district, 'Çankaya', 'read from the address when Google sends no components');
  assert.deepEqual(googleCalls, [SERVICE_KEY]);
  assert.equal((await call('/api/marketing/search', { city: 'Ankara' })).status, 403, 'own keys were not bought');
  assert.equal((await call('/api/marketing/search', { city: 'Ankara', source: 'platform' })).status, 200);
  assert.equal((await call('/api/marketing/search', { city: 'Ankara', source: 'platform' })).status, 429);
  assert.equal(googleCalls.length, 2, 'the allowance stops the third request before Google');
  const usage = (await platformMaps.getSettings(pool)).usage;
  assert.deepEqual(usage.offices, [{ tenantId: office.id, name: 'ABONE', searches: 2, details: 0 }]);

  // The estimated cost of those searches lands on the office and on the subscription product.
  await profit.saveUnitCosts(pool, op, { mapsSearchKurus: 150, mapsDetailKurus: 60 });
  const report = await profit.profitReport(pool);
  const row = report.offices.find((item) => item.tenantId === office.id);
  assert.equal(row.usage.mapsSearches, 2);
  assert.equal(row.usageCost.maps, 300);
  assert.equal(row.usageCostKurus, 300);
  assert.equal(report.products.find((item) => item.code === 'marketing-routes-service').usageCostKurus, 300);

  // The module on top: the office's own source appears beside the service.
  await platform.addModule(pool, op, { tenantId: office.id, moduleCode: 'marketing-routes', paid: true });
  assert.deepEqual(
    (await call('/api/marketing/overview')).body.sources.map((source) => source.id),
    ['platform', 'google', 'scraper'],
  );

  // Removing the subscription leaves the module; removing both closes Rota Bulma.
  await platform.removeModule(pool, op, { tenantId: office.id, moduleCode: 'marketing-routes-service', reason: 'Abonelik bitti' });
  const moduleOnly = (await call('/api/marketing/overview')).body;
  assert.deepEqual(
    moduleOnly.sources.map((source) => source.id),
    ['google', 'scraper'],
  );
  assert.equal(Object.hasOwn(moduleOnly, 'service'), false);
  await platform.removeModule(pool, op, { tenantId: office.id, moduleCode: 'marketing-routes', reason: 'Modül bırakıldı' });
  assert.equal((await call('/api/marketing/overview')).status, 403);
});

test('console HTTP: map service settings need an operator session and never return the Places key', async (t) => {
  const { pg, pool } = await database();
  await createPlatformAdmin(pool, { username: 'root', name: 'Op', password: opPassword });
  const tested = [];
  const server = await serve(
    createPlatformHandler({
      pool,
      secureCookies: false,
      requireTotp: false,
      mapsFetch: async (url, init) => {
        tested.push(init.headers['X-Goog-Api-Key']);
        return Response.json({ places: [] });
      },
    }),
  );
  t.after(async () => {
    await server.close();
    await pg.close();
  });
  const call = async (path, { method = 'GET', body, cookie } = {}) => {
    const res = await fetch(server.url + '/api/platform/' + path, {
      method,
      headers: {
        ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-Han-Request': '1' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json(), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  assert.equal((await call('settings/maps')).status, 401);
  assert.equal((await call('settings/maps', { method: 'POST', body: { apiKey: SERVICE_KEY } })).status, 401);
  assert.equal((await call('settings/maps/test', { method: 'POST', body: {} })).status, 401);
  const cookie = (await call('login', { method: 'POST', body: { username: 'root', password: opPassword } })).cookie;

  // A typed key can be tested before it is saved.
  assert.equal((await call('settings/maps/test', { method: 'POST', cookie, body: { apiKey: SERVICE_KEY } })).status, 200);
  assert.deepEqual(tested, [SERVICE_KEY]);
  assert.equal((await call('settings/maps', { cookie })).json.configured, false, 'testing saves nothing');

  const saved = await call('settings/maps', {
    method: 'POST',
    cookie,
    body: { apiKey: SERVICE_KEY, browserKey: BROWSER_KEY, monthlySearches: 250, monthlyDetails: 2000, enabled: true },
  });
  assert.equal(saved.status, 200);
  assert.equal(JSON.stringify(saved.json).includes(SERVICE_KEY), false);
  const shown = (await call('settings/maps', { cookie })).json;
  assert.deepEqual(
    [shown.configured, shown.enabled, shown.browserKey, shown.monthlySearches, shown.monthlyDetails],
    [true, true, BROWSER_KEY, 250, 2000],
  );
  assert.equal(JSON.stringify(shown).includes(SERVICE_KEY), false);
  assert.equal((await call('settings/maps/test', { method: 'POST', cookie, body: {} })).status, 200, 'the saved key');
  assert.equal((await call('settings/maps', { method: 'POST', cookie, body: { monthlySearches: 0 } })).status, 400);
  const audit = (await call('operators', { cookie })).json.audit.map((entry) => entry.action);
  assert.ok(audit.includes('settings.maps'));
});

test('search counter: an office’s own searches are counted by source and month, beside the service’s', async () => {
  const { pg, pool } = await database();
  try {
    const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Op', password: opPassword })).id;
    const a = await openOffice(pool, op, 'sayac-a');
    const b = await openOffice(pool, op, 'sayac-b');
    const meter = platformMaps.createMapsMeter(pool, { tenantId: a.id });
    assert.deepEqual(await meter.month(), { google: 0, scraper: 0, platform: 0 });
    await meter.record({ google: 1 });
    await meter.record({ google: 1, scraper: 1 });
    await meter.record({ google: -2, scraper: 1.5, searches: 9 });
    await meter.record({});
    // Searches on the selling company's service are written by the service itself.
    await platformMaps.createPlatformMaps(pool, { tenantId: a.id }).record({ searches: 4, details: 30 });
    assert.deepEqual(await meter.month(), { google: 2, scraper: 1, platform: 4 });
    assert.deepEqual(await platformMaps.createMapsMeter(pool, { tenantId: b.id }).month(), { google: 0, scraper: 0, platform: 0 });
    // Last month is not this month.
    await pool.query(
      `UPDATE han_saas.usage_daily SET day = (date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Istanbul') - interval '1 day')::date
       WHERE tenant_id = $1 AND metric = 'maps_own_searches'`,
      [a.id],
    );
    assert.deepEqual(await meter.month(), { google: 0, scraper: 1, platform: 4 });
    // An office's own searches cost the selling company nothing and use none of its allowance.
    assert.equal((await platformMaps.getSettings(pool)).usage.monthSearches, 4);
    const broken = platformMaps.createMapsMeter({ query: async () => Promise.reject(new Error('down')) }, { tenantId: a.id });
    const logged = console.error;
    console.error = () => {};
    try {
      assert.equal(await broken.month(), null);
      await broken.record({ google: 1 });
    } finally {
      console.error = logged;
    }
  } finally {
    await pg.close();
  }
});
