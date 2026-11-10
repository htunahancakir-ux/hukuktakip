const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const route = require('../outputs/icrapro/workspace-marketing-route.js');
const maps = require('../lib/maps-settings.cjs');
const places = require('../lib/google-places.cjs');
const marketing = require('../lib/marketing-routes.cjs');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { database, fixture, serve, password } = require('./support/postgres.cjs');

// Synthetic key in Google's format. It is never sent anywhere: every fetch is stubbed.
const KEY = 'AIza' + 'T'.repeat(35);

async function withEnvironment(values, work) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  try {
    return await work();
  } finally {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}
const withMapsKey = (work) => withEnvironment({ MAPS_ENCRYPTION_KEY: 'b'.repeat(64) }, work);

function googlePlace(id, name, extra = {}) {
  return {
    id,
    displayName: { text: name },
    formattedAddress: name + ' Sk. No:1, Çankaya/Ankara',
    addressComponents: [
      { longText: 'Ankara', types: ['administrative_area_level_1', 'political'] },
      { longText: 'Çankaya', types: ['administrative_area_level_2', 'political'] },
    ],
    location: { latitude: 39.92, longitude: 32.85 },
    businessStatus: 'OPERATIONAL',
    ...extra,
  };
}

test('route helpers order stops, split Google Maps links within limits and build WhatsApp links', () => {
  const kizilay = { lat: 39.9208, lng: 32.8541 },
    ulus = { lat: 39.9419, lng: 32.8543 };
  const distance = route.distanceMeters(kizilay, ulus);
  assert.ok(distance > 2200 && distance < 2500, String(distance));
  assert.equal(route.distanceMeters(kizilay, { lat: null, lng: 1 }), null);

  const line = [0.03, 0.01, 0.02].map((lng, i) => ({ placeId: 'p' + i, name: 'S' + i, lat: 0, lng }));
  assert.deepEqual(
    route.orderStops(line, { lat: 0, lng: 0 }).map((stop) => stop.lng),
    [0.01, 0.02, 0.03],
  );
  const free = route.orderStops([...line, { placeId: 'x', name: 'Konumsuz', lat: null, lng: null }]);
  const lngs = free.slice(0, 3).map((stop) => stop.lng);
  assert.ok(
    JSON.stringify(lngs) === '[0.01,0.02,0.03]' || JSON.stringify(lngs) === '[0.03,0.02,0.01]',
    'open path without a start follows the line: ' + lngs,
  );
  assert.equal(free.at(-1).placeId, 'x', 'stops without coordinates stay last');

  const stops = Array.from({ length: 23 }, (_, i) => ({
    placeId: 'ChIJ' + String(i).padStart(23, 'x'),
    name: 'Firma | ' + i,
    lat: 39.9 + i / 1000,
    lng: 32.8 + i / 1000,
  }));
  const links = route.directionsLinks({ origin: null, stops, perLink: 10 });
  assert.deepEqual(
    links.map((link) => [link.from, link.to]),
    [
      [1, 10],
      [11, 20],
      [21, 23],
    ],
  );
  for (const [index, link] of links.entries()) {
    assert.ok(link.url.length <= route.LINK_LIMIT);
    const params = new URL(link.url).searchParams;
    assert.equal(params.get('api'), '1');
    assert.equal(params.get('travelmode'), 'driving');
    const waypoints = params.get('waypoints')?.split('|') || [];
    assert.ok(waypoints.length <= 9);
    assert.equal(params.get('waypoint_place_ids')?.split('|').length || 0, waypoints.length);
    assert.equal(params.get('destination_place_id'), stops[link.to - 1].placeId);
    // Each part continues from the previous part's last stop; the first uses the device location.
    if (index === 0) assert.equal(params.get('origin'), null);
    else assert.equal(params.get('origin_place_id'), stops[link.from - 2].placeId);
  }
  assert.equal(route.directionsLinks({ stops, perLink: 4 }).length, 6, 'mobile browsers: 3 waypoints');
  const office = new URL(route.directionsLinks({ origin: { text: 'Kızılay, Ankara' }, stops }).at(0).url);
  assert.equal(office.searchParams.get('origin'), 'Kızılay, Ankara');
  const unlocated = new URL(route.directionsUrl(null, [{ placeId: 'ChIJabcdefghij', name: 'A | B' }]));
  assert.equal(unlocated.searchParams.get('destination'), 'A   B');

  const text = route.whatsappText({ title: 'Rota', stops: stops.slice(0, 2), links: links.slice(0, 1) });
  assert.match(text, /1\. Firma \| 0/);
  const whatsapp = route.whatsappLink('905321112233', text);
  assert.ok(whatsapp.startsWith('https://wa.me/905321112233?text='));
  assert.equal(decodeURIComponent(whatsapp.split('text=')[1]), text);
  assert.ok(route.whatsappLink('', 'x').startsWith('https://wa.me/?text='));
  assert.ok(route.whatsappLink('12', 'x').startsWith('https://wa.me/?text='));

  assert.equal(route.isMobilePhone('0532 123 45 67'), true);
  assert.equal(route.isMobilePhone('+90 532 123 45 67'), true);
  assert.equal(route.isMobilePhone('0312 123 45 67'), false);
});

test('result filters cover phone, visits, distance, opening, area, rating, website and search', () => {
  const list = [
    { placeId: 'a', name: 'Ada Mobilya', address: 'Kızılay', phone: '0532 111 11 11', lat: 0, lng: 0.001 },
    { placeId: 'b', name: 'Beta', address: 'Ulus', phone: '0312 222 22 22', lat: 0, lng: 0.2, rating: 4.6 },
    { placeId: 'c', name: 'Ceta', address: 'Çayyolu', visit: { status: 'visited', result: 'İlgilenmiyor' } },
    {
      placeId: 'd',
      name: 'Delta',
      address: 'Bahçeli',
      visit: { status: 'visited', result: 'Tekrar gidilecek' },
    },
    {
      placeId: 'e',
      name: 'Epsilon',
      address: 'Ayrancı',
      visit: { status: 'planned' },
      website: 'https://e.test',
    },
    { placeId: 'f', name: 'Zeta', address: 'Keçiören', inDistrict: false, openNow: true },
    { placeId: 'g', name: 'Eta', address: 'Kapalı', businessStatus: 'CLOSED_PERMANENTLY', ratingCount: 50 },
  ];
  const ids = (filters, origin) => route.filterPlaces(list, filters, origin).map((place) => place.placeId);
  assert.deepEqual(ids({ phone: 'any' }), ['a', 'b']);
  assert.deepEqual(ids({ phone: 'mobile' }), ['a']);
  assert.deepEqual(ids({ visit: 'notVisited' }), ['a', 'b', 'e', 'f', 'g']);
  assert.deepEqual(ids({ visit: 'fresh' }), ['a', 'b', 'f', 'g']);
  assert.deepEqual(ids({ visit: 'planned' }), ['e']);
  assert.deepEqual(ids({ visit: 'revisit' }), ['d']);
  assert.deepEqual(ids({ visit: 'visited', hideRefused: true }), ['d']);
  assert.deepEqual(ids({ maxKm: 1 }, { lat: 0, lng: 0 }), ['a']);
  assert.deepEqual(ids({ maxKm: 1 }), [], 'distance filter needs a start point');
  assert.deepEqual(ids({ openNow: true }), ['f']);
  assert.deepEqual(ids({ districtOnly: true, hideClosed: true }), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(ids({ minRating: 4.5 }), ['b']);
  assert.deepEqual(ids({ minReviews: 10 }), ['g']);
  assert.deepEqual(ids({ website: 'yes' }), ['e']);
  assert.deepEqual(ids({ query: 'cayyolu' }), ['c'], 'search ignores Turkish accents');
  assert.deepEqual(ids({ sort: 'distance' }, { lat: 0, lng: 0 }).slice(0, 2), ['a', 'b']);
  assert.deepEqual(ids({ sort: 'rating' })[0], 'b');
});

test('Google API keys are sealed, never published, validated and need an encryption key', async () => {
  await withMapsKey(() => {
    const saved = maps.configure({}, { enabled: true, apiKey: KEY });
    assert.notEqual(saved.sealedApiKey, KEY);
    const shown = maps.publicConfig(saved);
    assert.equal(shown.ready, true);
    assert.equal(shown.apiKeySaved, true);
    assert.equal(JSON.stringify(shown).includes(KEY), false);
    assert.equal(JSON.stringify(shown).includes(saved.sealedApiKey), false);
    assert.equal(maps.runtimeKey(saved), KEY);
    assert.deepEqual(
      shown.sectors.map((sector) => sector.label),
      ['Beyaz Eşya', 'Mobilya', 'Hırdavat'],
    );
    const kept = maps.configure(saved, {
      enabled: true,
      sectors: [
        { id: 'mobilya', label: 'Mobilya', query: 'mobilya' },
        { label: 'Elektrik Malzemeleri', query: 'elektrik malzemeleri' },
      ],
    });
    assert.equal(maps.runtimeKey(kept), KEY, 'an empty key field keeps the saved key');
    assert.deepEqual(
      kept.sectors.map((sector) => sector.id),
      ['mobilya', 'elektrik-malzemeleri'],
    );
    for (const input of [
      { enabled: true, apiKey: 'not-a-key' },
      { enabled: 'yes' },
      { enabled: true, clearApiKey: true },
      { enabled: false, sectors: [] },
      { enabled: false, sectors: [{ label: 'A' }] },
      { enabled: false, sectors: [{ label: 'Mobilya' }, { label: 'mobilya' }] },
      { enabled: false, sectors: Array.from({ length: 31 }, (_, i) => ({ label: 'Sektör ' + i })) },
      { enabled: false, sectors: [{ label: '<script>' }] },
    ])
      assert.throws(
        () => maps.configure(saved, input),
        (error) => error.code === 400,
        JSON.stringify(input),
      );
    assert.equal(maps.configure(saved, { enabled: false, clearApiKey: true }).sealedApiKey, '');
  });
  await withEnvironment({ MAPS_ENCRYPTION_KEY: undefined, BACKUP_ENCRYPTION_KEY: undefined }, () => {
    assert.equal(maps.publicConfig({}).encryptionReady, false);
    assert.throws(
      () => maps.configure({}, { enabled: true, apiKey: KEY }),
      (error) => error.code === 503,
    );
  });
});

test('Places client sends the key only in a header and maps Google errors to safe messages', async () => {
  let request;
  const result = await places.searchText({
    apiKey: KEY,
    textQuery: 'mobilya Çankaya Ankara',
    pageToken: 'next-page',
    fetcher: async (url, init) => {
      request = { url, init };
      return Response.json({ places: [googlePlace('ChIJabcdefghij', 'A')], nextPageToken: 'n2' });
    },
  });
  assert.equal(result.places.length, 1);
  assert.equal(result.nextPageToken, 'n2');
  assert.equal(request.url, places.SEARCH_URL);
  assert.equal(request.url.includes(KEY), false);
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.redirect, 'error');
  assert.ok(request.init.signal);
  assert.equal(request.init.headers['X-Goog-Api-Key'], KEY);
  assert.match(request.init.headers['X-Goog-FieldMask'], /places\.nationalPhoneNumber/);
  assert.match(request.init.headers['X-Goog-FieldMask'], /nextPageToken/);
  assert.deepEqual(JSON.parse(request.init.body), {
    textQuery: 'mobilya Çankaya Ankara',
    languageCode: 'tr',
    regionCode: 'TR',
    pageSize: 20,
    pageToken: 'next-page',
  });
  const failing = (status, body = {}) =>
    places.searchText({ apiKey: KEY, textQuery: 'x', fetcher: async () => Response.json(body, { status }) });
  const invalidKey = { error: { message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } };
  for (const [status, body, code] of [
    [403, {}, 503],
    [400, invalidKey, 503],
    [400, { error: { message: 'Invalid textQuery' } }, 400],
    [429, {}, 429],
    [500, {}, 503],
  ])
    await assert.rejects(failing(status, body), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.message.includes(KEY), false);
      return true;
    });
  await assert.rejects(
    places.searchText({
      apiKey: KEY,
      textQuery: 'x',
      fetcher: async () => {
        throw new Error('network down ' + KEY);
      },
    }),
    (error) => error.code === 503 && !error.message.includes(KEY),
  );
});

test('search criteria come from the province list and visits match by place, phone and name', () => {
  const sectors = maps.publicConfig({}).sectors;
  const base = { sector: 'mobilya', city: 'Ankara', district: 'Çankaya' };
  for (const input of [
    { ...base, city: 'Atlantis' },
    { ...base, district: 'Kadıköy' },
    { ...base, sector: 'unknown' },
    { ...base, sector: 'custom', customQuery: 'x' },
    { ...base, neighborhood: '<b>' },
    { ...base, street: 'x'.repeat(81) },
  ])
    assert.throws(
      () => marketing.criteria(input, sectors),
      (error) => error.code === 400,
      JSON.stringify(input),
    );
  assert.equal(
    marketing.textQuery(
      marketing.criteria(
        { ...base, neighborhood: 'Kızılay', avenue: 'Atatürk', street: 'Sakarya Sk.' },
        sectors,
      ),
    ),
    'mobilya mağazası Sakarya Sk. Atatürk Caddesi Kızılay Mahallesi Çankaya Ankara',
  );
  assert.equal(
    marketing.textQuery(marketing.criteria({ ...base, sector: 'custom', customQuery: 'perde' }, sectors)),
    'perde Çankaya Ankara',
  );
  assert.equal(
    marketing.textQuery(
      marketing.criteria(
        { ...base, neighborhood: 'Kızılay Mah.', avenue: 'Atatürk Bulvarı', street: 'Sakarya Sokağı' },
        sectors,
      ),
    ),
    'mobilya mağazası Sakarya Sokağı Atatürk Bulvarı Kızılay Mah. Çankaya Ankara',
  );
  const state = {
    data: { 'icrapro-personnel-v1': [] },
    marketingProspects: [
      {
        createdBy: 'other',
        company: 'X',
        placeId: 'ChIJbyplace01',
        date: '2026-11-01',
        visitResult: 'İlgilenmiyor',
        staffName: 'Ayşe',
      },
      { createdBy: 'me', company: 'Y', phone: '0312 555 66 77', date: '2026-11-02', staffName: 'Ben' },
      {
        createdBy: 'other',
        company: 'Ölçü Hırdavat',
        district: 'Çankaya',
        date: '2026-11-03',
        staffName: 'Ayşe',
      },
    ],
    marketingRoutes: [
      { createdBy: 'me', createdByName: 'Ben', createdAt: '2026-11-04T08:00:00Z', stops: ['ChIJplanned01'] },
    ],
  };
  const c = marketing.criteria(base, sectors);
  const found = marketing.annotatePlaces(
    [
      googlePlace('ChIJbyplace01', 'Farklı Ad'),
      googlePlace('ChIJbyphone01', 'Telefon', { nationalPhoneNumber: '(0312) 555 66 77' }),
      googlePlace('ChIJbyname001', 'OLCU HIRDAVAT'),
      googlePlace('ChIJplanned01', 'Plan'),
      googlePlace('ChIJkecioren1', 'Komşu ilçe', {
        addressComponents: [
          { longText: 'Ankara', types: ['administrative_area_level_1'] },
          { longText: 'Keçiören', types: ['administrative_area_level_2'] },
        ],
      }),
      googlePlace('ChIJistanbul1', 'Başka il', {
        addressComponents: [{ longText: 'İstanbul', types: ['administrative_area_level_1'] }],
      }),
      googlePlace('bad id', 'Geçersiz'),
    ],
    c,
    state,
    { id: 'me', role: 'staff' },
  );
  assert.equal(found.outside, 1);
  const byId = Object.fromEntries(found.places.map((place) => [place.placeId, place]));
  assert.deepEqual(Object.keys(byId), [
    'ChIJbyplace01',
    'ChIJbyphone01',
    'ChIJbyname001',
    'ChIJplanned01',
    'ChIJkecioren1',
  ]);
  assert.deepEqual(byId.ChIJbyplace01.visit, {
    status: 'visited',
    result: 'İlgilenmiyor',
    date: '2026-11-01',
    staffName: '',
    own: false,
  });
  assert.equal(byId.ChIJbyphone01.visit.staffName, 'Ben');
  assert.equal(byId.ChIJbyname001.visit.status, 'visited');
  assert.equal(byId.ChIJplanned01.visit.status, 'planned');
  assert.equal(byId.ChIJkecioren1.inDistrict, false);
  assert.equal(byId.ChIJbyplace01.inDistrict, true);
  assert.equal(
    marketing.annotatePlaces([googlePlace('ChIJbyplace01', 'X')], c, state, { id: 'boss', role: 'admin' })
      .places[0].visit.staffName,
    'Ayşe',
    'managers see who visited',
  );
});

test('Rota Bulma over HTTP: access, read-only, tenant data, visits, routes, audit and paid-call limits', async (t) => {
  await withMapsKey(async () => {
    const { pg, pool } = await database();
    const state = fixture();
    const ceo = state.users[0];
    state.users.push(
      {
        ...ceo,
        id: 'seller',
        username: 'seller',
        name: 'Satış',
        role: 'staff',
        staffId: 'p-seller',
        whatsappPhone: '0532 111 22 33',
      },
      { ...ceo, id: 'other', username: 'other', name: 'Muhasebe', role: 'staff', staffId: 'p-other' },
      { ...ceo, id: 'viewer', username: 'viewer', name: 'İzleyici', role: 'admin', readOnly: true },
    );
    state.data['icrapro-personnel-v1'].push(
      { id: 'p-seller', name: 'Satış', department: 'Pazarlama', active: true },
      { id: 'p-other', name: 'Muhasebe', department: 'Muhasebe', active: true },
    );
    state.marketingProspects = [
      {
        id: 'v1',
        createdBy: 'test-ceo',
        company: 'Eski Mobilya',
        placeId: 'ChIJvisited01',
        date: '2026-11-01',
        visitResult: 'İlgilenmiyor',
        staffName: 'Test',
        city: 'Ankara',
        district: 'Çankaya',
        status: 'Potansiyel Müvekkil',
      },
      {
        id: 'v2',
        createdBy: 'seller',
        company: 'Telefon',
        phone: '0312 555 66 77',
        date: '2026-11-02',
        staffName: 'Satış',
        city: 'Ankara',
        district: 'Çankaya',
        status: 'Potansiyel Müvekkil',
      },
    ];
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const googleCalls = [];
    const mapsFetch = async (url, init) => {
      googleCalls.push({ url, init });
      // PGlite has one queued connection: a transaction held across this call would block here.
      await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(Error('database held during Google call')), 5000)),
      ]);
      if (url.startsWith(places.DETAILS_URL)) {
        const id = decodeURIComponent(url.slice(places.DETAILS_URL.length).split('?')[0]);
        return Response.json({
          id,
          displayName: { text: 'Güncel ' + id },
          formattedAddress: 'Adres ' + id,
          location: { latitude: 39.9, longitude: 32.8 },
        });
      }
      if (JSON.parse(init.body).pageToken === 'page-2')
        return Response.json({ places: [googlePlace('ChIJsecond01', 'İkinci Sayfa')] });
      return Response.json({
        places: [
          googlePlace('ChIJfresh0001', 'Yeni Mobilya', { nationalPhoneNumber: '0532 123 45 67' }),
          googlePlace('ChIJvisited01', 'Eski Mobilya'),
          googlePlace('ChIJphone0001', 'Telefonla Eşleşen', { nationalPhoneNumber: '0312 555 66 77' }),
          googlePlace('ChIJother0001', 'İstanbul Şubesi', {
            addressComponents: [{ longText: 'İstanbul', types: ['administrative_area_level_1'] }],
          }),
        ],
        nextPageToken: 'page-2',
      });
    };
    const app = await serve(createApplication({ store: createStore(pool, { records: true }), mapsFetch }));
    t.after(async () => {
      await app.close();
      await pg.close();
    });
    const sessionFor = async (id) => {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
        [crypto.createHash('sha256').update(token).digest('hex'), id, Date.now() + 600000],
      );
      return { cookie: 'han_session=' + token, 'X-Han-Request': '1', 'Content-Type': 'application/json' };
    };
    const [asCeo, asSeller, asOther, asViewer] = await Promise.all(
      ['test-ceo', 'seller', 'other', 'viewer'].map(sessionFor),
    );
    const call = async (headers, pathname, method = 'GET', body) => {
      const response = await fetch(app.url + pathname, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      assert.equal(text.includes(KEY), false, 'the Google key never reaches a browser');
      return { status: response.status, body: JSON.parse(text || '{}') };
    };
    const search = { sector: 'mobilya', city: 'Ankara', district: 'Çankaya', neighborhood: 'Kızılay' };

    let reply = await call(asSeller, '/api/marketing/search', 'POST', search);
    assert.equal(reply.status, 503, 'not configured yet');
    assert.match(reply.body.error, /Google Haritalar bağlantısı kurulmadı/);
    assert.equal((await call(asSeller, '/api/marketing/config')).status, 403);
    reply = await call(asCeo, '/api/marketing/config', 'PUT', { enabled: true, apiKey: KEY });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.ready, true);
    const metadata = (await pool.query('SELECT body FROM han_data.metadata WHERE id=1')).rows[0].body;
    assert.ok(metadata.mapsConfig.sealedApiKey);
    assert.equal(JSON.stringify(metadata).includes(KEY), false, 'stored only in sealed form');

    reply = await call(asSeller, '/api/marketing/overview');
    assert.equal(reply.status, 200);
    assert.equal(reply.body.ready, true);
    assert.equal(reply.body.selfPhone, '905321112233');
    assert.equal(reply.body.canConfigure, false);
    assert.deepEqual(reply.body.routes, []);
    assert.equal((await call(asOther, '/api/marketing/overview')).status, 403);
    assert.equal((await call(asOther, '/api/marketing/search', 'POST', search)).status, 403);
    reply = await call(asViewer, '/api/marketing/search', 'POST', search);
    assert.equal(reply.status, 403);
    assert.match(reply.body.error, /salt okunur/);
    assert.equal((await call({ 'X-Han-Request': '1' }, '/api/marketing/search', 'POST', search)).status, 401);
    assert.equal(
      (await call(asSeller, '/api/marketing/search', 'POST', { ...search, district: 'Kadıköy' })).status,
      400,
    );

    const before = googleCalls.length;
    reply = await call(asSeller, '/api/marketing/search', 'POST', search);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(googleCalls.length, before + 1);
    const sent = googleCalls.at(-1);
    assert.equal(sent.init.headers['X-Goog-Api-Key'], KEY);
    assert.equal(JSON.parse(sent.init.body).textQuery, 'mobilya mağazası Kızılay Mahallesi Çankaya Ankara');
    assert.equal(reply.body.outside, 1);
    assert.equal(reply.body.nextPageToken, 'page-2');
    const visit = (body, id) => body.places.find((place) => place.placeId === id)?.visit;
    assert.deepEqual(
      reply.body.places.map((place) => place.placeId),
      ['ChIJfresh0001', 'ChIJvisited01', 'ChIJphone0001'],
    );
    assert.equal(visit(reply.body, 'ChIJfresh0001'), null);
    assert.deepEqual(visit(reply.body, 'ChIJvisited01'), {
      status: 'visited',
      result: 'İlgilenmiyor',
      date: '2026-11-01',
      staffName: '',
      own: false,
    });
    assert.equal(visit(reply.body, 'ChIJphone0001').staffName, 'Satış');
    reply = await call(asSeller, '/api/marketing/search', 'POST', { ...search, pageToken: 'page-2' });
    assert.deepEqual(
      reply.body.places.map((place) => place.placeId),
      ['ChIJsecond01'],
    );

    const plan = {
      ...search,
      requestId: 'route-request-0001',
      origin: { mode: 'location', label: 'ignored', lat: 39.9, lng: 32.8 },
      stops: ['ChIJfresh0001', 'ChIJsecond01'],
    };
    reply = await call(asSeller, '/api/marketing/routes', 'POST', plan);
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const saved = reply.body.route;
    assert.equal(saved.name, 'Mobilya · Çankaya / Ankara');
    assert.deepEqual(saved.origin, { mode: 'location', label: '' }, 'device coordinates are not stored');
    reply = await call(asSeller, '/api/marketing/routes', 'POST', plan);
    assert.equal(reply.status, 200, 'a repeated click does not create a second route');
    assert.equal(reply.body.route.id, saved.id);
    assert.equal(
      (
        await call(asSeller, '/api/marketing/routes', 'POST', {
          ...plan,
          requestId: 'route-request-0002',
          stops: [],
        })
      ).status,
      400,
    );
    reply = await call(asSeller, '/api/marketing/search', 'POST', search);
    assert.equal(visit(reply.body, 'ChIJfresh0001').status, 'planned');

    const entry = {
      date: '2026-11-10',
      time: '10:30',
      status: 'Potansiyel Müvekkil',
      company: 'Yeni Mobilya',
      city: 'Ankara',
      district: 'Çankaya',
      visitResult: 'Tekrar gidilecek',
      placeId: 'ChIJfresh0001',
      routeId: saved.id,
    };
    assert.equal(
      (await call(asSeller, '/api/marketing-prospects', 'POST', { ...entry, visitResult: 'Belki' })).status,
      400,
    );
    assert.equal(
      (await call(asSeller, '/api/marketing-prospects', 'POST', { ...entry, routeId: crypto.randomUUID() }))
        .status,
      400,
    );
    assert.equal((await call(asSeller, '/api/marketing-prospects', 'POST', entry)).status, 201);
    reply = await call(asSeller, '/api/marketing/search', 'POST', search);
    assert.equal(visit(reply.body, 'ChIJfresh0001').result, 'Tekrar gidilecek');
    const prospects = (await call(asCeo, '/api/marketing-prospects')).body.items;
    const recorded = prospects.find((item) => item.placeId === 'ChIJfresh0001');
    assert.equal(recorded.routeId, saved.id);
    // A manager edit through the regular form keeps the Google place and route link.
    const edit = { ...recorded, notes: 'Düzeltildi', staffId: 'p-seller' };
    delete edit.placeId;
    delete edit.routeId;
    assert.equal((await call(asCeo, '/api/marketing-prospects', 'PUT', edit)).status, 201);
    const edited = (await call(asCeo, '/api/marketing-prospects')).body.items.find(
      (item) => item.id === recorded.id,
    );
    assert.equal(edited.placeId, 'ChIJfresh0001');
    assert.equal(edited.notes, 'Düzeltildi');
    // Routes beyond the newest 300 drop out; their visits must stay editable.
    const stored0 = (await pool.query('SELECT body FROM han_data.metadata WHERE id=1')).rows[0].body;
    await pool.query(
      `UPDATE han_data.metadata SET body=jsonb_set(body,'{marketingRoutes}','[]'::jsonb), revision=revision+1 WHERE id=1`,
    );
    assert.equal(
      (await call(asCeo, '/api/marketing-prospects', 'PUT', { ...edit, notes: 'Eski rota' })).status,
      201,
    );
    assert.equal(
      (await call(asSeller, '/api/marketing-prospects', 'POST', { ...entry, routeId: saved.id })).status,
      400,
      'a new visit cannot point to a missing route',
    );
    await pool.query(
      `UPDATE han_data.metadata SET body=jsonb_set(body,'{marketingRoutes}',$1::jsonb), revision=revision+1 WHERE id=1`,
      [JSON.stringify(stored0.marketingRoutes)],
    );

    reply = await call(asSeller, '/api/marketing/route-places', 'POST', { routeId: saved.id });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(
      reply.body.places.map((place) => place.name),
      ['Güncel ChIJfresh0001', 'Güncel ChIJsecond01'],
    );
    assert.equal(reply.body.places[0].visit.result, 'Tekrar gidilecek');
    assert.equal(reply.body.route.visitedCount, 1);
    assert.equal(
      (await call(asCeo, '/api/marketing/route-places', 'POST', { routeId: saved.id })).status,
      200,
    );
    assert.equal(
      (await call(asSeller, '/api/marketing/route-places', 'POST', { routeId: 'missing' })).status,
      404,
    );
    reply = await call(asSeller, '/api/marketing/overview');
    assert.equal(reply.body.routes[0].visitedCount, 1);
    assert.equal(reply.body.routes[0].requestId, undefined);

    const stored = (await pool.query('SELECT body FROM han_data.metadata WHERE id=1')).rows[0].body;
    const savedRoute = stored.marketingRoutes[0];
    assert.equal(JSON.stringify(savedRoute).includes('Yeni Mobilya'), false, 'Google names are not stored');
    assert.equal(/"(lat|lng|latitude|longitude)"/.test(JSON.stringify(savedRoute)), false, 'no coordinates');
    const { rows: audit } = await pool.query('SELECT area, action FROM han_private.han_audit ORDER BY id');
    assert.ok(audit.some((row) => row.area === 'Google Haritalar' && row.action === 'update'));
    assert.ok(audit.some((row) => row.area === 'Pazarlama Rotaları' && row.action === 'create'));
    assert.ok(audit.some((row) => row.area === 'Potansiyel Müvekkiller' && row.action === 'create'));

    let limited = 0;
    for (let attempt = 0; attempt < 45 && !limited; attempt++)
      if ((await call(asSeller, '/api/marketing/search', 'POST', search)).status === 429)
        limited = attempt + 1;
    assert.ok(limited, 'paid searches are rate limited');
    const searches = googleCalls.filter((item) => item.url === places.SEARCH_URL).length;
    assert.ok(searches <= 40, 'Google received at most 40 searches in the window: ' + searches);
  });
});

test('local JSON mode serves Rota Bulma without a database and throttles paid searches', async (t) => {
  await withMapsKey(async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'han-marketing-'));
    const file = path.join(directory, 'state.json');
    const state = fixture();
    state.mapsConfig = maps.configure({}, { enabled: true, apiKey: KEY });
    fs.writeFileSync(file, JSON.stringify(state));
    let searches = 0;
    const app = await withEnvironment({ HANHUKUK_STATE_FILE: file }, () =>
      serve(
        createApplication({
          mapsFetch: async () => {
            searches++;
            return Response.json({ places: [googlePlace('ChIJlocal00001', 'Yerel Hırdavat')] });
          },
        }),
      ),
    );
    t.after(async () => {
      await app.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const login = await fetch(app.url + '/api/login', {
      method: 'POST',
      headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test', password }),
    });
    assert.equal(login.status, 200);
    const headers = {
      cookie: login.headers.get('set-cookie').split(';')[0],
      'X-Han-Request': '1',
      'Content-Type': 'application/json',
    };
    const body = JSON.stringify({ sector: 'hirdavat', city: 'Ankara', district: 'Çankaya' });
    const first = await fetch(app.url + '/api/marketing/search', { method: 'POST', headers, body });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).places[0].name, 'Yerel Hırdavat');
    let status = 200;
    for (let attempt = 1; attempt <= 41 && status === 200; attempt++)
      status = (await fetch(app.url + '/api/marketing/search', { method: 'POST', headers, body })).status;
    assert.equal(status, 429);
    assert.equal(searches, 40);
    assert.equal(
      JSON.parse(fs.readFileSync(file, 'utf8')).marketingRoutes,
      undefined,
      'search writes nothing',
    );
  });
});

test('Rota Bulma page escapes Google content, selects visible firms and saves the route it shares', async () => {
  const dom = new JSDOM('<div id="content"></div>', {
    url: 'https://example.test',
    runScripts: 'dangerously',
  });
  const w = dom.window;
  try {
    const requests = [];
    w.Response = Response;
    w.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
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
        return '<input id="' + prefix + 'City" name="city"><input id="' + prefix + 'District" name="district">';
      }
      function setupClientCity() {}
      function setupClientDistrict() {}
    `);
    w.authApi = (url, method = 'GET', data) => {
      // Copy out of the page's realm so deepEqual compares plain values.
      requests.push({ url, method, data: data === undefined ? undefined : JSON.parse(JSON.stringify(data)) });
      if (url === '/api/marketing/overview')
        return {
          ready: true,
          canConfigure: false,
          selfPhone: '905321112233',
          sectors: [{ id: 'mobilya', label: 'Mobilya' }],
          office: { city: 'Ankara', district: 'Çankaya', address: '' },
          visitResults: route.VISIT_RESULTS,
          routes: [],
        };
      if (url === '/api/marketing/routes')
        return {
          route: {
            id: '00000000-0000-4000-8000-000000000001',
            name: 'Rota',
            stops: data.stops,
            visitedCount: 0,
          },
        };
      throw Error('unexpected ' + url);
    };
    const evil = '<img src=x onerror="window.hacked=1">';
    w.fetch = async (url, init) => {
      requests.push({ url, method: init.method, data: JSON.parse(init.body) });
      return Response.json({
        places: [
          {
            placeId: 'ChIJfar000001',
            name: 'Uzak Mobilya',
            address: 'A',
            phone: '0312 222 22 22',
            lat: 39.95,
            lng: 32.9,
          },
          {
            placeId: 'ChIJevil00001',
            name: evil,
            address: '<script>window.hacked=2</script>',
            phone: '0532 111 11 11',
            lat: 39.9,
            lng: 32.8,
            website: 'javascript:window.hacked=3',
          },
          {
            placeId: 'ChIJnear00001',
            name: 'Yakın Mobilya',
            address: 'B',
            phone: '0533 333 33 33',
            lat: 39.91,
            lng: 32.81,
          },
        ],
        outside: 1,
        nextPageToken: '',
      });
    };
    w.eval(fs.readFileSync('outputs/icrapro/workspace-marketing-route.js', 'utf8'));
    w.eval(fs.readFileSync('outputs/icrapro/workspace-marketing.js', 'utf8'));
    const doc = w.document;
    const settle = async (done) => {
      for (let i = 0; i < 50 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(done(), 'page updated');
    };
    const change = (element, value) => {
      if (element.type === 'checkbox') element.checked = value;
      else element.value = value;
      element.dispatchEvent(new w.Event(element.type === 'search' ? 'input' : 'change', { bubbles: true }));
    };

    w.openMarketingRouteFinder();
    const form = doc.getElementById('marketingSearchForm');
    form.elements.sector.value = 'mobilya';
    form.elements.city.value = 'ankara';
    form.elements.district.value = 'ÇANKAYA';
    form.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await settle(() => doc.querySelectorAll('#marketingRows tr').length === 3);
    assert.deepEqual(requests.at(-1).data, {
      sector: 'mobilya',
      customQuery: '',
      city: 'Ankara',
      district: 'Çankaya',
      neighborhood: '',
      avenue: '',
      street: '',
    });
    assert.equal(doc.querySelectorAll('img, script').length, 0);
    assert.equal(w.hacked, undefined);
    assert.ok(doc.getElementById('marketingRows').textContent.includes(evil), 'shown as text');
    assert.equal(doc.querySelector('a[href^="javascript"]'), null);
    assert.match(doc.getElementById('marketingResultSummary').textContent, /1 il dışı/);
    assert.equal(doc.querySelector('.marketing-attribution').textContent, 'Google Maps');

    change(doc.querySelector('#marketingFilters [name="phone"]'), 'mobile');
    assert.equal(doc.querySelectorAll('#marketingRows tr').length, 2);
    doc.getElementById('marketingSelectAll').click();
    assert.match(doc.getElementById('marketingResultSummary').textContent, /2 seçili/);
    change(doc.querySelector('#marketingFilters [name="phone"]'), '');
    assert.equal(doc.getElementById('marketingSelectAll').indeterminate, true);
    assert.equal(doc.getElementById('marketingBuild').textContent, 'Rota Oluştur (2)');

    doc.getElementById('marketingBuild').click();
    const shares = [...doc.querySelectorAll('#marketingPlan [data-route-share]')];
    assert.equal(shares.length, 2);
    const maps = new URL(shares[0].href);
    assert.equal(maps.origin + maps.pathname, 'https://www.google.com/maps/dir/');
    assert.equal(maps.searchParams.get('waypoint_place_ids'), 'ChIJevil00001');
    assert.equal(maps.searchParams.get('destination_place_id'), 'ChIJnear00001');
    assert.ok(shares[1].href.startsWith('https://wa.me/905321112233?text='));
    const message = decodeURIComponent(shares[1].href.split('text=')[1]);
    assert.ok(message.includes('Yakın Mobilya') && message.includes(maps.href));

    doc.addEventListener('click', (event) => event.preventDefault());
    shares[0].click();
    const saved = requests.find((item) => item.url === '/api/marketing/routes');
    assert.equal(saved.method, 'POST');
    assert.deepEqual(saved.data.stops, ['ChIJevil00001', 'ChIJnear00001']);
    assert.equal(saved.data.city, 'Ankara');
    assert.deepEqual(saved.data.origin, { mode: 'none', label: '' });
    await settle(() => /Kaydedildi/.test(doc.getElementById('marketingPlan').textContent));
    assert.match(doc.getElementById('marketingRows').textContent, /Planlandı/);
    shares[1].click();
    assert.equal(requests.filter((item) => item.url === '/api/marketing/routes').length, 1, 'saved once');
  } finally {
    w.close();
  }
});

test('Google Haritalar settings never show the key and keep sector IDs when sectors are edited', () => {
  const dom = new JSDOM('<div id="content"></div>', {
    url: 'https://example.test',
    runScripts: 'dangerously',
  });
  const w = dom.window;
  try {
    const requests = [];
    w.eval(fs.readFileSync('outputs/icrapro/html-safety.js', 'utf8'));
    w.eval(`
      var $ = (selector) => document.querySelector(selector);
      var esc = escapeHtml;
      var toasts = [];
      function toast(text) { toasts.push(text); }
      var hanAuth = { role: 'ceo' };
      function settingsSectionTabs() { return ''; }
      function bindSettingsSectionTabs() {}
    `);
    w.authApi = (url, method = 'GET', data) => {
      requests.push({ url, method, data: data === undefined ? undefined : JSON.parse(JSON.stringify(data)) });
      if (url === '/api/marketing/config' && method === 'GET')
        return {
          enabled: true,
          apiKeySaved: true,
          encryptionReady: true,
          ready: true,
          sectors: [
            { id: 'mobilya', label: 'Mobilya', query: 'mobilya mağazası' },
            { id: 'hirdavat', label: 'Hırdavat', query: 'Hırdavat' },
          ],
        };
      return {};
    };
    w.eval(fs.readFileSync('outputs/icrapro/workspace-marketing-route.js', 'utf8'));
    w.eval(fs.readFileSync('outputs/icrapro/workspace-marketing.js', 'utf8'));
    w.mapsSettingsPage();
    const form = w.document.getElementById('mapsConfigForm');
    assert.equal(form.elements.apiKey.type, 'password');
    assert.equal(form.elements.apiKey.value, '');
    assert.equal(form.elements.sectors.value, 'Mobilya | mobilya mağazası\nHırdavat');
    form.elements.sectors.value = 'mobilya | mobilya\nPerde | perde mağazası\n\n';
    form.elements.scraperUrl.value = 'http://127.0.0.1:8080';
    form.elements.scraperUrl.dispatchEvent(new w.Event('input'));
    form.elements.scraperAuth.value = 'Basic c2VjcmV0';
    form.elements.defaultSource.value = 'scraper';
    assert.equal(form.elements.scraperAuth.type, 'password');
    form.dispatchEvent(new w.Event('submit', { cancelable: true }));
    const saved = requests.find((item) => item.method === 'PUT');
    assert.deepEqual(saved.data, {
      enabled: true,
      apiKey: '',
      clearApiKey: false,
      scraperEnabled: true,
      scraperUrl: 'http://127.0.0.1:8080',
      scraperAuth: 'Basic c2VjcmV0',
      clearScraperAuth: false,
      defaultSource: 'scraper',
      sectors: [
        { id: 'mobilya', label: 'mobilya', query: 'mobilya' },
        { label: 'Perde', query: 'perde mağazası' },
      ],
    });
  } finally {
    w.close();
  }
});
