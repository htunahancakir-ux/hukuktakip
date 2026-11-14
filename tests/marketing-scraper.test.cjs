const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const route = require('../outputs/icrapro/workspace-marketing-route.js');
const maps = require('../lib/maps-settings.cjs');
const scraper = require('../lib/map-scraper.cjs');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { database, fixture, serve } = require('./support/postgres.cjs');

const BASE = 'https://tarama.example.test';
const JOB = '0f0e0d0c-0b0a-4908-8706-050403020100';
const AUTH = 'Basic ' + Buffer.from('ofis:sentetik-parola').toString('base64');

async function withMapsKey(work) {
  const previous = process.env.MAPS_ENCRYPTION_KEY;
  process.env.MAPS_ENCRYPTION_KEY = 'c'.repeat(64);
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.MAPS_ENCRYPTION_KEY;
    else process.env.MAPS_ENCRYPTION_KEY = previous;
  }
}

const HEADER =
  'input_id,link,title,category,address,open_hours,popular_times,website,phone,plus_code,review_count,review_rating,reviews_per_rating,latitude,longitude,cid,status,descriptions,reviews_link,thumbnail,timezone,price_range,data_id,street_view_url,place_id';
function csvRow(values) {
  const fields = Object.fromEntries(HEADER.split(',').map((key) => [key, '']));
  Object.assign(fields, values);
  return HEADER.split(',')
    .map((key) => {
      const value = String(fields[key]);
      return /[",\n\r]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
    })
    .join(',');
}
const CSV = [
  HEADER,
  csvRow({
    title: 'Yeni "Mobilya", Ltd.',
    address: 'Kızılay, Atatürk Blv. No:12, 06420 Çankaya/Ankara',
    phone: '0532 123 45 67',
    website: 'https://yeni.example',
    review_count: '42',
    review_rating: '4.500000',
    latitude: '39.920800',
    longitude: '32.854100',
    status: 'Açık ⋅ Kapanış: 19:00',
    place_id: 'ChIJscraped001',
    open_hours: '{"Pazartesi":["09:00–19:00"]}',
  }),
  csvRow({
    title: 'Eski Mobilya',
    address: 'Bahçelievler, 7. Cd. No:3, 06490 Çankaya/Ankara, Türkiye',
    status: 'Kalıcı olarak kapandı',
    place_id: 'ChIJvisited01',
    latitude: '39.91',
    longitude: '32.83',
  }),
  csvRow({
    title: 'Komşu İlçe',
    address: 'Etlik, 1. Sk. No:1, 06010 Keçiören/Ankara',
    cid: '1234567890123456789',
    latitude: '0.000000',
    longitude: '0.000000',
  }),
  csvRow({ title: 'Başka İl', address: 'Moda, 34710 Kadıköy/İstanbul', place_id: 'ChIJistanbul1' }),
  csvRow({ title: 'Kimliksiz', address: 'Çankaya/Ankara' }),
].join('\r\n');

test('tarama sunucusu addresses: HTTPS domains in the cloud, loopback only when local', async () => {
  for (const value of [
    'http://tarama.example.test',
    'https://127.0.0.1:8080',
    'https://10.0.0.5',
    'https://localhost:8080',
    'https://tarama.local',
    'https://intranet',
    'https://user:pass@tarama.example.test',
    'https://tarama.example.test/?x=1',
    'javascript:alert(1)',
  ])
    assert.throws(
      () => maps.scraperUrl(value),
      (error) => error.code === 400,
      value,
    );
  assert.equal(maps.scraperUrl('https://tarama.example.test/gmaps/'), 'https://tarama.example.test/gmaps');
  assert.equal(maps.scraperUrl('https://tarama.example.test:8443'), 'https://tarama.example.test:8443');
  assert.equal(maps.scraperUrl('http://127.0.0.1:8080', { allowLocal: true }), 'http://127.0.0.1:8080');
  assert.equal(maps.scraperUrl('http://localhost:8080', { allowLocal: true }), 'http://localhost:8080');
  assert.throws(
    () => maps.scraperUrl('http://10.0.0.5:8080', { allowLocal: true }),
    (error) => error.code === 400,
  );

  await withMapsKey(() => {
    const local = { allowLocal: true };
    const saved = maps.configure(
      {},
      {
        enabled: false,
        scraperEnabled: true,
        scraperUrl: 'http://127.0.0.1:8080',
        scraperAuth: AUTH,
        defaultSource: 'scraper',
      },
      local,
    );
    assert.notEqual(saved.sealedScraperAuth, AUTH);
    const shown = maps.publicConfig(saved, local);
    assert.equal(shown.scraperReady, true);
    assert.equal(shown.defaultSource, 'scraper');
    assert.equal(JSON.stringify(shown).includes('sentetik'), false, 'the access key is never published');
    assert.deepEqual(maps.runtimeScraper(saved, local), {
      url: 'http://127.0.0.1:8080',
      authorization: AUTH,
    });
    // The same saved loopback address is not usable once the app runs in the cloud.
    assert.equal(maps.publicConfig(saved).scraperReady, false);
    assert.throws(
      () => maps.runtimeScraper(saved),
      (error) => error.code === 503,
    );
    assert.throws(
      () => maps.configure({}, { enabled: false, scraperEnabled: true }, local),
      (error) => error.code === 400,
    );
    assert.throws(
      () => maps.configure({}, { enabled: false, scraperAuth: 'a\nb' }, local),
      (error) => error.code === 400,
    );
    assert.throws(
      () => maps.configure({}, { enabled: false, defaultSource: 'yandex' }),
      (error) => error.code === 400,
    );
    assert.equal(
      maps.configure(saved, { enabled: false, clearScraperAuth: true }, local).sealedScraperAuth,
      '',
    );
  });
});

test('gosom client builds jobs, reads status and turns CSV rows into firms', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'POST') return Response.json({ id: JOB }, { status: 201 });
    if (url.endsWith('/download')) return new Response(CSV, { headers: { 'Content-Type': 'text/csv' } });
    return Response.json({ ID: JOB, Status: 'ok' });
  };
  const id = await scraper.createJob({
    url: BASE,
    authorization: AUTH,
    keywords: 'mobilya Çankaya Ankara',
    depth: 'quick',
    fetcher,
  });
  assert.equal(id, JOB);
  assert.equal(calls[0].url, BASE + '/api/v1/jobs');
  assert.equal(calls[0].init.headers.Authorization, AUTH);
  assert.equal(calls[0].init.redirect, 'error');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(
    {
      keywords: body.keywords,
      lang: body.lang,
      depth: body.depth,
      max_time: body.max_time,
      email: body.email,
    },
    { keywords: ['mobilya Çankaya Ankara'], lang: 'tr', depth: 1, max_time: 300, email: false },
  );
  assert.ok(body.name);
  assert.equal(await scraper.jobStatus({ url: BASE, id: JOB, fetcher }), 'ok');
  assert.equal(calls.at(-1).url, BASE + '/api/v1/jobs/' + JOB);
  const found = await scraper.jobPlaces({ url: BASE, id: JOB, fetcher });
  assert.deepEqual(
    found.map((place) => place.id),
    ['ChIJscraped001', 'ChIJvisited01', 'cid-1234567890123456789', 'ChIJistanbul1'],
  );
  const [first, closed, unlocated] = found;
  assert.equal(first.displayName.text, 'Yeni "Mobilya", Ltd.');
  assert.equal(first.nationalPhoneNumber, '0532 123 45 67');
  assert.deepEqual(first.location, { latitude: 39.9208, longitude: 32.8541 });
  assert.equal(first.rating, 4.5);
  assert.equal(first.userRatingCount, 42);
  assert.deepEqual(first.currentOpeningHours, { openNow: true });
  assert.deepEqual(
    first.addressComponents.map((item) => item.longText),
    ['Ankara', 'Çankaya'],
  );
  assert.equal(closed.businessStatus, 'CLOSED_PERMANENTLY');
  assert.equal(unlocated.location, undefined, '0,0 is a missing location');

  assert.deepEqual(scraper.areaFromAddress('Kızılay, 06420 Çankaya/Ankara, Türkiye'), {
    district: 'Çankaya',
    city: 'Ankara',
  });
  assert.deepEqual(scraper.areaFromAddress('adres yok'), { city: '', district: '' });
  assert.deepEqual(scraper.parseCsv('a,b\r\n"x,""y""\nz",2\r\n\r\n'), [{ a: 'x,"y"\nz', b: '2' }]);

  for (const [status, code] of [
    [401, 503],
    [404, 404],
    [422, 400],
    [500, 503],
  ])
    await assert.rejects(
      scraper.jobStatus({ url: BASE, id: JOB, fetcher: async () => new Response('{}', { status }) }),
      (error) => error.code === code,
    );
  await assert.rejects(
    scraper.createJob({
      url: BASE,
      keywords: 'x',
      fetcher: async () => Response.json({ id: '../../etc' }, { status: 201 }),
    }),
    (error) => error.code === 503,
  );
  await assert.rejects(
    scraper.jobStatus({
      url: BASE,
      id: JOB,
      fetcher: async () => {
        throw new Error('down');
      },
    }),
    (error) => error.code === 503,
  );
});

test('Rota Bulma scraping over HTTP: jobs, visits, saved copies, access and no held database', async (t) => {
  await withMapsKey(async () => {
    const { pg, pool } = await database();
    const state = fixture();
    const ceo = state.users[0];
    state.users.push(
      { ...ceo, id: 'seller', username: 'seller', name: 'Satış', role: 'staff', staffId: 'p-seller' },
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
        createdBy: 'seller',
        company: 'Eski Mobilya',
        placeId: 'ChIJvisited01',
        date: '2026-11-01',
        visitResult: 'Görüşüldü',
        staffName: 'Satış',
        city: 'Ankara',
        district: 'Çankaya',
        status: 'Potansiyel Müvekkil',
      },
    ];
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    let status = 'working';
    const calls = [];
    const mapsFetch = async (url, init) => {
      calls.push({ url, init });
      // PGlite has one queued connection: a transaction held across this call would block here.
      await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_, reject) =>
          setTimeout(() => reject(Error('database held during scraper call')), 5000),
        ),
      ]);
      if (!url.startsWith(BASE)) throw Error('unexpected outside call ' + url);
      if (init.method === 'POST') return Response.json({ id: JOB }, { status: 201 });
      if (url.endsWith('/download')) return new Response(CSV);
      return Response.json({ ID: JOB, Status: status });
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
      assert.equal(text.includes('sentetik'), false, 'the access key never reaches a browser');
      return { status: response.status, body: JSON.parse(text || '{}') };
    };
    const search = { sector: 'mobilya', city: 'Ankara', district: 'Çankaya' };

    assert.equal(
      (await call(asSeller, '/api/marketing/scrape', 'POST', search)).status,
      503,
      'not configured',
    );
    let reply = await call(asCeo, '/api/marketing/config', 'PUT', {
      enabled: false,
      scraperEnabled: true,
      scraperUrl: BASE,
      scraperAuth: AUTH,
      defaultSource: 'scraper',
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.scraperReady, true);
    reply = await call(asSeller, '/api/marketing/overview');
    assert.equal(reply.body.defaultSource, 'scraper');
    assert.deepEqual(
      reply.body.sources.map((source) => [source.id, source.ready]),
      [
        ['google', false],
        ['scraper', true],
      ],
    );
    assert.equal(JSON.stringify(reply.body).includes(BASE), false, 'staff never see the server address');
    assert.equal((await call(asCeo, '/api/marketing/test', 'POST', { source: 'scraper' })).status, 200);

    assert.equal((await call(asOther, '/api/marketing/scrape', 'POST', search)).status, 403);
    reply = await call(asViewer, '/api/marketing/scrape', 'POST', search);
    assert.equal(reply.status, 403);
    assert.match(reply.body.error, /salt okunur/);
    reply = await call(asSeller, '/api/marketing/scrape', 'POST', { ...search, depth: 'wide' });
    assert.equal(reply.status, 202, JSON.stringify(reply.body));
    assert.deepEqual(reply.body, { jobId: JOB, depth: 'wide' });
    const created = calls.find((item) => item.init.method === 'POST');
    assert.equal(created.init.headers.Authorization, AUTH);
    assert.deepEqual(JSON.parse(created.init.body).keywords, ['mobilya mağazası Çankaya Ankara']);

    assert.equal(
      (await call(asSeller, '/api/marketing/scrape-status', 'POST', { ...search, jobId: '../x' })).status,
      400,
    );
    reply = await call(asSeller, '/api/marketing/scrape-status', 'POST', { ...search, jobId: JOB });
    assert.deepEqual(reply.body, { status: 'working' });
    status = 'ok';
    reply = await call(asSeller, '/api/marketing/scrape-status', 'POST', { ...search, jobId: JOB });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.status, 'ok');
    assert.equal(reply.body.outside, 1, 'Kadıköy/İstanbul is dropped');
    const byId = Object.fromEntries(reply.body.places.map((place) => [place.placeId, place]));
    assert.deepEqual(Object.keys(byId), ['ChIJscraped001', 'ChIJvisited01', 'cid-1234567890123456789']);
    assert.equal(
      byId.ChIJvisited01.visit.result,
      'Görüşüldü',
      'visits match Google place IDs from either source',
    );
    assert.equal(byId.ChIJvisited01.businessStatus, 'CLOSED_PERMANENTLY');
    assert.equal(byId['cid-1234567890123456789'].inDistrict, false);
    assert.equal(byId.ChIJscraped001.openNow, true);
    status = 'failed';
    assert.equal(
      (await call(asSeller, '/api/marketing/scrape-status', 'POST', { ...search, jobId: JOB })).status,
      502,
    );

    const first = byId.ChIJscraped001;
    const plan = {
      ...search,
      requestId: 'scrape-route-0001',
      source: 'scraper',
      stops: [first.placeId],
      places: [
        {
          placeId: first.placeId,
          name: first.name,
          address: first.address,
          phone: first.phone,
          lat: first.lat,
          lng: first.lng,
        },
      ],
    };
    assert.equal(
      (await call(asSeller, '/api/marketing/routes', 'POST', { ...plan, places: [] })).status,
      400,
    );
    reply = await call(asSeller, '/api/marketing/routes', 'POST', plan);
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.route.source, 'scraper');
    assert.equal(reply.body.route.snapshot, undefined, 'the copy stays on the server');
    const before = calls.length;
    reply = await call(asSeller, '/api/marketing/route-places', 'POST', { routeId: reply.body.route.id });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(calls.length, before, 'saved scraped routes open without outside calls');
    assert.equal(reply.body.places[0].name, 'Yeni "Mobilya", Ltd.');
    assert.equal(reply.body.places[0].lat, 39.9208);
  });
});

test('Rota Bulma page runs a scrape, polls until results arrive and saves the route with its copy', async () => {
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
      function render() {}
      var page = 'marketing';
      var settingsTab = 'firm';
      var hanAuth = { role: 'staff', name: 'Satış', staffId: 'p' };
      var turkeyDistricts = { Ankara: ['Çankaya'] };
      var hanMarketingPollMs = 5;
      function clientCityField() {
        return '<input id="routeCity" name="city"><input id="routeDistrict" name="district">';
      }
      function setupClientCity() {}
      function setupClientDistrict() {}
    `);
    w.authApi = (url, method = 'GET', data) => {
      requests.push({ url, method, data: data === undefined ? undefined : JSON.parse(JSON.stringify(data)) });
      if (url === '/api/marketing/overview')
        return {
          ready: false,
          sources: [
            { id: 'google', label: 'Google Places API', ready: true },
            { id: 'scraper', label: 'Harita tarama (gosom)', ready: true },
          ],
          defaultSource: 'scraper',
          canConfigure: false,
          selfPhone: '',
          sectors: [{ id: 'mobilya', label: 'Mobilya' }],
          office: {},
          visitResults: route.VISIT_RESULTS,
          routes: [],
        };
      if (url === '/api/marketing/routes')
        return {
          route: {
            id: '00000000-0000-4000-8000-000000000002',
            name: 'R',
            stops: data.stops,
            visitedCount: 0,
          },
        };
      throw Error('unexpected ' + url);
    };
    let polls = 0;
    w.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, method: init.method, data: body });
      if (url === '/api/marketing/scrape')
        return Response.json({ jobId: JOB, depth: body.depth }, { status: 202 });
      if (url === '/api/marketing/scrape-status')
        return ++polls < 3
          ? Response.json({ status: 'working' })
          : Response.json({
              status: 'ok',
              outside: 0,
              places: [
                {
                  placeId: 'ChIJscraped001',
                  name: 'Taranan Mobilya',
                  address: 'A',
                  phone: '0532 111 11 11',
                  lat: 39.9,
                  lng: 32.8,
                },
              ],
            });
      throw Error('unexpected ' + url);
    };
    w.eval(fs.readFileSync('outputs/icrapro/workspace-marketing-route.js', 'utf8'));
    w.eval(fs.readFileSync('outputs/icrapro/workspace-marketing.js', 'utf8'));
    const doc = w.document;
    const settle = async (done) => {
      for (let i = 0; i < 100 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(done(), 'page updated');
    };

    w.openMarketingRouteFinder();
    const form = doc.getElementById('marketingSearchForm');
    assert.equal(form.elements.source.value, 'scraper', 'the office default is preselected');
    assert.equal(doc.getElementById('marketingDepthField').hidden, false);
    form.querySelector('[name="sector"][value="mobilya"]').click();
    form.elements.city.value = 'Ankara';
    form.elements.district.value = 'Çankaya';
    form.elements.depth.value = 'quick';
    form.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await settle(() => /Harita taraması sürüyor/.test(doc.getElementById('marketingResults').textContent));
    assert.equal(requests.find((item) => item.url === '/api/marketing/scrape').data.depth, 'quick');
    assert.equal(doc.getElementById('marketingSearchButton').disabled, true, 'one scrape at a time');
    await settle(() => doc.querySelectorAll('#marketingRows tr').length === 1);
    assert.equal(polls, 3);
    assert.deepEqual(
      requests.filter((item) => item.url === '/api/marketing/scrape-status').map((item) => item.data.jobId),
      [JOB, JOB, JOB],
    );
    assert.match(doc.querySelector('.marketing-section-head').textContent, /Harita tarama \(gosom\)/);
    assert.equal(doc.getElementById('marketingMore'), null, 'scraping has no next page');

    doc.getElementById('marketingSelectAll').click();
    doc.getElementById('marketingBuild').click();
    doc.addEventListener('click', (event) => event.preventDefault());
    doc.querySelector('#marketingPlan [data-route-share]').click();
    const saved = requests.find((item) => item.url === '/api/marketing/routes');
    assert.equal(saved.data.source, 'scraper');
    assert.deepEqual(saved.data.places, [
      {
        placeId: 'ChIJscraped001',
        name: 'Taranan Mobilya',
        address: 'A',
        phone: '0532 111 11 11',
        lat: 39.9,
        lng: 32.8,
      },
    ]);
  } finally {
    w.close();
  }
});
