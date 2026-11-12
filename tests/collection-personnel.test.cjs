const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');
const { businessDate } = require('../lib/business-time.cjs');
const escape = (v) =>
  String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('"', '&quot;');

test('Collection form requires an explicit turnover selection and keeps Other categories available', () => {
  const dom = new JSDOM('<form></form>', { runScripts: 'dangerously' });
  try {
    dom.window.staffSelect = (label, name) =>
      `<label>${label}<select name="${name}"><option value="">Personel seçin</option><option value="p">Personel</option></select></label>`;
    dom.window.eval(fs.readFileSync('outputs/icrapro/finance-operations.js', 'utf8'));
    const form = dom.window.document.querySelector('form');
    form.innerHTML = dom.window.turnoverStaffField();
    assert.equal(form.elements.turnoverStaffId.required, true);
    assert.equal(form.elements.turnoverStaffId.checkValidity(), false);
    assert(!form.textContent.includes('Dosya sorumlusu'));
    form.elements.turnoverStaffId.value = 'p';
    assert.equal(form.elements.turnoverStaffId.checkValidity(), true);
    assert(form.querySelector('[value="__other__"]'));
    assert.equal(form.elements.turnoverOther.options.length, 4);
  } finally {
    dom.window.close();
  }
});

test('Top-right receipt credits the collector, escapes the name and supports legacy notices', () => {
  for (const [notice, expected] of [
    [
      { operatorName: 'Kaydı Giren', collectionStaffName: 'Ödemeyi Alan <img src=x onerror=alert(1)>' },
      'Ödemeyi Alan <img src=x onerror=alert(1)>',
    ],
    [{ operatorName: 'Eski Bildirim' }, 'Eski Bildirim'],
  ]) {
    const dom = new JSDOM('<main></main>', { runScripts: 'dangerously' });
    try {
      Object.assign(dom.window, {
        hanAuth: {},
        collectionNoticeShowing: false,
        collectionNoticeQueue: [{ ...notice, amount: 10000, createdAt: new Date().toISOString() }],
        esc: escape,
        money: (v) => String(v),
        messageTimestamp: () => 'Şimdi',
        setTimeout: () => 0,
      });
      dom.window.eval(fs.readFileSync('outputs/icrapro/workspace-reminders.js', 'utf8'));
      dom.window.showNextCollectionNotice();
      const receipt = dom.window.document.querySelector('.collection-receipt');
      assert(receipt.textContent.includes(expected));
      if (notice.collectionStaffName) assert(!receipt.textContent.includes('Kaydı Giren'));
      assert.equal(receipt.querySelectorAll('img').length, 0);
    } finally {
      dom.window.close();
    }
  }
});

test('API rejects missing or inactive selection; notification credits selected personnel while audit retains the operator', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture(),
      today = businessDate();
    state.users[0].name = 'Kaydı Giren Yönetici';
    state.users.push({
      ...state.users[0],
      id: 'staff-user',
      username: 'staff',
      name: 'Personel Kullanıcısı',
      role: 'staff',
      staffId: 'assigned',
      permissions: ['documents'],
    });
    state.data['icrapro-personnel-v1'] = [
      { id: 'assigned', name: 'Dosya Sorumlusu', active: true, department: 'İcra' },
      { id: 'collector', name: 'Ödemeyi Alan Personel', active: true, department: 'İcra' },
      { id: 'inactive', name: 'Pasif Personel', active: false, department: 'İcra' },
    ];
    state.data['icrapro-v1'] = {
      clients: [{ id: 'client', name: 'Müvekkil' }],
      docs: [
        {
          id: 'doc',
          number: 'S-1',
          client: 'client',
          relatedStaff: 'assigned',
          amount: 100000,
          status: 'Derdest',
        },
        { id: 'unassigned', number: 'S-2', client: 'client', amount: 100000, status: 'Derdest' },
      ],
    };
    state.data['hanhukuk-accounting-v1'] = {
      accounts: [{ id: 'cash', name: 'Kasa' }],
      entries: [{ id: 'fund', type: 'in', accountId: 'cash', date: today, amount: 1000000 }],
    };
    state.data['hanhukuk-finance-v1'] = [
      { id: 'legacy', documentId: 'doc', type: 'payment', date: today, amount: 100, accountId: 'cash' },
    ];
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store }));
    const login = async (username) => {
      const r = await fetch(server.url + '/api/login', {
        method: 'POST',
        headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(r.status, 200, await r.text());
      return {
        cookie: r.headers.get('set-cookie').split(';')[0],
        'X-Han-Request': '1',
        'Content-Type': 'application/json',
      };
    };
    const manager = await login('test'),
      staff = await login('staff');
    const post = async (id, extra = {}, headers = manager) => {
      const event = {
        id,
        documentId: 'doc',
        type: 'payment',
        date: today,
        amount: 10000,
        accountId: 'cash',
        note: 'Tahsilat',
        ...extra,
      };
      const r = await fetch(server.url + '/api/data/patch?key=hanhukuk-finance-v1', {
        method: 'PUT',
        headers,
        body: JSON.stringify(diff('hanhukuk-finance-v1', [], [event])),
      });
      return { status: r.status, body: await r.json() };
    };
    assert.equal((await post('missing')).status, 400);
    assert.equal((await post('inactive', { turnoverStaffId: 'inactive' })).status, 400);
    assert.equal((await post('unknown', { turnoverStaffId: 'unknown' })).status, 400);
    assert.equal((await post('forbidden', { turnoverStaffId: 'collector' }, staff)).status, 403);
    assert.equal((await post('unassigned', { documentId: 'unassigned' }, staff)).status, 400);
    assert.equal((await store.readState()).data['hanhukuk-finance-v1'].length, 1);
    const saved = await post('selected', {
      turnoverStaffId: 'collector',
      turnoverStaffName: 'Sahte İsim',
      collectionStaffName: 'Sahte İsim',
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const latest = await store.readState();
    const event = latest.data['hanhukuk-finance-v1'].find((e) => e.id === 'selected');
    assert.equal(event.operatorName, 'Kaydı Giren Yönetici');
    assert.equal(event.collectionStaffName, 'Ödemeyi Alan Personel');
    assert.equal(event.turnoverStaffName, 'Ödemeyi Alan Personel');
    assert.equal(latest.collectionNotices.at(-1).collectionStaffName, 'Ödemeyi Alan Personel');
    const own = await post('own', {}, staff);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal((await store.readState()).collectionNotices.at(-1).collectionStaffName, 'Dosya Sorumlusu');
    assert.equal((await post('expense', { type: 'expense', amount: 100 })).status, 200);
    assert.equal((await post('other', { turnoverStaffId: 'turnover:hukuk-reddiyat' })).status, 200);
    const final = await store.readState();
    assert.equal(
      final.data['hanhukuk-finance-v1'].find((e) => e.id === 'other').collectionStaffName,
      'Hukuk Reddiyat',
    );
    assert.equal(final.collectionNotices.at(-1).collectionStaffName, 'Kaydı Giren Yönetici');
    assert.deepEqual(
      final.data['hanhukuk-finance-v1'].find((e) => e.id === 'legacy'),
      state.data['hanhukuk-finance-v1'][0],
    );
    const notifications = await fetch(server.url + '/api/notifications?after=0', { headers: manager });
    assert.equal(notifications.status, 200);
    const notices = (await notifications.json()).collections.notices;
    assert.equal(notices.find((n) => n.eventId === 'selected').collectionStaffName, 'Ödemeyi Alan Personel');
  } finally {
    await server?.close();
    await pg.close();
  }
});
