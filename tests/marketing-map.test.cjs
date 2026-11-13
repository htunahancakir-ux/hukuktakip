// Rota Bulma: searching by province only or by a region drawn on the map, narrowing the firms
// found, the map's drawing layer, and the two ways the feature is sold (own keys / map service).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const route = require('../outputs/icrapro/workspace-marketing-route.js');
const maps = require('../lib/maps-settings.cjs');
const places = require('../lib/google-places.cjs');
const scraper = require('../lib/map-scraper.cjs');
const marketing = require('../lib/marketing-routes.cjs');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { database, fixture, serve } = require('./support/postgres.cjs');

// Synthetic keys in Google's format. They are never sent anywhere: every fetch is stubbed.
const OWN_KEY = 'AIza' + 'T'.repeat(35);
const SERVICE_KEY = 'AIza' + 'S'.repeat(35);
const BROWSER_KEY = 'AIza' + 'B'.repeat(35);

// A square around Kızılay, Ankara, about 2 km on each side.
const KIZILAY = [
  [39.93, 32.84],
  [39.93, 32.865],
  [39.91, 32.865],
  [39.91, 32.84],
];

async function withEnvironment(values, work) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    return await work();
  } finally {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

function googlePlace(
  id,
  name,
  { lat = 39.92, lng = 32.85, district = 'Çankaya', city = 'Ankara', ...extra } = {},
) {
  return {
    id,
    displayName: { text: name },
    formattedAddress: `${name} Sk. No:1, 06420 ${district}/${city}, Türkiye`,
    addressComponents: [
      { longText: city, types: ['administrative_area_level_1', 'political'] },
      { longText: district, types: ['administrative_area_level_2', 'political'] },
    ],
    location: { latitude: lat, longitude: lng },
    businessStatus: 'OPERATIONAL',
    ...extra,
  };
}

test('a drawn region is validated, measured, tested for points and built from a freehand stroke', () => {
  assert.equal(route.validRegion(KIZILAY), true);
  for (const bad of [
    null,
    [],
    KIZILAY.slice(0, 2),
    [...KIZILAY, [91, 32]],
    [...KIZILAY, ['39.9', 32.8]],
    // A dot and a line have no area.
    [
      [39.92, 32.85],
      [39.92, 32.85],
      [39.92, 32.85],
    ],
    [
      [39.92, 32.85],
      [39.93, 32.85],
      [39.94, 32.85],
    ],
    Array.from({ length: route.MAX_REGION_POINTS + 1 }, (_, i) => [39.9 + i / 1000, 32.8 + (i % 2) / 100]),
  ])
    assert.equal(route.validRegion(bad), false, JSON.stringify(bad)?.slice(0, 60));

  assert.deepEqual(route.regionBounds(KIZILAY), { south: 39.91, west: 32.84, north: 39.93, east: 32.865 });
  assert.equal(route.pointInRegion({ lat: 39.92, lng: 32.85 }, KIZILAY), true);
  assert.equal(route.pointInRegion({ lat: 39.95, lng: 32.85 }, KIZILAY), false);
  assert.equal(route.pointInRegion({ lat: 39.92, lng: 32.9 }, KIZILAY), false);
  assert.equal(route.pointInRegion({ lat: null, lng: null }, KIZILAY), false, 'no coordinates: never inside');
  // An L-shaped region: the notch is outside although it is inside the bounding box.
  const lShape = [
    [0, 0],
    [0, 0.02],
    [0.01, 0.02],
    [0.01, 0.01],
    [0.02, 0.01],
    [0.02, 0],
  ];
  assert.equal(route.pointInRegion({ lat: 0.005, lng: 0.015 }, lShape), true);
  assert.equal(route.pointInRegion({ lat: 0.015, lng: 0.015 }, lShape), false);

  const circle = route.regionCircle(KIZILAY);
  assert.ok(Math.abs(circle.lat - 39.92) < 1e-9 && Math.abs(circle.lng - 32.8525) < 1e-9);
  assert.ok(circle.radius > 1400 && circle.radius < 1700, String(circle.radius));
  const area = route.regionAreaKm2(KIZILAY);
  assert.ok(area > 4.5 && area < 5, String(area));

  // A stroke of 400 screen points around a circle becomes a polygon with few corners.
  const stroke = Array.from({ length: 400 }, (_, i) => ({
    x: 200 + 120 * Math.cos((i / 400) * 2 * Math.PI),
    y: 200 + 120 * Math.sin((i / 400) * 2 * Math.PI),
  }));
  const simple = route.simplifyPath(stroke, 3);
  assert.ok(simple.length >= 8 && simple.length < 60, String(simple.length));
  // 1 screen pixel = 0.0001°, the top-left corner is 39.95 N 32.80 E.
  const toLatLng = ({ x, y }) => ({ lat: 39.95 - y / 10000, lng: 32.8 + x / 10000 });
  const region = route.strokeToRegion(stroke, toLatLng);
  assert.ok(route.validRegion(region));
  assert.ok(region.length <= route.MAX_REGION_POINTS);
  assert.equal(route.pointInRegion(toLatLng({ x: 200, y: 200 }), region), true, 'the centre is inside');
  assert.equal(route.pointInRegion(toLatLng({ x: 380, y: 380 }), region), false);
  assert.equal(
    route.strokeToRegion(
      [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
        { x: 3, y: 1 },
      ],
      toLatLng,
    ),
    null,
    'a tiny scribble is not a region',
  );

  assert.deepEqual(route.areaFromAddress('Atatürk Blv. No:1, 06420 Çankaya/Ankara, Türkiye'), {
    city: 'Ankara',
    district: 'Çankaya',
  });
  assert.deepEqual(route.areaFromAddress('adres yok'), { city: '', district: '' });
});

test('found firms are narrowed by district, excluded words and the drawn region', () => {
  const firms = [
    { placeId: 'a', name: 'Alfa Mobilya', district: 'Çankaya', lat: 39.92, lng: 32.85 },
    { placeId: 'b', name: 'Beta AVM Mobilya', district: 'Çankaya', lat: 39.921, lng: 32.851 },
    { placeId: 'c', name: 'Ceren Mobilya Şubesi', district: 'Keçiören', lat: 39.99, lng: 32.86 },
    { placeId: 'd', name: 'Delta Mobilya', district: 'KEÇİÖREN', lat: 39.98, lng: 32.87 },
    { placeId: 'e', name: 'Konumsuz Mobilya', district: '', lat: null, lng: null },
  ];
  const ids = (filters, region = null) =>
    route.filterPlaces(firms, filters, null, region).map((place) => place.placeId);
  assert.deepEqual(ids({}), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(ids({ district: 'Keçiören' }), ['c', 'd'], 'district names compare folded');
  assert.deepEqual(ids({ exclude: 'avm, şube' }), ['a', 'd', 'e']);
  assert.deepEqual(ids({ exclude: ' ; ,' }), ['a', 'b', 'c', 'd', 'e'], 'empty words exclude nothing');
  assert.deepEqual(ids({}, KIZILAY), ['a', 'b'], 'a firm without coordinates is outside every region');
  assert.deepEqual(ids({ exclude: 'avm' }, KIZILAY), ['a']);
  assert.deepEqual(route.districtCounts(firms), [
    { name: 'Çankaya', count: 2 },
    { name: 'Keçiören', count: 2 },
  ]);
});

test('a search needs only a place: a province, a district in it, or a drawn region', () => {
  const sectors = maps.publicConfig({}).sectors;
  const query = (input) => marketing.textQuery(marketing.criteria(input, sectors));
  assert.equal(query({ city: 'Ankara' }), 'firmalar Ankara', 'only the province');
  assert.equal(query({ city: 'Ankara', district: 'Çankaya' }), 'firmalar Çankaya Ankara');
  assert.equal(query({ sector: 'mobilya', city: 'Ankara' }), 'mobilya mağazası Ankara');
  assert.equal(query({ sector: 'mobilya', region: KIZILAY }), 'mobilya mağazası', 'only a drawn region');
  assert.equal(query({ region: KIZILAY }), 'firmalar');
  const everything = marketing.criteria({ city: 'Ankara' }, sectors);
  assert.equal(everything.sector, '');
  assert.equal(everything.sectorLabel, 'Tüm firmalar');
  assert.equal(Object.hasOwn(everything, 'region'), false);
  assert.deepEqual(marketing.criteria({ region: KIZILAY, sector: 'mobilya' }, sectors).region, KIZILAY);
  assert.deepEqual(
    marketing.criteria({ region: KIZILAY.map(([lat, lng]) => [lat + 0.0000004, lng]) }, sectors).region,
    KIZILAY,
    'corners are rounded to about a metre',
  );
  assert.equal(
    marketing.areaLabel(marketing.criteria({ region: KIZILAY }, sectors)),
    'Haritada çizilen bölge',
  );

  for (const input of [
    {},
    { sector: 'mobilya' },
    { district: 'Çankaya' },
    { district: 'Çankaya', region: KIZILAY },
    { city: 'Ankara', district: 'Kadıköy' },
    { city: 'Atlantis', region: KIZILAY },
    { city: 'Ankara', region: KIZILAY.slice(0, 2) },
    { city: 'Ankara', region: 'Ankara' },
    { city: 'Ankara', region: [...KIZILAY, [39.9, '32.8']] },
    { city: 'Ankara', sector: 'unknown' },
  ])
    assert.throws(
      () => marketing.criteria(input, sectors),
      (error) => error.code === 400,
      JSON.stringify(input),
    );

  const geo = marketing.regionGeo(KIZILAY);
  assert.ok(geo.zoom >= 10 && geo.zoom <= 17, String(geo.zoom));
  assert.ok(geo.radius > 1400 && geo.radius < 1700);

  // Province only: firms keep their district name and none counts as "outside the district".
  const state = {
    data: { 'icrapro-personnel-v1': [] },
    marketingProspects: [
      {
        createdBy: 'me',
        company: 'Kule Mobilya',
        district: 'Keçiören',
        date: '2026-11-03',
        staffName: 'Ben',
      },
    ],
  };
  const user = { id: 'me', role: 'staff' };
  const wide = marketing.annotatePlaces(
    [
      googlePlace('ChIJcankaya001', 'Merkez Mobilya'),
      googlePlace('ChIJkecioren01', 'Kule Mobilya', { district: 'Keçiören', lat: 39.99, lng: 32.86 }),
      googlePlace('ChIJistanbul01', 'Uzak Mobilya', { city: 'İstanbul', district: 'Kadıköy' }),
    ],
    marketing.criteria({ city: 'Ankara' }, sectors),
    state,
    user,
  );
  assert.equal(wide.outside, 1, 'another province is still dropped');
  assert.deepEqual(
    wide.places.map((place) => [place.placeId, place.district, place.inDistrict]),
    [
      ['ChIJcankaya001', 'Çankaya', null],
      ['ChIJkecioren01', 'Keçiören', null],
    ],
  );
  assert.equal(wide.places[1].visit.status, 'visited', 'the name is matched in the firm’s own district');
  assert.equal(wide.places[0].visit, null);
  assert.equal(Object.hasOwn(wide.places[0], 'city'), false);

  // Region only: what lies outside the drawing is dropped, whichever province it is in.
  const drawn = marketing.annotatePlaces(
    [
      googlePlace('ChIJinside0001', 'İçeride'),
      googlePlace('ChIJoutside001', 'Dışarıda', { lat: 39.99, lng: 32.86 }),
      googlePlace('ChIJnowhere001', 'Konumsuz', { location: undefined }),
    ],
    marketing.criteria({ region: KIZILAY }, sectors),
    state,
    user,
  );
  assert.deepEqual(
    drawn.places.map((place) => place.placeId),
    ['ChIJinside0001'],
  );
  assert.equal(drawn.outside, 2);
});

test('map services receive the drawn region: a Google rectangle, a point and zoom for the tarama sunucusu', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
    return Response.json(url.includes('/api/v1/jobs') ? { id: crypto.randomUUID() } : { places: [] });
  };
  await places.searchText({
    apiKey: OWN_KEY,
    textQuery: 'mobilya mağazası',
    rectangle: route.regionBounds(KIZILAY),
    fetcher,
  });
  assert.deepEqual(calls[0].body.locationRestriction, {
    rectangle: {
      low: { latitude: 39.91, longitude: 32.84 },
      high: { latitude: 39.93, longitude: 32.865 },
    },
  });
  await places.searchText({ apiKey: OWN_KEY, textQuery: 'mobilya mağazası Ankara', fetcher });
  assert.equal(Object.hasOwn(calls[1].body, 'locationRestriction'), false, 'no region, no restriction');

  await scraper.createJob({
    url: 'https://tarama.example.test',
    keywords: 'mobilya mağazası',
    geo: marketing.regionGeo(KIZILAY),
    fetcher,
  });
  const job = calls[2].body;
  assert.equal(job.lat, '39.920000');
  assert.equal(job.lon, '32.852500');
  assert.ok(job.zoom >= 10 && job.zoom <= 17);
  assert.ok(Number.isInteger(job.radius) && job.radius > 1400);
  await scraper.createJob({ url: 'https://tarama.example.test', keywords: 'mobilya Ankara', fetcher });
  assert.equal(calls[3].body.zoom, 15);
  assert.equal(Object.hasOwn(calls[3].body, 'lat'), false);
});

test('the map key is a second, public key: saved as it is and never the secret Places key', async () => {
  await withEnvironment({ MAPS_ENCRYPTION_KEY: 'b'.repeat(64) }, async () => {
    assert.deepEqual(maps.publicConfig({}).map, { provider: 'osm' });
    const saved = maps.configure({}, { enabled: true, apiKey: OWN_KEY, browserKey: BROWSER_KEY });
    assert.equal(saved.browserKey, BROWSER_KEY);
    assert.deepEqual(maps.publicConfig(saved).map, { provider: 'google', key: BROWSER_KEY });
    assert.equal(JSON.stringify(maps.publicConfig(saved)).includes(OWN_KEY), false);
    // Leaving the field out keeps the key; an empty field removes it.
    assert.equal(maps.configure(saved, { enabled: true }).browserKey, BROWSER_KEY);
    assert.equal(maps.configure(saved, { enabled: true, browserKey: '' }).browserKey, '');
    for (const input of [
      { enabled: true, apiKey: OWN_KEY, browserKey: OWN_KEY },
      { enabled: true, browserKey: 'not-a-key' },
    ])
      assert.throws(
        () => maps.configure({}, input),
        (error) => error.code === 400,
      );
    assert.throws(
      () => maps.configure(saved, { enabled: true, browserKey: OWN_KEY }),
      (error) => error.code === 400 && /farklı olmalıdır/.test(error.message),
      'the saved secret key is refused as the map key too',
    );
  });
});

test('saved routes keep the drawn region and name routes without a district or province', () => {
  const sectors = maps.publicConfig({}).sectors;
  const state = { data: { 'icrapro-personnel-v1': [] }, marketingRoutes: [] };
  const user = { id: 'me', name: 'Ben', role: 'staff' };
  const save = (input) =>
    marketing.saveRoute(
      state,
      user,
      { requestId: crypto.randomUUID(), stops: ['ChIJinside0001'], ...input },
      sectors,
    ).route;
  const drawn = save({ sector: 'mobilya', region: KIZILAY, source: 'platform' });
  assert.equal(drawn.name, 'Mobilya · Çizilen bölge');
  assert.deepEqual(drawn.region, KIZILAY);
  assert.equal(drawn.source, 'platform');
  assert.equal(drawn.city, '');
  const summary = marketing.routeSummary(drawn, state);
  assert.equal(summary.drawn, true);
  assert.equal(Object.hasOwn(summary, 'region'), false);
  assert.equal(save({ city: 'Ankara' }).name, 'Tüm firmalar · Ankara');
  assert.equal(
    save({ sector: 'mobilya', city: 'Ankara', district: 'Çankaya' }).name,
    'Mobilya · Çankaya / Ankara',
  );
  assert.equal(marketing.routeSummary(save({ city: 'Ankara' }), state).drawn, false);
});

// --- Over HTTP: the two ways Rota Bulma is sold -------------------------------------------

async function office(t, { modules, platformMaps } = {}) {
  const { pg, pool } = await database();
  const state = fixture();
  state.mapsConfig = maps.configure({}, { enabled: true, apiKey: OWN_KEY, browserKey: BROWSER_KEY });
  await importState(pool, state);
  await importRecords(pool);
  await activateRecords(pool);
  const googleCalls = [];
  const mapsFetch = async (url, init) => {
    googleCalls.push({
      url,
      key: init.headers['X-Goog-Api-Key'],
      body: init.body ? JSON.parse(init.body) : null,
    });
    if (url.startsWith(places.DETAILS_URL)) {
      const id = decodeURIComponent(url.slice(places.DETAILS_URL.length).split('?')[0]);
      return Response.json({
        id,
        displayName: { text: 'Güncel ' + id },
        formattedAddress: 'Adres',
        location: { latitude: 39.92, longitude: 32.85 },
      });
    }
    return Response.json({
      places: [
        googlePlace('ChIJinside0001', 'İçeride Mobilya'),
        googlePlace('ChIJoutside001', 'Dışarıda Mobilya', { district: 'Keçiören', lat: 39.99, lng: 32.86 }),
      ],
    });
  };
  const app = await serve(
    createApplication({ store: createStore(pool, { records: true }), mapsFetch, modules, platformMaps }),
  );
  t.after(async () => {
    await app.close();
    await pg.close();
  });
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,'test-ceo','desktop',$2)",
    [crypto.createHash('sha256').update(token).digest('hex'), Date.now() + 600000],
  );
  const headers = {
    cookie: 'han_session=' + token,
    'X-Han-Request': '1',
    'Content-Type': 'application/json',
  };
  const call = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(app.url + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return { call, googleCalls };
}

const gate = (codes) => ({
  enabled: async (code) => codes.includes(code),
  all: async () =>
    Object.fromEntries(
      ['voip', 'ai-assistant', 'whatsapp', 'marketing-routes', 'marketing-routes-service'].map((code) => [
        code,
        codes.includes(code),
      ]),
    ),
});

// The selling company's map service as the application sees it (lib/saas/platform-maps.cjs).
function fakeService({ searchesLeft = 5, detailsLeft = 100, off = false } = {}) {
  const recorded = [];
  return {
    recorded,
    left: () => searchesLeft,
    async runtime() {
      if (off) return { ready: false, reason: 'off', browserKey: '' };
      return {
        ready: searchesLeft > 0,
        reason: searchesLeft > 0 ? '' : 'quota',
        apiKey: SERVICE_KEY,
        browserKey: '',
        monthlySearches: 5,
        searchesLeft,
        monthlyDetails: 100,
        detailsLeft,
      };
    },
    async record(usage) {
      recorded.push(usage);
      searchesLeft -= usage.searches || 0;
      detailsLeft -= usage.details || 0;
    },
  };
}

test('own keys over HTTP: province-only and drawn-region searches, the district of each firm, the map key', async (t) => {
  await withEnvironment({ MAPS_ENCRYPTION_KEY: 'b'.repeat(64) }, async () => {
    const { call, googleCalls } = await office(t);
    const overview = (await call('/api/marketing/overview')).body;
    assert.deepEqual(overview.map, { provider: 'google', key: BROWSER_KEY });
    assert.equal(Object.hasOwn(overview, 'service'), false);
    assert.deepEqual(
      overview.sources.map((source) => [source.id, source.ready]),
      [
        ['google', true],
        ['scraper', false],
      ],
    );
    assert.equal(JSON.stringify(overview).includes(OWN_KEY), false);

    const wide = await call('/api/marketing/search', { city: 'Ankara' });
    assert.equal(wide.status, 200);
    assert.equal(googleCalls.at(-1).body.textQuery, 'firmalar Ankara');
    assert.equal(googleCalls.at(-1).key, OWN_KEY);
    assert.deepEqual(
      wide.body.places.map((place) => place.district),
      ['Çankaya', 'Keçiören'],
    );

    const drawn = await call('/api/marketing/search', { sector: 'mobilya', region: KIZILAY });
    assert.equal(drawn.status, 200);
    assert.equal(googleCalls.at(-1).body.textQuery, 'mobilya mağazası');
    assert.deepEqual(googleCalls.at(-1).body.locationRestriction.rectangle.low, {
      latitude: 39.91,
      longitude: 32.84,
    });
    assert.deepEqual(
      drawn.body.places.map((place) => place.placeId),
      ['ChIJinside0001'],
    );
    assert.equal(drawn.body.outside, 1);

    const nothing = await call('/api/marketing/search', { sector: 'mobilya' });
    assert.equal(nothing.status, 400);
    assert.match(nothing.body.error, /il seçin veya haritada bir bölge çizin/);
    assert.equal((await call('/api/marketing/search', { city: 'Ankara', source: 'platform' })).status, 403);

    const saved = await call('/api/marketing/routes', {
      requestId: crypto.randomUUID(),
      sector: 'mobilya',
      region: KIZILAY,
      stops: ['ChIJinside0001'],
    });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.route.drawn, true);
    assert.equal(saved.body.route.name, 'Mobilya · Çizilen bölge');
    assert.equal(Object.hasOwn(saved.body.route, 'region'), false);
  });
});

test('map service over HTTP: a subscribed office searches on the platform key, within its monthly allowance', async (t) => {
  await withEnvironment({ MAPS_ENCRYPTION_KEY: 'b'.repeat(64) }, async () => {
    // Subscription only: the office did not buy the module that runs on its own keys.
    const service = fakeService({ searchesLeft: 2 });
    const { call, googleCalls } = await office(t, {
      modules: gate(['marketing-routes-service']),
      platformMaps: service,
    });
    assert.equal((await call('/api/modules')).body['marketing-routes-service'], true);
    const overview = (await call('/api/marketing/overview')).body;
    assert.deepEqual(overview.sources, [
      { id: 'platform', label: 'Hazır harita servisi (abonelik)', ready: true },
    ]);
    assert.equal(overview.defaultSource, 'platform');
    assert.equal(overview.canConfigure, false);
    assert.deepEqual(overview.service, { ready: true, monthlySearches: 5, searchesLeft: 2 });
    assert.deepEqual(overview.map, { provider: 'osm' }, 'the office’s own map key belongs to the module');
    assert.equal(
      JSON.stringify(overview).includes(SERVICE_KEY),
      false,
      'the platform key never reaches the office',
    );

    const first = await call('/api/marketing/search', { city: 'Ankara', source: 'platform' });
    assert.equal(first.status, 200);
    assert.equal(googleCalls.at(-1).key, SERVICE_KEY);
    assert.equal(first.body.searchesLeft, 1);
    assert.deepEqual(service.recorded, [{ searches: 1 }]);

    // Its own key is not part of what it bought.
    for (const [path, body] of [
      ['/api/marketing/search', { city: 'Ankara' }],
      ['/api/marketing/scrape', { city: 'Ankara' }],
      ['/api/marketing/test', {}],
    ]) {
      const refused = await call(path, body);
      assert.equal(refused.status, 403, path);
    }
    assert.equal(googleCalls.length, 1, 'refused requests never reach Google');

    assert.equal((await call('/api/marketing/search', { region: KIZILAY, source: 'platform' })).status, 200);
    const exhausted = await call('/api/marketing/search', { city: 'Ankara', source: 'platform' });
    assert.equal(exhausted.status, 429);
    assert.match(exhausted.body.error, /arama hakkınız doldu \(5 arama\)/);
    assert.equal(googleCalls.length, 2, 'no request on the platform key beyond the allowance');
    const after = (await call('/api/marketing/overview')).body;
    assert.equal(after.sources[0].ready, false);
    assert.match(after.service.message, /arama hakkınız doldu/);

    // A saved route refreshes its firms on the platform key and is counted per firm.
    const saved = await call('/api/marketing/routes', {
      requestId: crypto.randomUUID(),
      city: 'Ankara',
      source: 'platform',
      stops: ['ChIJinside0001', 'ChIJoutside001'],
    });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.route.source, 'platform');
    const opened = await call('/api/marketing/route-places', { routeId: saved.body.route.id });
    assert.equal(opened.status, 200);
    assert.equal(googleCalls.at(-1).key, SERVICE_KEY);
    assert.deepEqual(service.recorded.at(-1), { details: 2 });

    // The settings page offers the sector list only; saved keys stay untouched.
    const config = (await call('/api/marketing/config')).body;
    assert.equal(config.ownKeys, false);
    assert.equal(config.service, true);
    const edited = await call(
      '/api/marketing/config',
      { sectors: [{ label: 'Perde', query: 'perde mağazası' }], apiKey: SERVICE_KEY, clearApiKey: true },
      'PUT',
    );
    assert.equal(edited.status, 200);
    assert.deepEqual(
      edited.body.sectors.map((sector) => sector.label),
      ['Perde'],
    );
    assert.equal(edited.body.apiKeySaved, true, 'key fields in the request are ignored');
  });
});

test('map service over HTTP: both products together, a service that is off, and no product at all', async (t) => {
  await withEnvironment({ MAPS_ENCRYPTION_KEY: 'b'.repeat(64) }, async () => {
    const both = await office(t, {
      modules: gate(['marketing-routes', 'marketing-routes-service']),
      platformMaps: fakeService(),
    });
    const overview = (await both.call('/api/marketing/overview')).body;
    assert.deepEqual(
      overview.sources.map((source) => source.id),
      ['platform', 'google', 'scraper'],
    );
    assert.equal(overview.defaultSource, 'google', 'the office’s own choice stays the default');
    assert.equal(overview.canConfigure, true);
    assert.deepEqual(overview.map, { provider: 'google', key: BROWSER_KEY });
    assert.equal((await both.call('/api/marketing/search', { city: 'Ankara' })).status, 200);
    assert.equal(both.googleCalls.at(-1).key, OWN_KEY);
    assert.equal(
      (await both.call('/api/marketing/search', { city: 'Ankara', source: 'platform' })).status,
      200,
    );
    assert.equal(both.googleCalls.at(-1).key, SERVICE_KEY);

    const off = await office(t, {
      modules: gate(['marketing-routes-service']),
      platformMaps: fakeService({ off: true }),
    });
    const closed = (await off.call('/api/marketing/overview')).body;
    assert.equal(closed.sources[0].ready, false);
    assert.match(closed.service.message, /şu anda kullanılamıyor/);
    assert.equal(
      (await off.call('/api/marketing/search', { city: 'Ankara', source: 'platform' })).status,
      503,
    );
    assert.equal(off.googleCalls.length, 0);

    // The module alone: the selling company's service is not offered and cannot be used.
    const service = fakeService();
    const moduleOnly = await office(t, { modules: gate(['marketing-routes']), platformMaps: service });
    assert.equal(Object.hasOwn((await moduleOnly.call('/api/marketing/overview')).body, 'service'), false);
    assert.equal(
      (await moduleOnly.call('/api/marketing/search', { city: 'Ankara', source: 'platform' })).status,
      403,
    );
    assert.deepEqual(service.recorded, []);

    const none = await office(t, { modules: gate([]), platformMaps: fakeService() });
    const refused = await none.call('/api/marketing/overview');
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /modülü bu büroda etkin değil/);
  });
});

// --- In the browser -------------------------------------------------------------------------

// A flat stand-in for a base map: 1 screen pixel = 0.0001°, top-left corner 39.95 N 32.80 E.
function fakeBase(provider = 'osm') {
  const listeners = [];
  const calls = [];
  return {
    provider,
    calls,
    toPixel: ({ lat, lng }) => ({ x: (lng - 32.8) * 10000, y: (39.95 - lat) * 10000 }),
    toLatLng: ({ x, y }) => ({ lat: 39.95 - y / 10000, lng: 32.8 + x / 10000 }),
    onChange: (listener) => listeners.push(listener),
    fit: (bounds) => calls.push(['fit', bounds]),
    setView: (view) => calls.push(['setView', view]),
    view: () => ({ lat: 39.92, lng: 32.85, zoom: 13 }),
    bounds: () => ({ south: 39.9, west: 32.8, north: 39.95, east: 32.9 }),
    resize() {},
    destroy: () => calls.push(['destroy']),
  };
}

function browser() {
  const dom = new JSDOM('<div id="content"></div><div id="map"></div>', {
    url: 'https://example.test',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.eval(fs.readFileSync('outputs/icrapro/workspace-marketing-route.js', 'utf8'));
  w.eval(fs.readFileSync('outputs/icrapro/workspace-marketing-map.js', 'utf8'));
  const pointer = (target, type, x, y) =>
    target.dispatchEvent(
      new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }),
    );
  // Press, go round a circle of radius 120 px centred on (300, 300), release.
  const drawCircle = (capture) => {
    pointer(capture, 'pointerdown', 420, 300);
    for (let i = 1; i <= 120; i++)
      pointer(
        capture,
        'pointermove',
        300 + 120 * Math.cos((i / 120) * 2 * Math.PI),
        300 + 120 * Math.sin((i / 120) * 2 * Math.PI),
      );
    pointer(capture, 'pointerup', 420, 300);
  };
  return { w, pointer, drawCircle };
}

test('the map layer turns a freehand stroke into a region and shows firms as dots that can be clicked', async () => {
  const { w, pointer, drawCircle } = browser();
  try {
    const events = [];
    const base = fakeBase();
    const map = await w.HanMarketingMap.create(w.document.getElementById('map'), {
      base,
      onRegion: (region) => events.push(['region', region]),
      onToggle: (id) => events.push(['toggle', id]),
      onDrawProblem: (kind) => events.push(['problem', kind]),
    });
    const box = w.document.getElementById('map');
    const layer = box.querySelector('svg.marketing-map-overlay');
    const capture = layer.querySelector('.marketing-map-capture');

    // Outside drawing mode the layer ignores the pointer, so the map can be dragged.
    drawCircle(capture);
    assert.deepEqual(events, []);

    map.startDraw();
    assert.equal(map.drawing, true);
    assert.ok(layer.classList.contains('drawing'));
    pointer(capture, 'pointerdown', 100, 100);
    pointer(capture, 'pointerup', 100, 100);
    assert.deepEqual(events, [['problem', 'short']], 'a tap is not a region');
    assert.equal(map.drawing, true, 'drawing mode stays on after a failed stroke');

    drawCircle(capture);
    assert.equal(map.drawing, false, 'a finished region ends drawing mode');
    const [kind, region] = events.at(-1);
    assert.equal(kind, 'region');
    assert.ok(w.HanMarketingRoute.validRegion(region));
    assert.equal(w.HanMarketingRoute.pointInRegion(base.toLatLng({ x: 300, y: 300 }), region), true);
    assert.equal(w.HanMarketingRoute.pointInRegion(base.toLatLng({ x: 500, y: 500 }), region), false);
    assert.equal(
      layer.querySelector('.marketing-map-region').getAttribute('points').split(' ').length,
      region.length,
    );
    assert.equal(layer.querySelector('.marketing-map-stroke').getAttribute('points'), '');

    map.setPins([
      { placeId: 'a', lat: 39.92, lng: 32.83, name: 'Alfa <b>', status: 'new', selected: false },
      { placeId: 'b', lat: 39.91, lng: 32.84, name: 'Beta', status: 'visited', selected: true },
    ]);
    const pins = [...layer.querySelectorAll('.marketing-pin')];
    assert.deepEqual(
      pins.map((pin) => [
        pin.getAttribute('data-place'),
        pin.getAttribute('class'),
        pin.getAttribute('transform'),
      ]),
      [
        ['a', 'marketing-pin new', 'translate(300.0,300.0)'],
        ['b', 'marketing-pin visited selected', 'translate(400.0,400.0)'],
      ],
    );
    assert.equal(pins[0].querySelector('title').textContent, 'Alfa <b>', 'names are text, never markup');
    assert.equal(layer.querySelectorAll('b').length, 0);
    pointer(pins[0].querySelector('circle'), 'click', 300, 300);
    assert.deepEqual(events.at(-1), ['toggle', 'a']);
    map.highlight('b');
    assert.ok(pins[1].classList.contains('hover') && !pins[0].classList.contains('hover'));

    // Escape leaves drawing mode without a region.
    map.startDraw();
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(map.drawing, false);
    assert.deepEqual(events.at(-1), ['problem', 'cancelled']);

    const viewport = map.viewportRegion();
    assert.ok(w.HanMarketingRoute.validRegion(viewport) && viewport.length === 4);
    map.fitRegion(region);
    assert.equal(base.calls.at(-1)[0], 'fit');
    assert.equal(map.focusCity('ankara'), true);
    // Copied out of the page's realm so deepEqual compares plain values.
    assert.deepEqual(JSON.parse(JSON.stringify(base.calls.at(-1))), [
      'setView',
      { lat: 39.93, lng: 32.86, zoom: 11 },
    ]);
    assert.equal(map.focusCity('Atlantis'), false);
    map.setRegion(null);
    assert.equal(layer.querySelector('.marketing-map-region').getAttribute('visibility'), 'hidden');
    map.destroy();
    assert.equal(box.childElementCount, 0);
    assert.deepEqual(base.calls.at(-1), ['destroy']);
  } finally {
    w.close();
  }
});

test('every province has a centre for the map', () => {
  const { w } = browser();
  try {
    const districts = require('../outputs/icrapro/districts.js');
    for (const city of Object.keys(districts)) {
      const view = w.HanMarketingMap.cityView(city);
      assert.ok(view, city);
      // Inside Turkey's bounding box.
      assert.ok(view.lat > 35.8 && view.lat < 42.2 && view.lng > 25.6 && view.lng < 44.9, city);
    }
    assert.equal(Object.keys(w.HanMarketingMap.CITY_CENTERS).length, Object.keys(districts).length);
  } finally {
    w.close();
  }
});

// The Rota Bulma page with the map layer on a fake base map.
async function routePage({ overview = {}, places: found, provider = 'osm' }) {
  const { w, drawCircle } = browser();
  const requests = [];
  w.Response = Response;
  w.eval(fs.readFileSync('outputs/icrapro/html-safety.js', 'utf8'));
  w.eval(`
    var $ = (selector) => document.querySelector(selector);
    var esc = escapeHtml;
    var toasts = [];
    function toast(text) { toasts.push(text); }
    function render() {}
    var page = 'marketing';
    var settingsTab = 'firm';
    var hanAuth = { role: 'staff', name: 'Satış', staffId: 'p' };
    var turkeyDistricts = { Ankara: ['Çankaya', 'Keçiören'] };
    function clientCityField(c, prefix) {
      return '<div class="field"><label for="' + prefix + 'City">İl *</label><input id="' + prefix + 'City" name="city" required></div>' +
        '<div class="field"><label for="' + prefix + 'District">İlçe *</label><input id="' + prefix + 'District" name="district" required></div>';
    }
    function setupClientCity() {}
    function setupClientDistrict() {}
  `);
  // The page creates its map through HanMarketingMap.create; hand it the fake base map.
  const base = fakeBase(provider);
  const create = w.HanMarketingMap.create;
  w.HanMarketingMap.create = (container, options) => create(container, { ...options, base });
  w.authApi = (url, method = 'GET', data) => {
    requests.push({ url, method, data: data === undefined ? undefined : JSON.parse(JSON.stringify(data)) });
    if (url === '/api/marketing/overview')
      return {
        ready: true,
        canConfigure: false,
        selfPhone: '',
        sectors: [{ id: 'mobilya', label: 'Mobilya' }],
        office: { city: 'Ankara', district: 'Çankaya', address: '' },
        visitResults: route.VISIT_RESULTS,
        routes: [],
        map: { provider },
        ...overview,
      };
    throw Error('unexpected ' + url);
  };
  w.fetch = async (url, init) => {
    requests.push({ url, method: init.method, data: JSON.parse(init.body) });
    return Response.json({ places: found, outside: 0, nextPageToken: '', searchesLeft: 41 });
  };
  w.eval(fs.readFileSync('outputs/icrapro/workspace-marketing.js', 'utf8'));
  const doc = w.document;
  const settle = async (done) => {
    for (let i = 0; i < 80 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(done(), 'page updated');
  };
  const change = (element, value) => {
    if (element.type === 'checkbox') element.checked = value;
    else element.value = value;
    element.dispatchEvent(new w.Event(element.type === 'search' ? 'input' : 'change', { bubbles: true }));
  };
  w.openMarketingRouteFinder();
  await settle(() => !!doc.querySelector('#marketingMap svg.marketing-map-overlay'));
  const rows = () =>
    [...doc.querySelectorAll('#marketingRows tr[data-place]')].map((row) => row.dataset.place);
  const pins = () =>
    [...doc.querySelectorAll('#marketingMap .marketing-pin')].map((pin) => pin.getAttribute('data-place'));
  return { w, doc, requests, settle, change, drawCircle, rows, pins, base };
}

const FOUND = [
  {
    placeId: 'ChIJinside0001',
    name: 'İçeride Mobilya',
    address: 'A',
    district: 'Çankaya',
    phone: '',
    lat: 39.92,
    lng: 32.83,
  },
  {
    placeId: 'ChIJavm0000001',
    name: 'Kule AVM Mobilya',
    address: 'B',
    district: 'Çankaya',
    phone: '',
    lat: 39.921,
    lng: 32.831,
  },
  {
    placeId: 'ChIJoutside001',
    name: 'Uzak Mobilya',
    address: 'C',
    district: 'Keçiören',
    phone: '',
    lat: 39.9,
    lng: 32.89,
  },
];

test('Rota Bulma page: province-only search, drawing a region, narrowing the list and keeping what is shown', async () => {
  const page = await routePage({
    places: FOUND,
    overview: {
      sources: [
        { id: 'scraper', label: 'Harita tarama (gosom)', ready: true },
        { id: 'google', label: 'Google Places API', ready: true },
      ],
      defaultSource: 'google',
    },
  });
  const { w, doc, requests, settle, change, drawCircle, rows, pins } = page;
  try {
    const form = doc.getElementById('marketingSearchForm');
    assert.equal(form.elements.city.required, false);
    assert.equal(form.elements.district.required, false);
    assert.equal(doc.querySelector('label[for="routeCity"]').textContent, 'İl');
    assert.equal(form.elements.sector.options[0].textContent, 'Tüm sektörler');
    assert.match(doc.getElementById('marketingRegionStatus').textContent, /Bölge seçilmedi/);
    assert.equal(doc.getElementById('marketingRegionClear').disabled, true);

    // Nothing chosen: a province or a region is asked for; no request is sent.
    form.dispatchEvent(new w.Event('submit', { cancelable: true }));
    assert.equal(form.elements.city.validationMessage, 'Bir il seçin veya haritada bir bölge çizin.');
    assert.equal(requests.filter((item) => item.url === '/api/marketing/search').length, 0);

    // Only the province.
    change(form.elements.city, 'ankara');
    form.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await settle(() => rows().length === 3);
    assert.deepEqual(requests.at(-1).data, {
      sector: '',
      customQuery: '',
      city: 'Ankara',
      district: '',
      neighborhood: '',
      avenue: '',
      street: '',
    });
    assert.match(doc.querySelector('.marketing-section-head h3').textContent, /^Tüm firmalar · Ankara$/);
    // Google's firms are not drawn on the free map; the note says why.
    assert.deepEqual(pins(), []);
    assert.match(doc.getElementById('marketingMapNote').textContent, /yalnızca Google haritasında/);

    // The district filter lists the districts of the firms found.
    const district = doc.querySelector('#marketingFilters [name="district"]');
    assert.deepEqual(
      [...district.options].map((option) => option.textContent),
      ['Tüm ilçeler', 'Çankaya (2)', 'Keçiören (1)'],
    );
    assert.equal(
      doc.querySelector('#marketingFilters [name="districtOnly"]'),
      null,
      'no district was searched',
    );
    change(district, 'Çankaya');
    assert.deepEqual(rows(), ['ChIJinside0001', 'ChIJavm0000001']);
    change(doc.querySelector('#marketingFilters [name="exclude"]'), 'avm');
    assert.deepEqual(rows(), ['ChIJinside0001']);
    doc.getElementById('marketingResetFilters').click();
    assert.deepEqual(rows().length, 3);
    assert.equal(doc.querySelector('#marketingFilters [name="exclude"]').value, '');

    // Drawing a region narrows the firms already found.
    doc.getElementById('marketingDraw').click();
    assert.equal(doc.getElementById('marketingDraw').getAttribute('aria-pressed'), 'true');
    drawCircle(doc.querySelector('#marketingMap .marketing-map-capture'));
    assert.match(doc.getElementById('marketingRegionStatus').textContent, /Bölge seçili \(yaklaşık/);
    assert.equal(doc.getElementById('marketingDraw').textContent, '✎ Yeniden çiz');
    assert.deepEqual(rows(), ['ChIJinside0001', 'ChIJavm0000001']);
    assert.match(
      doc.getElementById('marketingResultSummary').textContent,
      /2 firma gösteriliyor · toplam 3 · 1 tanesi çizilen bölgenin dışında/,
    );

    // "Yalnızca görünenleri tut" drops the rest for good; one firm can be dropped by its row.
    doc.querySelector('[data-place-check="ChIJoutside001"]')?.click();
    doc.getElementById('marketingKeepVisible').click();
    doc.getElementById('marketingRegionClear').click();
    assert.deepEqual(
      rows(),
      ['ChIJinside0001', 'ChIJavm0000001'],
      'clearing the region does not bring them back',
    );
    assert.match(doc.getElementById('marketingRegionStatus').textContent, /Bölge seçilmedi/);
    doc.querySelector('[data-place-drop="ChIJavm0000001"]').click();
    assert.deepEqual(rows(), ['ChIJinside0001']);
    assert.match(doc.getElementById('marketingResultSummary').textContent, /1 firma gösteriliyor · toplam 1/);

    // A region alone is enough to search, and the search carries it.
    doc.getElementById('marketingViewport').click();
    change(form.elements.city, '');
    form.dispatchEvent(new w.Event('submit', { cancelable: true }));
    // The stand-in server returns all three firms; the one outside the region stays hidden.
    await settle(() => requests.at(-1).data.region && rows().length === 2);
    const sent = requests.at(-1).data;
    assert.equal(sent.city, '');
    assert.ok(route.validRegion(sent.region) && sent.region.length === 4);
    assert.match(doc.querySelector('.marketing-section-head h3').textContent, /Haritada çizilen bölge/);
    assert.equal(page.base.calls.at(-1)[0], 'fit', 'the map turns to the region searched');
  } finally {
    w.close();
  }
});

test('Rota Bulma page: the subscribed map service is searched as "platform" and shows what is left', async () => {
  const page = await routePage({
    places: FOUND,
    provider: 'google',
    overview: {
      ready: false,
      sources: [{ id: 'platform', label: 'Hazır harita servisi (abonelik)', ready: true }],
      defaultSource: 'platform',
      service: { ready: true, monthlySearches: 300, searchesLeft: 42 },
    },
  });
  const { w, doc, requests, settle, change, rows, pins } = page;
  try {
    assert.match(doc.getElementById('marketingServiceNote').textContent, /kalan arama hakkı 42 \/ 300/);
    const form = doc.getElementById('marketingSearchForm');
    assert.equal(form.elements.source.value, 'platform');
    change(form.elements.city, 'Ankara');
    change(form.elements.sector, 'mobilya');
    form.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await settle(() => rows().length === 3);
    assert.equal(requests.at(-1).data.source, 'platform');
    assert.match(doc.getElementById('marketingServiceNote').textContent, /kalan arama hakkı 41 \/ 300/);
    assert.match(doc.querySelector('.marketing-section-head small').textContent, /Hazır harita servisi/);
    // On a Google map the firms are dots; a click selects the firm in the list too.
    assert.deepEqual(pins(), ['ChIJinside0001', 'ChIJavm0000001', 'ChIJoutside001']);
    doc
      .querySelector('#marketingMap [data-place="ChIJavm0000001"] circle')
      .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    assert.equal(doc.querySelector('[data-place-check="ChIJavm0000001"]').checked, true);
    assert.equal(doc.getElementById('marketingBuild').textContent, 'Rota Oluştur (1)');
    assert.ok(
      doc.querySelector('#marketingMap [data-place="ChIJavm0000001"]').classList.contains('selected'),
      'the dot shows the selection',
    );
  } finally {
    w.close();
  }
});

test('Rota Bulma page: an office whose service is used up is told so instead of being sent to settings', async () => {
  const page = await routePage({
    places: [],
    overview: {
      ready: false,
      sources: [{ id: 'platform', label: 'Hazır harita servisi (abonelik)', ready: false }],
      service: {
        ready: false,
        monthlySearches: 300,
        searchesLeft: 0,
        message: 'Bu ayki arama hakkınız doldu (300 arama).',
      },
    },
  });
  try {
    assert.equal(
      page.doc.querySelector('.marketing-notice').textContent,
      'Bu ayki arama hakkınız doldu (300 arama).',
    );
    assert.equal(page.doc.getElementById('marketingSearchButton').disabled, true);
    assert.equal(page.doc.getElementById('marketingOpenSettings'), null);
  } finally {
    page.w.close();
  }
});

// Stand-ins for the two map libraries, with the same flat projection as fakeBase. They let the
// thin adapters run without loading Leaflet or contacting Google.
function mapLibraries(w) {
  const calls = [];
  class LatLng {
    constructor(lat, lng) {
      this.latitude = lat;
      this.longitude = lng;
    }
    lat() {
      return this.latitude;
    }
    lng() {
      return this.longitude;
    }
  }
  w.google = {
    maps: {
      LatLng,
      Point: class {
        constructor(x, y) {
          this.x = x;
          this.y = y;
        }
      },
      Map: class {
        constructor(element, options) {
          calls.push(['google.Map', options]);
        }
        addListener(name) {
          calls.push(['google.listen', name]);
        }
        fitBounds(bounds, padding) {
          calls.push(['google.fit', bounds, padding]);
        }
        setCenter(center) {
          calls.push(['google.center', center]);
        }
        setZoom(zoom) {
          calls.push(['google.zoom', zoom]);
        }
        getCenter() {
          return new LatLng(39.92, 32.85);
        }
        getZoom() {
          return 13;
        }
        getBounds() {
          return { getNorthEast: () => new LatLng(39.95, 32.9), getSouthWest: () => new LatLng(39.9, 32.8) };
        }
      },
      OverlayView: class {
        setMap(map) {
          calls.push(['google.probe', !!map]);
        }
        getProjection() {
          return {
            fromLatLngToContainerPixel: (place) => ({
              x: (place.lng() - 32.8) * 10000,
              y: (39.95 - place.lat()) * 10000,
            }),
            fromContainerPixelToLatLng: (point) =>
              new LatLng(39.95 - point.y / 10000, 32.8 + point.x / 10000),
          };
        }
      },
      event: { addListenerOnce: (map, name, listener) => setTimeout(listener, 0), trigger() {} },
    },
  };
  w.L = {
    map(element, options) {
      calls.push(['leaflet.map', options]);
      return {
        attributionControl: { setPrefix() {} },
        setView: (center, zoom) => calls.push(['leaflet.view', center, zoom]),
        on: (names) => calls.push(['leaflet.listen', names]),
        latLngToContainerPoint: ([lat, lng]) => ({ x: (lng - 32.8) * 10000, y: (39.95 - lat) * 10000 }),
        containerPointToLatLng: ([x, y]) => ({ lat: 39.95 - y / 10000, lng: 32.8 + x / 10000 }),
        fitBounds: (bounds) => calls.push(['leaflet.fit', bounds]),
        getCenter: () => ({ lat: 39.92, lng: 32.85 }),
        getZoom: () => 13,
        getBounds: () => ({
          getSouth: () => 39.9,
          getWest: () => 32.8,
          getNorth: () => 39.95,
          getEast: () => 32.9,
        }),
        invalidateSize() {},
        remove: () => calls.push(['leaflet.remove']),
      };
    },
    tileLayer(url, options) {
      calls.push(['leaflet.tiles', url, options]);
      return { addTo() {} };
    },
  };
  return calls;
}

test('base maps: OpenStreetMap without a key, Google with a browser key, and back to OpenStreetMap when Google refuses it', async () => {
  const { w } = browser();
  try {
    const calls = mapLibraries(w);
    const named = (name) => calls.filter((call) => call[0] === name);
    const box = w.document.getElementById('map');
    const pin = { placeId: 'a', lat: 39.92, lng: 32.83, name: 'Alfa', status: 'new', selected: false };
    const pinAt = () => box.querySelector('.marketing-pin').getAttribute('transform');

    // No key: the free map, told to send a Referer to the tile servers.
    const free = await w.HanMarketingMap.create(box, {
      provider: { provider: 'osm' },
      view: { lat: 39.93, lng: 32.86, zoom: 11 },
    });
    assert.equal(free.provider, 'osm');
    assert.equal(
      named('leaflet.map')[0][1].zoomAnimation,
      false,
      'the drawing layer never lags behind a zoom animation',
    );
    const [, tileUrl, tileOptions] = named('leaflet.tiles')[0];
    assert.equal(tileUrl, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    assert.equal(tileOptions.referrerPolicy, 'strict-origin-when-cross-origin');
    assert.match(tileOptions.attribution, /OpenStreetMap/);
    assert.deepEqual(JSON.parse(JSON.stringify(named('leaflet.view')[0])), [
      'leaflet.view',
      [39.93, 32.86],
      11,
    ]);
    free.setPins([pin]);
    assert.equal(pinAt(), 'translate(300.0,300.0)');
    free.fitRegion(KIZILAY);
    assert.deepEqual(JSON.parse(JSON.stringify(named('leaflet.fit')[0][1])), [
      [39.91, 32.84],
      [39.93, 32.865],
    ]);
    free.destroy();
    assert.equal(named('leaflet.remove').length, 1);

    // A browser key: Google's map, with the same drawing layer on top.
    let fellBack = 0;
    const paid = await w.HanMarketingMap.create(box, {
      provider: { provider: 'google', key: BROWSER_KEY },
      view: { lat: 39.93, lng: 32.86, zoom: 11 },
      onFallback: () => fellBack++,
    });
    assert.equal(paid.provider, 'google');
    const options = named('google.Map')[0][1];
    assert.deepEqual(JSON.parse(JSON.stringify([options.center, options.zoom])), [
      { lat: 39.93, lng: 32.86 },
      11,
    ]);
    assert.deepEqual(named('google.listen')[0], ['google.listen', 'bounds_changed']);
    paid.setPins([pin]);
    assert.equal(pinAt(), 'translate(300.0,300.0)');
    paid.fitRegion(KIZILAY);
    assert.deepEqual(JSON.parse(JSON.stringify(named('google.fit')[0].slice(1))), [
      { south: 39.91, west: 32.84, north: 39.93, east: 32.865 },
      28,
    ]);
    assert.ok(w.HanMarketingRoute.validRegion(paid.viewportRegion()));
    assert.deepEqual(JSON.parse(JSON.stringify(paid.view())), { lat: 39.92, lng: 32.85, zoom: 13 });

    // Google rejects the key after the map was drawn: the free map takes over where it was.
    assert.equal(typeof w.gm_authFailure, 'function');
    w.gm_authFailure();
    for (let i = 0; i < 40 && !fellBack; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(paid.provider, 'osm');
    assert.equal(fellBack, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(named('leaflet.view').at(-1))), [
      'leaflet.view',
      [39.92, 32.85],
      13,
    ]);
    assert.equal(pinAt(), 'translate(300.0,300.0)', 'firms stay where they are');
    paid.destroy();
  } finally {
    w.close();
  }
});

test('an office on its own keys is not told about a map service that was never switched on', async (t) => {
  await withEnvironment({ MAPS_ENCRYPTION_KEY: 'b'.repeat(64) }, async () => {
    // Both products (as the existing office has), but the selling company's service is off.
    const quiet = await office(t, {
      modules: gate(['marketing-routes', 'marketing-routes-service']),
      platformMaps: fakeService({ off: true }),
    });
    const overview = (await quiet.call('/api/marketing/overview')).body;
    assert.deepEqual(
      overview.sources.map((source) => source.id),
      ['google', 'scraper'],
    );
    assert.equal(Object.hasOwn(overview, 'service'), false);
    assert.equal(overview.canConfigure, true);
    assert.equal((await quiet.call('/api/marketing/config')).body.service, false);
    assert.equal((await quiet.call('/api/marketing/search', { city: 'Ankara' })).status, 200);

    // Used up is different: the office is told, and its own source still works.
    const used = await office(t, {
      modules: gate(['marketing-routes', 'marketing-routes-service']),
      platformMaps: fakeService({ searchesLeft: 0 }),
    });
    const full = (await used.call('/api/marketing/overview')).body;
    assert.deepEqual(
      full.sources.map((source) => [source.id, source.ready]),
      [
        ['platform', false],
        ['google', true],
        ['scraper', false],
      ],
    );
    assert.match(full.service.message, /arama hakkınız doldu/);
    assert.equal(full.defaultSource, 'google');
  });
});

test('Rota Bulma page: a district name from the map service is shown as text in the filter', async () => {
  const evil = '"><img src=x onerror="window.hacked=1">';
  const page = await routePage({
    places: [{ ...FOUND[0], district: evil }, { ...FOUND[1], district: evil }, FOUND[2]],
  });
  const { w, doc, settle, change, rows } = page;
  try {
    const form = doc.getElementById('marketingSearchForm');
    change(form.elements.city, 'Ankara');
    form.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await settle(() => rows().length === 3);
    const district = doc.querySelector('#marketingFilters [name="district"]');
    assert.equal(district.options[1].textContent, evil + ' (2)');
    assert.equal(district.options[1].value, evil);
    assert.equal(doc.querySelectorAll('#marketingFilters img, #marketingResults img').length, 0);
    assert.equal(w.hacked, undefined);
    change(district, evil);
    assert.deepEqual(rows(), ['ChIJinside0001', 'ChIJavm0000001']);
    assert.equal(
      doc.querySelector('#marketingFilters [name="district"]').value,
      evil,
      'the choice survives a redraw',
    );
  } finally {
    w.close();
  }
});

test('search counter over HTTP and on the page: every search of the office is counted and shown', async (t) => {
  await withEnvironment({ MAPS_ENCRYPTION_KEY: 'b'.repeat(64) }, async () => {
    const counted = { google: 7, scraper: 2, platform: 0 };
    const recorded = [];
    const meter = {
      month: async () => ({ ...counted }),
      record: async (usage) => {
        recorded.push(usage);
        for (const key of Object.keys(counted)) counted[key] += usage[key] || 0;
      },
    };
    const { pg, pool } = await database();
    const state = fixture();
    state.mapsConfig = maps.configure({}, { enabled: true, apiKey: OWN_KEY });
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const app = await serve(
      createApplication({
        store: createStore(pool, { records: true }),
        mapsMeter: meter,
        mapsFetch: async (url) =>
          url.includes('status=400')
            ? Response.json({ error: {} }, { status: 400 })
            : Response.json({ places: [googlePlace('ChIJinside0001', 'Firma')] }),
      }),
    );
    t.after(async () => {
      await app.close();
      await pg.close();
    });
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,'test-ceo','desktop',$2)",
      [crypto.createHash('sha256').update(token).digest('hex'), Date.now() + 600000],
    );
    const headers = {
      cookie: 'han_session=' + token,
      'X-Han-Request': '1',
      'Content-Type': 'application/json',
    };
    const call = async (path, body) => {
      const response = await fetch(app.url + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    assert.deepEqual((await call('/api/marketing/overview')).body.usage, {
      google: 7,
      scraper: 2,
      platform: 0,
    });
    const found = await call('/api/marketing/search', { city: 'Ankara' });
    assert.deepEqual(
      found.body.usage,
      { google: 8, scraper: 2, platform: 0 },
      'the reply already includes this search',
    );
    assert.deepEqual(recorded, [{ google: 1 }]);
    // A refused search is not counted.
    assert.equal((await call('/api/marketing/search', { sector: 'mobilya' })).status, 400);
    assert.deepEqual(recorded, [{ google: 1 }]);
    assert.deepEqual((await call('/api/marketing/overview')).body.usage, {
      google: 8,
      scraper: 2,
      platform: 0,
    });
  });

  // Without a counter (single-file installation) the page shows no count at all.
  const plain = await routePage({ places: FOUND });
  try {
    assert.equal(plain.doc.getElementById('marketingUsageNote'), null);
  } finally {
    plain.w.close();
  }
  const page = await routePage({
    places: FOUND,
    overview: { usage: { google: 7, scraper: 2, platform: 0 } },
  });
  const { w, doc, settle, change, rows } = page;
  try {
    const note = () => doc.getElementById('marketingUsageNote').textContent;
    assert.match(note(), /^Bu ay yapılan arama: Google Places API 7 · Harita tarama 2\./);
    // The stand-in server replies with the new totals; the note follows them.
    w.fetch = async () =>
      Response.json({
        places: FOUND,
        outside: 0,
        nextPageToken: '',
        usage: { google: 8, scraper: 2, platform: 0 },
      });
    const form = doc.getElementById('marketingSearchForm');
    change(form.elements.city, 'Ankara');
    form.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await settle(() => rows().length === 3);
    assert.match(note(), /Google Places API 8 · Harita tarama 2/);
  } finally {
    w.close();
  }
});
