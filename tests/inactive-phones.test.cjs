const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { JSDOM } = require('jsdom');
const { fixture, database, serve, password } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createApplication } = require('../lib/application.cjs');
const { businessDate } = require('../lib/business-time.cjs');
for (const records of [false, true])
  test(
    'Inactive phone status persists, filters call choices and respects permissions and file locks: ' +
      records,
    async () => {
      const { pg, pool } = await database();
      let server;
      try {
        const s = fixture();
        s.users.push(
          { ...s.users[0], id: 'manager', username: 'manager', role: 'admin' },
          { ...s.users[0], id: 'readonly', username: 'readonly', role: 'admin', readOnly: true },
          {
            ...s.users[0],
            id: 'denied',
            username: 'denied',
            role: 'admin',
            modulePermissions: { documents: { update: false } },
          },
        );
        s.data['icrapro-v1'].clients = [{ id: 'client', name: 'Client' }];
        s.data['icrapro-v1'].docs = [
          {
            id: 'd',
            number: '1',
            client: 'client',
            debtor: 'Borrower',
            phone1: '05320000001',
            phone2: '05320000002',
            referencePhone1: '905320000001',
            additionalPhones: ['05320000003'],
            status: 'Derdest',
            docType: 'Senet',
            amount: 1000,
            financeInterest: 0,
            financeFee: 0,
            financeTermsManual: true,
            due: businessDate(),
          },
        ];
        s.data['hanhukuk-finance-v1'] = [
          { id: 'payment', documentId: 'd', type: 'payment', amount: 10000, date: businessDate() },
        ];
        await importState(pool, s);
        if (records) {
          await importRecords(pool);
          await activateRecords(pool);
        }
        const store = createStore(pool, { records });
        server = await serve(createApplication({ store }));
        const login = async (username) => {
          const r = await fetch(server.url + '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
            body: JSON.stringify({ username, password }),
          });
          assert.equal(r.status, 200);
          return {
            cookie: r.headers.get('set-cookie').split(';')[0],
            'Content-Type': 'application/json',
            'X-Han-Request': '1',
          };
        };
        const ceo = await login('test'),
          manager = await login('manager'),
          readonly = await login('readonly'),
          denied = await login('denied');
        const patch = async (before, after, headers = manager) => {
          const r = await fetch(server.url + '/api/data/patch?key=icrapro-v1&operation=intake', {
            method: 'PUT',
            headers,
            body: JSON.stringify({
              changes: [
                { path: ['docs'], id: 'd', field: 'inactivePhones', before, after: { value: after } },
              ],
            }),
          });
          return { status: r.status, body: await r.json() };
        };
        assert.equal((await patch({}, ['05320000001'], readonly)).status, 403);
        assert.equal((await patch({}, ['05320000001'], denied)).status, 403);
        assert.equal((await patch({}, 'bad')).status, 400);
        let result = await patch({}, ['0 (532) 000 00 01', '905320000001']);
        assert.equal(result.status, 200, JSON.stringify(result.body));
        let saved = await store.readState();
        assert.deepEqual(saved.data['icrapro-v1'].docs[0].inactivePhones, ['5320000001']);
        assert.equal((await patch({}, ['05320000002'])).status, 409);
        const calls = await fetch(server.url + '/api/voip/calls?documentId=d', { headers: manager });
        assert.equal(calls.status, 200, await calls.clone().text());
        assert.deepEqual(
          (await calls.json()).phones.map((p) => p.phone),
          ['905320000002', '905320000003'],
        );
        if (records) {
          const lease = async (action) => {
            const r = await fetch(server.url + '/api/documents/lease', {
              method: 'POST',
              headers: ceo,
              body: JSON.stringify({ documentId: 'd', viewId: 'inactive-phones-window-01', action }),
            });
            return { status: r.status, body: await r.json() };
          };
          assert.equal((await lease('acquire')).status, 200);
          assert.equal((await patch({ value: ['5320000001'] }, [])).status, 423);
          assert.equal((await lease('release')).status, 200);
        }
        result = await patch({ value: ['5320000001'] }, []);
        assert.equal(result.status, 200, JSON.stringify(result.body));
        const active = await fetch(server.url + '/api/voip/calls?documentId=d', { headers: manager });
        assert((await active.json()).phones.some((p) => p.phone === '905320000001'));
        saved = await store.readState();
        assert.equal(saved.data['icrapro-v1'].docs[0].phone1, '0 (532) 000 00 01');
        assert.deepEqual(saved.data['hanhukuk-finance-v1'], s.data['hanhukuk-finance-v1']);
        assert.deepEqual(saved.data['hanhukuk-accounting-v1'], s.data['hanhukuk-accounting-v1']);
      } finally {
        await server?.close();
        await pg.close();
      }
    },
  );

test('Ara owns the inactive action; the header hides passive numbers and identity contacts retain and reactivate them', async (t) => {
  const dom = new JSDOM(
    '<dialog open><div class="sheet-header-actions"></div><div class="sheet-metadata"><div data-header-phones></div></div><section data-borrower-panel="personal"></section><section data-borrower-panel="conversations"></section></dialog>',
    { runScripts: 'dangerously' },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    root = path.join(__dirname, '../outputs/icrapro');
  const doc = {
    id: 'd',
    phone1: '05320000001',
    phone2: '05320000002',
    phoneSources: { 5320000001: 'Kendisi' },
  };
  const saves = [],
    events = [];
  Object.assign(w, {
    hanAuth: { role: 'admin' },
    setupVoipConversations: () => {},
    toast: () => {},
    saveRecordIntakeMetadata: async (original, next) => {
      saves.push({ original: structuredClone(original), next: structuredClone(next) });
      return next;
    },
    esc: (v) =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
  });
  w.eval(fs.readFileSync(path.join(root, 'phone-format.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(root, 'borrower-sheet.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(root, 'workspace-voip.js'), 'utf8'));
  w.setupVoipConversations = () => {};
  w.setInterval = () => 1;
  w.clearInterval = () => {};
  w.voipApi = async () => ({
    phones: [
      { phone: '905320000001', label: 'Tel-1' },
      { phone: '905320000002', label: 'Tel-2' },
    ],
    calls: [],
    active: [],
    enabled: false,
    extension: '',
    acrDevices: [],
  });
  w.document.addEventListener('borrower-phone-status-changed', (e) => events.push(e.detail));
  const dialog = w.document.querySelector('dialog'),
    meta = dialog.querySelector('.sheet-metadata');
  const personal = dialog.querySelector('[data-borrower-panel="personal"]');
  personal.innerHTML =
    w.borrowerPersonalPhoneMarkup(doc, 'Tel-1', doc.phone1) +
    w.borrowerPersonalPhoneMarkup(doc, 'Tel-2', doc.phone2);
  w.setupBorrowerHeaderPhones(dialog, meta, doc);
  w.setupBorrowerHeaderPhones(dialog, meta, doc);
  w.setupBorrowerVoip(dialog, doc);
  dialog.querySelector('[data-open-voip]').click();
  await new Promise((r) => setImmediate(r));
  assert.equal(meta.querySelectorAll('button').length, 0);
  await dialog.querySelector('[data-inactivate-phone="905320000001"]').onclick();
  assert.deepEqual([...doc.inactivePhones], ['5320000001']);
  assert(!meta.textContent.includes(doc.phone1));
  assert.equal(personal.querySelector('.borrower-inactive-phone-label').textContent, 'Pasife Alındı');
  assert.equal(dialog.querySelectorAll('.voip-phone-row').length, 1);
  assert(!dialog.querySelector('[data-dial-phone="905320000001"]'));
  assert.equal(doc.phone1, '05320000001');
  assert.equal(doc.phoneSources['5320000001'], 'Kendisi');
  assert.equal(events.length, 1);
  assert.equal(saves.length, 1);
  personal.querySelector('[data-reactivate-phone="5320000001"]').click();
  await new Promise((r) => setImmediate(r));
  assert.equal(doc.inactivePhones.length, 0);
  assert.equal(personal.querySelectorAll('.borrower-inactive-phone-label').length, 0);
  assert(meta.textContent.includes(doc.phone1));
  assert.equal(dialog.querySelectorAll('.voip-phone-row').length, 2);
  assert.equal(events.length, 2);
  assert.equal(saves.length, 2);
  await w.setBorrowerPhoneInactive(dialog, doc, doc.phone1, true);
  await w.setBorrowerPhoneInactive(dialog, doc, doc.phone2, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(meta.textContent, '—');
  assert.equal(personal.querySelectorAll('.borrower-inactive-phone-label').length, 2);
  assert.equal(dialog.querySelectorAll('.voip-phone-row').length, 0);
  w.hanAuth.readOnly = true;
  w.setupBorrowerHeaderPhones(dialog, meta, doc);
  assert([...personal.querySelectorAll('button')].every((b) => b.disabled));
  const count = saves.length;
  assert.equal(await w.setBorrowerPhoneInactive(dialog, doc, doc.phone1, false), false);
  assert.equal(saves.length, count);
});

test('A failed phone status save leaves the header and identity contacts unchanged and permits a retry', async (t) => {
  const dom = new JSDOM('<dialog open><div data-header-phones></div><section></section></dialog>', {
    runScripts: 'dangerously',
  });
  t.after(() => dom.window.close());
  const w = dom.window,
    doc = { id: 'd', phone1: '05320000001' },
    messages = [];
  let saves = 0;
  Object.assign(w, {
    hanAuth: { role: 'admin' },
    esc: String,
    toast: (message) => messages.push(message),
    saveRecordIntakeMetadata: async (_doc, next) => {
      if (++saves === 1) throw Error('Kayıt değişti');
      return next;
    },
  });
  for (const file of ['phone-format.js', 'borrower-sheet.js'])
    w.eval(fs.readFileSync(path.join(__dirname, '../outputs/icrapro', file), 'utf8'));
  const dialog = w.document.querySelector('dialog');
  dialog.querySelector('section').innerHTML = w.borrowerPersonalPhoneMarkup(doc, 'Tel-1', doc.phone1);
  w.setupBorrowerHeaderPhones(dialog, dialog, doc);
  assert.equal(await w.setBorrowerPhoneInactive(dialog, doc, doc.phone1, true), false);
  assert.equal(doc.inactivePhones, undefined);
  assert(dialog.querySelector('[data-header-phones]').textContent.includes(doc.phone1));
  assert.equal(dialog.querySelector('.borrower-inactive-phone-label'), null);
  assert(messages.includes('Kayıt değişti'));
  assert.equal(await w.setBorrowerPhoneInactive(dialog, doc, doc.phone1, true), true);
  assert.equal(dialog.querySelector('[data-header-phones]').textContent, '—');
  assert.equal(dialog.querySelector('.borrower-inactive-phone-label').textContent, 'Pasife Alındı');
});

test('Borrower header appends district and city to the address instead of showing a separate location cell', (t) => {
  const dom = new JSDOM(
    '<dialog open><div class="panelhead"><h2></h2></div><div class="formbody"></div></dialog>',
    { runScripts: 'dangerously' },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    root = path.join(__dirname, '../outputs/icrapro');
  Object.assign(w, {
    hanAuth: { role: 'admin' },
    personnel: [],
    financeEvents: [],
    esc: (v) => String(v ?? '').replaceAll('<', '&lt;'),
    borrowerTrackingDate: () => '',
    displayDate: (v) => v,
    businessDate: () => businessDate(),
    docType: () => 'Senet',
    debtorStatus: () => 'Derdest',
    financeCents: (v) => Math.round(Number(v || 0) * 100),
    money: String,
  });
  w.eval(fs.readFileSync(path.join(root, 'phone-format.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(root, 'borrower-sheet.js'), 'utf8'));
  for (const name of [
    'setupBorrowerResize',
    'setupBorrowerDragging',
    'setupBorrowerCornerResize',
    'setupBorrowerEnforcementFields',
    'moveRepaymentToAccount',
    'moveSheetActionsToHeader',
  ])
    w[name] = () => {};
  w.isParkingDocument = () => false;
  const doc = {
    id: 'd',
    number: '1',
    debtor: 'Borrower',
    address: 'Örnek Sokak 5',
    district: 'Kadıköy',
    city: 'İstanbul',
    phone1: '05320000001',
  };
  const dialog = w.document.querySelector('dialog');
  w.layoutBorrowerSheet(dialog, doc, {
    principal: 0,
    expenses: 0,
    discount: 0,
    target: 0,
    received: 0,
    remaining: 0,
  });
  assert.match(dialog.querySelector('.sheet-address').textContent, /Örnek Sokak 5 \/ Kadıköy \/ İstanbul/);
  assert(
    ![...dialog.querySelectorAll('.sheet-metadata > .sheet-meta-field > small')].some(
      (n) => n.textContent === 'İl / İlçe',
    ),
  );
  assert.equal(dialog.querySelector('[data-toggle-phone]'), null);
});
