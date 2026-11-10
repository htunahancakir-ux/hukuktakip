const test = require('node:test');
const assert = require('node:assert/strict');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
test('staff update only their own contact; managers edit others without changing roles, salary or credentials', async (t) => {
  const { pg, pool } = await database(),
    state = fixture();
  state.users.push(
    { ...state.users[0], id: 'staff', username: 'staff', role: 'staff', staffId: 'p' },
    { ...state.users[0], id: 'admin', username: 'admin', role: 'admin' },
  );
  state.data['icrapro-personnel-v1'] = [
    { id: 'p', name: 'Personel', phone: '05320000001', active: true, officialSalary: 40000 },
  ];
  await importState(pool, state);
  await importRecords(pool);
  await activateRecords(pool);
  const app = await serve(createApplication({ store: createStore(pool, { records: true }) }));
  t.after(async () => {
    await app.close();
    await pg.close();
  });
  async function login(username) {
    const res = await fetch(app.url + '/api/login', {
      method: 'POST',
      headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(res.status, 200);
    return {
      cookie: res.headers.get('set-cookie').split(';')[0],
      'X-Han-Request': '1',
      'Content-Type': 'application/json',
    };
  }
  const staff = await login('staff'),
    admin = await login('admin');
  async function call(route, headers, input) {
    const res = await fetch(app.url + route, {
      headers,
      method: input ? 'PUT' : 'GET',
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    return { status: res.status, body: await res.json() };
  }
  let own = await call('/api/account/contact', staff);
  assert.equal(own.body.mobilePhone, '905320000001');
  assert.equal(own.body.complete, false);
  assert.equal((await call('/api/users/contact?id=test-ceo', staff)).status, 403);
  assert.equal(
    (
      await call('/api/account/contact', staff, {
        id: 'test-ceo',
        email: 'a@example.com',
        mobilePhone: '05320000002',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call('/api/account/contact', staff, {
        email: 'a@example.com',
        mobilePhone: '05320000002',
        role: 'ceo',
      })
    ).status,
    400,
  );
  for (const input of [
    { email: 'invalid', mobilePhone: '' },
    { email: 'a@example.com', mobilePhone: '02120000001' },
  ])
    assert.equal((await call('/api/account/contact', staff, input)).status, 400);
  own = await call('/api/account/contact', staff, {
    email: 'personel@example.com',
    mobilePhone: '05320000002',
  });
  assert.equal(own.status, 200);
  assert.equal(own.body.complete, true);
  const person = (await pool.query("select body from han_data.personnel where id='p'")).rows[0].body;
  assert.equal(person.email, 'personel@example.com');
  assert.equal(person.mobilePhone, '905320000002');
  assert.equal(person.officialSalary, 40000);
  const account = (await pool.query("select body from han_private.han_account_index where id='staff'"))
    .rows[0].body;
  assert.equal(account.role, 'staff');
  assert.equal(account.hash, state.users[1].hash);
  assert.equal(
    (
      await call('/api/users/contact', admin, {
        id: 'staff',
        email: 'yonetici@example.com',
        mobilePhone: '05320000003',
      })
    ).status,
    200,
  );
  own = await call('/api/account/contact', staff);
  assert.equal(own.body.email, 'yonetici@example.com');
  assert.equal(own.body.mobilePhone, '905320000003');
  assert.equal(
    (
      await call('/api/users/contact', admin, {
        id: 'test-ceo',
        email: 'ceo@example.com',
        mobilePhone: '05320000004',
      })
    ).status,
    200,
  );
  assert.equal(
    (await call('/api/users/contact', admin, { id: 'missing', email: '', mobilePhone: '' })).status,
    404,
  );
});
test('navigation reminder disappears for complete contacts; saving contact does not require password fields', async () => {
  const { JSDOM } = require('jsdom'),
    fs = require('node:fs');
  const dom = new JSDOM('<main></main><dialog id="modal"></dialog>', {
      runScripts: 'outside-only',
      url: 'https://example.test',
    }),
    w = dom.window;
  w.eval(fs.readFileSync('outputs/icrapro/html-safety.js', 'utf8'));
  w.esc = w.escapeHtml;
  w.hanAuth = { id: 'staff', role: 'staff' };
  w.accountRoleLabel = () => 'Personel';
  w.accountInitials = () => 'P';
  w.installPasswordVisibility = () => {};
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  let profile = { id: 'staff', email: '', mobilePhone: '', complete: false },
    saved;
  w.fetch = async () => ({ ok: true, json: async () => profile });
  w.authApi = (route, method, input) => {
    if (method === 'PUT') {
      saved = input;
      profile = { ...profile, ...input, complete: true };
    }
    return profile;
  };
  w.eval(fs.readFileSync('outputs/icrapro/workspace-contact.js', 'utf8'));
  const authSource = fs.readFileSync('outputs/icrapro/auth.js', 'utf8');
  w.eval(
    authSource.slice(
      authSource.indexOf('function showAccountPanel()'),
      authSource.indexOf('function openHeaderNotifications()'),
    ),
  );
  await w.refreshContactReminder();
  assert(w.document.querySelector('#contactCompletionReminder'));
  w.showAccountPanel();
  const contactForm = w.document.querySelector('#accountContactForm'),
    passwordForm = w.document.querySelector('#accountSettingsForm');
  assert.equal(
    w.document.querySelectorAll('form form').length,
    0,
    'Contact and password forms must be independent',
  );
  assert.equal(w.document.querySelector('details').open, false, 'Password editing is opt-in');
  w.document.querySelector('[name="contactEmail"]').value = 'p@example.com';
  w.document.querySelector('[name="contactMobile"]').value = '05320000001';
  contactForm.requestSubmit();
  assert.equal(saved.email, 'p@example.com');
  assert.equal(w.document.querySelector('[type="password"]').value, '');
  assert.equal(passwordForm.checkValidity(), false, 'Empty password fields must not block contact save');
  assert.equal(contactForm.elements.currentPassword, undefined);
  await w.refreshContactReminder();
  assert.equal(w.document.querySelector('#contactCompletionReminder'), null);
  profile = { ...profile, complete: false };
  await w.refreshContactReminder();
  assert(w.document.querySelector('#contactCompletionReminder'));
  dom.window.close();
});
