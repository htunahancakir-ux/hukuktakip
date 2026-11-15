const test = require('node:test');
const assert = require('node:assert/strict');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');

test('Hesabım verifies the saved e-mail address with a code and the current password; a manager needs no password', () => {
  const { JSDOM } = require('jsdom');
  const fs = require('node:fs');
  const dom = new JSDOM('<div id="root"><div class="account-settings-form"></div></div>', {
    runScripts: 'dangerously',
  });
  const w = dom.window,
    calls = [];
  w.esc = String;
  w.hanAuth = { id: 'test' };
  let saved = 'test@example.test',
    verified = false;
  w.authApi = (path, method, input) => {
    if (path === '/api/account/contact') {
      if (method === 'PUT' && input.email !== saved) {
        saved = input.email;
        verified = false;
      }
      return {
        id: 'test',
        email: saved,
        mobilePhone: '',
        emailVerified: verified,
        emailVerification: true,
        complete: true,
      };
    }
    calls.push(JSON.parse(JSON.stringify({ path, input })));
    if (path === '/api/email-verification/send')
      return { ok: true, sentTo: 'te***@example.test', email: { sent: true } };
    verified = true;
    return { ok: true, id: input.userId, email: saved, emailVerified: true };
  };
  const $ = (selector) => w.document.querySelector(selector);
  try {
    w.eval(fs.readFileSync('outputs/icrapro/workspace-contact.js', 'utf8'));
    w.setupAccountContact(w.document.getElementById('root'));
    assert.match($('[data-verify-state]').textContent, /Doğrulanmadı/);
    assert.equal($('[name="verifyPassword"]').autocomplete, 'current-password');
    $('[data-verify-send]').click();
    assert.deepEqual(calls[0], { path: '/api/email-verification/send', input: { userId: 'test' } });
    assert.match($('[data-verify-status]').textContent, /te\*\*\*@example\.test/);

    // The code alone is not enough for one's own address: the current password is asked.
    $('[name="verifyCode"]').value = '123456';
    $('[data-verify-confirm]').click();
    assert.equal(calls.length, 1, 'nothing is sent without the password');
    assert.match($('[data-verify-status]').textContent, /mevcut hesap şifrenizi/);
    $('[name="verifyPassword"]').value = 'Synthetic-Own-Password';
    $('[data-verify-confirm]').click();
    assert.deepEqual(calls[1], {
      path: '/api/email-verification/confirm',
      input: { userId: 'test', code: '123456', password: 'Synthetic-Own-Password' },
    });
    assert.equal($('[name="verifyPassword"]').value, '', 'the password does not stay on the page');
    assert.match($('[data-verify-state]').textContent, /✓ Doğrulandı/);
    assert.equal($('[data-verify-send]').disabled, true);
    assert.equal($('[data-recovery-section]'), null, 'no second verification section');

    w.document.getElementById('root').innerHTML = '<div class="account-settings-form"></div>';
    w.setupAccountContact(w.document.getElementById('root'));
    assert.match($('[data-verify-state]').textContent, /✓ Doğrulandı/, 'verified state survives reopening');
    $('[name="contactEmail"]').value = 'changed@example.test';
    $('[data-save-contact]').click();
    assert.match($('[data-verify-state]').textContent, /Doğrulanmadı/, 'a changed address is verified again');
    assert.equal($('[data-verify-send]').disabled, false);

    // A manager verifying a staff account's address enters only the code the person reads out.
    const host = w.document.createElement('div');
    w.document.body.append(host);
    w.bindContactEditor(
      host,
      { id: 'staff', email: 'staff@example.test', mobilePhone: '', emailVerified: false, emailVerification: true },
      '/api/users/contact',
    );
    assert.equal(host.querySelector('[name="verifyPassword"]'), null);
    host.querySelector('[name="verifyCode"]').value = '654321';
    host.querySelector('[data-verify-confirm]').click();
    assert.deepEqual(calls.at(-1).input, { userId: 'staff', code: '654321' });
  } finally {
    w.close();
  }
});
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
  assert.equal((await call('/api/users', staff)).status, 403);
  const list = await call('/api/users', admin),
    listed = list.body.find((user) => user.id === 'staff');
  assert.equal(listed.email, 'yonetici@example.com');
  assert.equal(listed.mobilePhone, '905320000003');
  assert(!('hash' in listed));
  assert(!('salt' in listed));
});
test('user management lists escaped contacts, filters by email and refreshes after editing', async () => {
  const { JSDOM } = require('jsdom'),
    fs = require('node:fs');
  const dom = new JSDOM('<div id="content"></div>', { runScripts: 'outside-only' }),
    w = dom.window;
  w.eval(fs.readFileSync('outputs/icrapro/html-safety.js', 'utf8'));
  w.esc = w.escapeHtml;
  // Loaded before workspace-access.js in the app: the e-mail verified mark lives here.
  w.eval(fs.readFileSync('outputs/icrapro/workspace-contact.js', 'utf8'));
  w.hanAuth = { role: 'admin' };
  w.$ = (selector) => w.document.querySelector(selector);
  w.normalizeSearch = (value) => String(value).toLowerCase();
  w.userAuditTabs = () => '';
  w.bindUserAuditTabs = () => {};
  const users = [
    {
      id: 's',
      name: 'Personel',
      username: 'staff',
      role: 'staff',
      active: true,
      email: 'p@example.com',
      mobilePhone: '905320000001',
    },
    {
      id: 'other',
      name: 'Diğer',
      username: 'other',
      role: 'staff',
      active: false,
      email: '<img src=x onerror=alert(1)>',
      mobilePhone: '',
    },
  ];
  w.authApi = () => users;
  w.showUserContact = (account, saved) => saved({ email: 'edited@example.com', mobilePhone: '905320000002' });
  const source = fs.readFileSync('outputs/icrapro/workspace-access.js', 'utf8');
  w.eval(source.slice(0, source.indexOf('function staffAccounting(')));
  await w.userManagement();
  assert.match(w.document.querySelector('thead').textContent, /E-POSTA.*CEP TELEFONU/);
  assert.match(w.document.querySelector('#passwordUserRows').textContent, /p@example.com/);
  assert.match(
    w.document.querySelector('#passwordUserRows .email-unverified-mark').textContent,
    /Doğrulanmadı/,
    'an address not yet verified is marked',
  );
  assert.equal(w.document.querySelector('[data-reset-password="other"]'), null);
  const inactive = w.document.querySelector('#showInactiveUsers');
  inactive.checked = true;
  inactive.dispatchEvent(new w.Event('change'));
  assert(w.document.querySelector('[data-reset-password="other"]'));
  assert.equal(w.document.querySelectorAll('img').length, 0);
  [...w.document.querySelectorAll('button')]
    .find((button) => button.textContent === 'E-posta / Cep Telefonu')
    .click();
  assert.match(w.document.querySelector('#passwordUserRows').textContent, /edited@example.com/);
  const search = w.document.querySelector('#passwordUserSearch');
  search.value = 'edited@example.com';
  search.dispatchEvent(new w.Event('input'));
  assert.equal(w.document.querySelectorAll('#passwordUserRows tr').length, 1);
  dom.window.close();
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

test('saved contact form is clean while failed saves and later changes remain unsaved', async () => {
  const { JSDOM } = require('jsdom'),
    fs = require('node:fs');
  const dom = new JSDOM(
    '<dialog open><form id="contact"></form><form id="other"><input name="note"><button>Kaydet</button></form></dialog>',
    { runScripts: 'dangerously', url: 'https://example.test' },
  );
  try {
    const w = dom.window,
      dialog = w.document.querySelector('dialog'),
      form = w.document.querySelector('#contact'),
      other = w.document.querySelector('#other');
    w.esc = (x) => String(x);
    w.hanAuth = { id: 's' };
    let failSave = false;
    w.authApi = (_route, _method, input) => {
      if (failSave) throw Error('Kayıt başarısız');
      return { ...input, complete: true };
    };
    w.eval(fs.readFileSync('outputs/icrapro/modal-dismissal.js', 'utf8'));
    w.eval(fs.readFileSync('outputs/icrapro/workspace-contact.js', 'utf8'));
    w.bindContactEditor(form, { id: 's', email: '', mobilePhone: '' }, '/test');
    other.onsubmit = (e) => e.preventDefault();
    await new Promise(setImmediate);
    form.elements.contactEmail.value = 'test@example.com';
    other.elements.note.value = 'Korunacak taslak';
    form.requestSubmit();
    assert.deepEqual(
      Array.from(w.modalDrafts(dialog), (f) => f.id),
      ['other'],
    );
    form.elements.contactEmail.value = 'new@example.com';
    assert.deepEqual(
      Array.from(w.modalDrafts(dialog), (f) => f.id),
      ['contact', 'other'],
    );
    failSave = true;
    form.requestSubmit();
    assert.deepEqual(
      Array.from(w.modalDrafts(dialog), (f) => f.id),
      ['contact', 'other'],
    );
  } finally {
    dom.window.close();
  }
});
