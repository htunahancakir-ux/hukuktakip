const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { fixture, database, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
test('Receipt asks client and dates, includes both boundaries and all pages, and leaves the current intake batch untouched', async () => {
  const { pg, pool } = await database();
  let server, dom;
  try {
    const state = fixture();
    state.data['icrapro-v1'] = {
      clients: [
        { id: 'c', name: 'Client <A>' },
        { id: 'other', name: 'Other Client' },
      ],
      docs: Array.from({ length: 125 }, (_, i) => ({
        id: 'd' + String(i).padStart(3, '0'),
        number: 'S-' + (i + 1),
        client: 'c',
        docType: 'Senet',
        debtor: 'Borrower ' + i,
        status: 'Derdest',
        amount: 100,
        trackingDate: i === 124 ? '2026-11-30' : '2026-11-01',
        due: '2026-10-01',
      })),
    };
    for (const [id, client, date] of [
      ['before', 'c', '2026-10-31'],
      ['after', 'c', '2026-12-01'],
      ['other-client', 'other', '2026-11-10'],
    ])
      state.data['icrapro-v1'].docs.push({
        id,
        number: id,
        client,
        docType: 'Senet',
        status: 'Derdest',
        debtor: id,
        amount: 100,
        trackingDate: date,
      });
    state.deletedDocuments = [
      {
        id: 'archived',
        document: {
          id: 'removed',
          number: 'old',
          client: 'c',
          docType: 'Senet',
          amount: 100,
          trackingDate: '2026-11-10',
        },
      },
    ];
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store }));
    const login = await fetch(server.url + '/api/login', {
      method: 'POST',
      headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test', password }),
    });
    assert.equal(login.status, 200);
    const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
    async function get(input) {
      const r = await fetch(server.url + '/api/records/intake-batch?' + new URLSearchParams(input), {
        headers,
      });
      return { status: r.status, data: await r.json() };
    }
    let after = '',
      all = [],
      pages = 0;
    do {
      const r = await get({ client: 'c', from: '2026-11-01', to: '2026-11-30', after });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      all.push(...r.data.items);
      after = r.data.next || '';
      pages++;
    } while (after);
    assert.equal(pages, 2);
    assert.equal(all.length, 125);
    assert.equal(new Set(all.map((row) => row.record.id)).size, 125);
    assert(all.every((row) => row.record.client === 'c'));
    assert(all.some((row) => row.record.trackingDate === '2026-11-30'));
    assert.equal((await get({ client: 'c', from: '2026-11-30', to: '2026-11-01' })).status, 400);
    assert.equal((await get({ client: 'c', from: '2026-02-30', to: '2026-11-30' })).status, 400);
    assert.equal((await get({ from: '2026-11-01', to: '2026-11-30' })).status, 400);
    assert.equal(
      (await get({ client: "' OR 1=1 --", from: '2026-11-01', to: '2026-11-30' })).data.items.length,
      0,
    );
    assert.equal((await get({ ids: JSON.stringify(['other-client']) })).data.items.length, 1);
    dom = new JSDOM('<dialog id="modal"></dialog>', { url: server.url, runScripts: 'dangerously' });
    const w = dom.window;
    Object.assign(w, {
      db: { clients: [], docs: [] },
      selected: '',
      hanRecordsEnabled: true,
      hanAuth: { id: 'ceo', role: 'ceo' },
      businessDate: () => '2026-11-11',
      money: (value) => String(value) + ' TL',
      financeCents: (value) => Math.round(Number(value || 0) * 100),
      firmReceipt: () => '<b>Firm</b>',
      toast(message) {
        throw Error(message);
      },
      addWhatsAppFileButton() {},
      $: (selector) => w.document.querySelector(selector),
    });
    w.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    w.HTMLDialogElement.prototype.close = function () {
      this.open = false;
      this.dispatchEvent(new w.Event('close'));
    };
    w.fetch = (url, options = {}) =>
      fetch(server.url + url, { ...options, headers: { ...headers, ...options.headers }, signal: undefined });
    for (const file of [
      'html-safety.js',
      'form-inputs.js',
      'document-types.js',
      'document-records.js',
      'workspace-intake.js',
    ]) {
      const script = w.document.createElement('script');
      script.textContent = fs.readFileSync('outputs/icrapro/' + file, 'utf8');
      w.document.body.append(script);
    }
    w.esc = w.escapeHtml;
    w.sessionStorage.setItem(w.intakeBatchKey(), JSON.stringify(['existing-batch']));
    w.intakeBatchReceiptFilter();
    let form = w.document.querySelector('#intakeReceiptFilter');
    assert(form);
    assert.equal(form.elements.client.required, true);
    assert.equal(form.elements.from.required, true);
    assert.equal(form.elements.to.required, true);
    for (let i = 0; i < 100 && form.elements.client.options.length < 3; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    form.elements.client.value = 'c';
    form.elements.from.value = '2026-11-01';
    form.elements.to.value = '2026-11-30';
    await form.onsubmit({ preventDefault() {} });
    assert.equal(w.document.querySelectorAll('.receipt tbody tr').length, 125);
    assert.match(w.document.querySelector('.receipt').textContent, /Client <A>/);
    assert.match(w.document.querySelector('.receipt').textContent, /01\/11\/2026 – 30\/11\/2026/);
    assert.equal(w.document.querySelectorAll('img').length, 0);
    assert.deepEqual(JSON.parse(w.sessionStorage.getItem(w.intakeBatchKey())), ['existing-batch']);
    assert.equal(w.db.docs.length, 0);
    assert.equal(w.db.clients.length, 0);
    assert.equal((await store.readState()).data['icrapro-v1'].docs.length, 128);
  } finally {
    dom?.window.close();
    await server?.close();
    await pg.close();
  }
});
