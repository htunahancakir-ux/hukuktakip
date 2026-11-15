const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { password, fixture, database, serve } = require('./support/postgres.cjs');
const root = path.resolve(__dirname, '../outputs/icrapro');

// Eight clients in four cities; one city is written in capitals, as an import would leave it.
const clients = () =>
  [
    ['Sakarya Mobilya Ltd. Şti.', 'İstanbul', 'Kadıköy', '0 (532) 111 22 30', []],
    ['Ahmet Yılmaz', 'İstanbul', 'Üsküdar', '0 (533) 111 22 31', ['0 (216) 555 44 33']],
    ['Saka Tekstil A.Ş.', 'İstanbul', 'Kadıköy', '0 (534) 111 22 32', []],
    ['Mehmet Demir', 'Ankara', 'Çankaya', '0 (535) 111 22 33', []],
    ['Ege Gıda Ltd.', 'İzmir', 'Konak', '0 (536) 111 22 34', []],
    ['Başkent Oto', 'Ankara', 'Keçiören', '0 (537) 111 22 35', []],
    ['Kadıköy Züccaciye', 'İSTANBUL', 'KADIKÖY', '0 (538) 111 22 36', []],
    ['Uludağ Tekstil', 'Bursa', 'Nilüfer', '', []],
  ].map(([name, city, district, phone, additionalPhones], i) => ({
    id: 'c' + i,
    type: 'Şirket',
    name,
    fullName: '',
    tradeName: name,
    identity: String(1000000000 + i * 1111),
    phone,
    additionalPhones,
    email: '',
    address: '',
    city,
    district,
    clientCategory: 'Mağaza',
    createdAt: '2026-11-01T09:00:00.000Z',
    attachments: [],
  }));

test('client list: phone numbers, il and ilçe narrow the list on the server', async (t) => {
  const state = fixture();
  state.data['icrapro-v1'].clients = clients();
  const { pg, pool } = await database();
  await importState(pool, state);
  await importRecords(pool);
  await activateRecords(pool);
  const app = await serve(createApplication({ store: createStore(pool, { records: true }) }));
  t.after(async () => {
    await app.close();
    await pg.close();
  });
  const login = await fetch(app.url + '/api/login', {
    method: 'POST',
    headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test', password }),
  });
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'X-Han-Request': '1' };
  const list = async (query, status = 200) => {
    const response = await fetch(app.url + '/api/records/clients?' + new URLSearchParams(query), { headers });
    assert.equal(response.status, status);
    const result = await response.json();
    return status === 200
      ? { ids: result.items.map((c) => c.id).sort(), count: result.count, next: result.next }
      : result;
  };

  assert.equal((await list({})).count, '8');
  // İl, whatever its capitals; then one of its ilçe.
  assert.deepEqual((await list({ city: 'İstanbul' })).ids, ['c0', 'c1', 'c2', 'c6']);
  assert.deepEqual((await list({ city: 'istanbul', district: 'Kadıköy' })).ids, ['c0', 'c2', 'c6']);
  assert.deepEqual(
    (await list({ city: 'Ankara', district: 'Kadıköy' })).ids,
    [],
    'an ilçe of another il finds nothing',
  );
  // Name search inside an il.
  assert.deepEqual((await list({ q: 'sak', city: 'İstanbul' })).ids, ['c0', 'c2']);
  assert.deepEqual((await list({ q: 'sak', city: 'Ankara' })).ids, []);
  // A phone number however it is typed, also an additional number.
  for (const typed of [
    '0532 111',
    '532111',
    '(532) 111 22 30',
    '+90 532 111 22 30',
    '+90 532 111',
    '0090 532 111',
  ])
    assert.deepEqual((await list({ q: typed })).ids, ['c0'], typed);
  assert.deepEqual((await list({ q: '0216 555' })).ids, ['c1'], 'additional phone');
  assert.deepEqual((await list({ q: '111 22' })).ids, ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  assert.deepEqual((await list({ q: '111 22', city: 'Ankara' })).ids, ['c3', 'c5']);
  // Digits still find an identity number by its beginning; two digits are not a phone search.
  assert.deepEqual((await list({ q: '10000011' })).ids, ['c1']);
  assert.deepEqual((await list({ q: '22' })).ids, []);
  // Paging keeps the filter; a cursor of another filter is refused.
  const first = await list({ city: 'İstanbul', limit: 3 });
  assert.equal(first.count, '4');
  assert.equal((await list({ city: 'İstanbul', limit: 3, after: first.next })).ids.length, 1);
  await list({ city: 'Ankara', limit: 3, after: first.next }, 400);
  await list({ city: 'x'.repeat(201) }, 400);
  assert.deepEqual((await list({ city: "' OR 1=1 --" })).ids, []);
});

test('client list: the filter row narrows the list; choosing an il fills its ilçe', (t) => {
  const dom = new JSDOM(
    '<main><div id="bar"></div><table><tbody id="rows"></tbody></table><div id="total"></div></main>',
    {
      url: 'https://local-test.invalid',
      runScripts: 'dangerously',
    },
  );
  t.after(() => dom.window.close());
  const w = dom.window;
  Object.assign(w, {
    hanRecordsEnabled: false,
    esc: (value) => String(value ?? '').replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';'),
    $: (selector) => w.document.querySelector(selector),
    db: { clients: clients(), docs: [] },
    turkeyCities: ['Ankara', 'Bursa', 'İstanbul', 'İzmir'],
    turkeyDistricts: {
      Ankara: ['Çankaya', 'Keçiören'],
      Bursa: ['Nilüfer'],
      İstanbul: ['Kadıköy', 'Üsküdar'],
      İzmir: ['Konak'],
    },
  });
  w.eval(fs.readFileSync(path.join(root, 'client-records.js'), 'utf8'));
  w.document.getElementById('bar').innerHTML = w.clientFilterBar();
  w.bindClientSearch();
  w.clientRows();
  const $ = (selector) => w.document.querySelector(selector);
  // Each row carries its client twice (the name and "Düzenle").
  const shown = () =>
    [...new Set([...w.document.querySelectorAll('#rows [data-edit]')].map((b) => b.dataset.edit))].sort();
  const choose = (id, value) => {
    $(id).value = value;
    $(id).dispatchEvent(new w.Event('change'));
  };
  const type = (value) => {
    $('#search').value = value;
    $('#search').dispatchEvent(new w.Event('input'));
  };

  // Every control is labelled and sits in a search landmark.
  assert.equal($('search.client-filters').getAttribute('aria-label'), 'Müvekkil süzgeci');
  assert.equal($('label[for="search"]').textContent, 'Ad, kimlik no veya telefon');
  assert.match($('#clientCity').closest('label').textContent, /^İl/);
  assert.match($('#clientDistrict').closest('label').textContent, /^İlçe/);
  assert.equal(shown().length, 8);
  assert.equal($('#clientDistrict').disabled, true, 'no ilçe before an il');
  assert.equal($('#clientFilterClear').disabled, true, 'nothing to clear yet');

  choose('#clientCity', 'İstanbul');
  assert.deepEqual(shown(), ['c0', 'c1', 'c2', 'c6'], 'capitals in the record do not matter');
  assert.equal($('#clientDistrict').disabled, false);
  assert.deepEqual(
    [...$('#clientDistrict').options].map((o) => o.text),
    ['Tüm ilçeler', 'Kadıköy', 'Üsküdar'],
  );
  assert.match($('#total').textContent, /4 müvekkil gösteriliyor · Süzgeç uygulandı/);
  choose('#clientDistrict', 'Kadıköy');
  assert.deepEqual(shown(), ['c0', 'c2', 'c6']);
  type('sak');
  assert.deepEqual(shown(), ['c0', 'c2']);

  // Another il starts again with all of its ilçe.
  choose('#clientCity', 'Ankara');
  assert.equal($('#clientDistrict').value, '');
  assert.deepEqual(
    [...$('#clientDistrict').options].map((o) => o.text),
    ['Tüm ilçeler', 'Çankaya', 'Keçiören'],
  );
  assert.deepEqual(shown(), [], 'sak is not in Ankara');
  type('');
  assert.deepEqual(shown(), ['c3', 'c5']);

  // Temizle resets everything and is only enabled when there is something to reset.
  assert.equal($('#clientFilterClear').disabled, false);
  $('#clientFilterClear').click();
  assert.deepEqual(
    [$('#search').value, $('#clientCity').value, $('#clientDistrict').disabled],
    ['', '', true],
  );
  assert.equal(shown().length, 8);
  assert.equal($('#clientFilterClear').disabled, true);

  // Phone numbers, however they are typed.
  type('0216 555');
  assert.deepEqual(shown(), ['c1']);
  type('+90 532 111');
  assert.deepEqual(shown(), ['c0']);

  // The filter survives drawing the page again.
  choose('#clientCity', 'İstanbul');
  choose('#clientDistrict', 'Üsküdar');
  w.document.getElementById('bar').innerHTML = w.clientFilterBar();
  assert.deepEqual(
    [$('#clientCity').value, $('#clientDistrict').value, $('#clientDistrict').disabled],
    ['İstanbul', 'Üsküdar', false],
  );
});

test('client list on record tables: il, ilçe and the search text travel to the server and restart paging', async (t) => {
  const dom = new JSDOM(
    '<main><div id="stats"></div><span id="count"></span><div id="bar"></div><table><tbody id="rows"></tbody></table><div id="total"></div></main>',
    { url: 'https://local-test.invalid', runScripts: 'dangerously' },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    requests = [];
  Object.assign(w, {
    AbortController,
    hanRecordsEnabled: true,
    page: 'clients',
    hanAuth: { role: 'staff' },
    esc: (value) => String(value ?? ''),
    $: (selector) => w.document.querySelector(selector),
    db: { clients: [], docs: [] },
    turkeyCities: ['Ankara', 'İstanbul'],
    turkeyDistricts: { Ankara: ['Çankaya'], İstanbul: ['Kadıköy', 'Üsküdar'] },
    fetch: async (url) => {
      const params = new URL(url, w.location.origin).searchParams;
      requests.push(Object.fromEntries(params));
      const item = {
        id: 'c' + requests.length,
        name: 'Müvekkil ' + requests.length,
        type: 'Şirket',
        documentCount: '0',
      };
      return {
        ok: true,
        json: async () => ({ items: [item], count: '120', next: params.get('after') ? null : 'cursor-2' }),
      };
    },
  });
  for (const file of ['client-records.js', 'workspace-client-list.js'])
    w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  w.document.getElementById('bar').innerHTML = w.clientFilterBar();
  w.bindClientSearch();
  const $ = (selector) => w.document.querySelector(selector);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 260));
  const choose = async (id, value) => {
    $(id).value = value;
    $(id).dispatchEvent(new w.Event('change'));
    await settle();
  };

  w.clientRows();
  await settle();
  assert.deepEqual(requests.at(-1), { q: '', limit: '50' }, 'no filter: no il or ilçe in the request');

  await choose('#clientCity', 'İstanbul');
  assert.deepEqual(requests.at(-1), { q: '', limit: '50', city: 'İstanbul' });
  assert.match($('#total').textContent, /Süzgeç uygulandı/);
  $('#nextClients').click();
  await settle();
  assert.deepEqual(
    requests.at(-1),
    { q: '', limit: '50', city: 'İstanbul', after: 'cursor-2' },
    'paging keeps the filter',
  );

  await choose('#clientDistrict', 'Kadıköy');
  assert.deepEqual(
    requests.at(-1),
    { q: '', limit: '50', city: 'İstanbul', district: 'Kadıköy' },
    'a new filter starts at the first page',
  );

  $('#search').value = '0532 111';
  $('#search').dispatchEvent(new w.Event('input'));
  await settle();
  assert.deepEqual(requests.at(-1), { q: '0532 111', limit: '50', city: 'İstanbul', district: 'Kadıköy' });

  $('#clientFilterClear').click();
  await settle();
  assert.deepEqual(requests.at(-1), { q: '', limit: '50' });
  assert.equal($('#clientDistrict').disabled, true);
});
