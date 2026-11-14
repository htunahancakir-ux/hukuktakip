// Each office sets what its receipts ("Tahsil Eden") and its release letter print
// (Ayarlar → Firma Bilgileri). Staff who print them get those two texts, nothing more.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { createApplication } = require('../lib/application.cjs');

const headers = { 'Content-Type': 'application/json', 'X-Han-Request': '1' };

function printNames({ brand = '', firm = {} } = {}) {
  const context = vm.createContext({ structuredClone });
  vm.runInContext(`let officeBrand = ${JSON.stringify(brand)};`, context);
  vm.runInContext(fs.readFileSync('outputs/icrapro/settings.js', 'utf8'), context);
  vm.runInContext(`config.firm = { ...config.firm, ...${JSON.stringify(firm)} };`, context);
  return {
    receipt: vm.runInContext("firmPrintName('receipt')", context),
    release: vm.runInContext("firmPrintName('release')", context),
    draft: vm.runInContext('JSON.stringify(settingsWithPrintTexts(config).firm)', context),
  };
}

test('receipts and the release letter print the office’s own wording', () => {
  // The existing office keeps what it has always printed until it changes it.
  assert.deepEqual(
    { ...printNames(), draft: undefined },
    { receipt: 'Av. Hasan Bahadır Patan Hukuk Bürosu', release: 'Av. Hasan Bahadır PATAN', draft: undefined },
  );
  // An office on its own address never prints another office's name.
  const fresh = printNames({ brand: 'Deneme Hukuk Takip' });
  assert.equal(fresh.receipt, 'Deneme Hukuk Takip');
  assert.equal(fresh.release, 'Deneme Hukuk Takip');
  assert.equal(printNames({ brand: 'Deneme Hukuk Takip', firm: { name: 'Deneme Avukatlık' } }).receipt, 'Deneme Avukatlık');
  // Its own wording wins, for both documents, on either kind of office.
  for (const brand of ['', 'Deneme Hukuk Takip']) {
    const own = printNames({ brand, firm: { receiptCollector: '  Av. Ayşe Yılmaz Hukuk Bürosu ', releaseSigner: 'Av. Ayşe YILMAZ' } });
    assert.equal(own.receipt, 'Av. Ayşe Yılmaz Hukuk Bürosu');
    assert.equal(own.release, 'Av. Ayşe YILMAZ');
  }
  // The settings form requires every field, so both texts open filled in.
  const draft = JSON.parse(fresh.draft);
  assert.equal(draft.receiptCollector, 'Deneme Hukuk Takip');
  assert.equal(draft.releaseSigner, 'Deneme Hukuk Takip');
});

test('the printed documents no longer carry a fixed office name', () => {
  const sheet = fs.readFileSync('outputs/icrapro/borrower-sheet.js', 'utf8');
  assert.doesNotMatch(sheet, /Hasan Bahadır/i);
  assert.equal(sheet.match(/firmPrintName\('receipt'\)/g).length, 2);
  assert.equal(sheet.match(/firmPrintName\('release'\)/g).length, 1);
});

test('staff get the two print texts with the office name, and no other firm detail', async () => {
  const { pg, pool } = await database();
  const state = fixture();
  state.users.push({ ...state.users[0], id: 'staff', name: 'Personel', username: 'staff', role: 'user' });
  state.data['icrapro-settings-v1'] = {
    firm: {
      name: 'Örnek Büro',
      taxNumber: '1234567890',
      authorized: 'Av. Ayşe Yılmaz',
      receiptCollector: 'Av. Ayşe Yılmaz Hukuk Bürosu',
      releaseSigner: 'Av. Ayşe YILMAZ',
    },
    contact: { phone: '05550000000' },
    preferences: { prefix: 'EVR' },
  };
  await importState(pool, state);
  const server = await serve(createApplication({ store: createStore(pool) }));
  try {
    const signIn = async (username) => {
      const login = await fetch(server.url + '/api/login', { method: 'POST', headers, body: JSON.stringify({ username, password }) });
      assert.equal(login.status, 200, username);
      return { ...headers, cookie: login.headers.get('set-cookie').split(';')[0] };
    };
    const read = async (username) =>
      (await fetch(server.url + '/api/data?key=icrapro-settings-v1', { headers: await signIn(username) })).json();
    assert.deepEqual(await read('staff'), {
      firm: { name: 'Örnek Büro', receiptCollector: 'Av. Ayşe Yılmaz Hukuk Bürosu', releaseSigner: 'Av. Ayşe YILMAZ' },
    });
    assert.equal((await read(state.users[0].username)).firm.taxNumber, '1234567890');
  } finally {
    await server.close();
    await pg.close();
  }
});

test('texts the application writes itself name the office they are written for', () => {
  const { officeIdentity, plainSms } = require('../lib/office-identity.cjs');
  const terms = require('../lib/employee-terms.cjs');
  // The existing office: exactly the wording it has always had.
  const legacy = officeIdentity({ data: { 'icrapro-settings-v1': { firm: { name: 'Başka Ad' } } } }, {});
  assert.equal(legacy.controller, terms.DEFAULT_CONTROLLER);
  assert.equal(legacy.product, 'Han Hukuk Takip');
  assert.equal(legacy.origin, 'https://www.hanhukuktakip.com');
  assert.deepEqual(terms.draft(legacy.controller, legacy.incidentContact, legacy.software), terms.draft());

  // An office on its own address: its own names, contact and address, never the existing office's.
  const state = {
    data: {
      'icrapro-settings-v1': {
        firm: { name: 'Şahin Avukatlık', legalName: 'Şahin Hukuk Ltd.', authorized: 'Av. Ömer Şahin' },
      },
    },
  };
  const office = officeIdentity(state, { officeName: 'Deneme', appOrigin: 'https://deneme.example.com' });
  assert.equal(office.name, 'Şahin Avukatlık');
  assert.equal(office.controller, 'Şahin Hukuk Ltd.');
  assert.equal(office.incidentContact, 'Av. Ömer Şahin veya büro yönetimi');
  assert.equal(office.origin, 'https://deneme.example.com');
  const draft = terms.draft(office.controller, office.incidentContact, office.software);
  assert.doesNotMatch(JSON.stringify(draft), /Han Hukuk|Patan/i);
  assert.match(draft.sections[0].text, /büronun hukuk takip yazılımında/);
  const release = terms.newRelease({ version: '1', ...draft }, '2026-01-01T00:00:00Z', office.origin);
  assert.equal(release.domain, 'https://deneme.example.com');
  // Before the office fills in its settings, the console's name for it is used.
  const bare = officeIdentity({ data: { 'icrapro-settings-v1': { firm: { name: 'Hukuk Bürosu' } } } }, { officeName: ' Deneme  Hukuk ' });
  assert.equal(bare.name, 'Deneme Hukuk');
  assert.equal(bare.incidentContact, 'büro yönetimi');
  assert.equal(plainSms('Şahin Avukatlık & Ortakları'), 'Sahin Avukatlik & Ortaklari');
});
