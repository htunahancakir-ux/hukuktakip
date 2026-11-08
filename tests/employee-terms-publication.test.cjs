const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { draft } = require('../lib/employee-terms.cjs');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');

test('Terms publishing uses visible confirmation, preserves drafts on expired sessions and prevents duplicate submission', async (t) => {
  const dom = new JSDOM('<div id="terms"></div>', {
    url: 'https://test.invalid',
    runScripts: 'dangerously',
    virtualConsole: new VirtualConsole(),
  });
  const w = dom.window;
  t.after(() => {
    w.stopRequiredObserver();
    dom.window.close();
  });
  w.Element.prototype.scrollIntoView = () => {};
  Object.assign(w, {
    hanAuth: { role: 'ceo' },
    termsDate: String,
    authApi: () => ({ document: null, draft: draft(), users: [{}, {}, {}] }),
    confirm: () => {
      throw Error('Native confirmation must not be used');
    },
  });
  w.eval(fs.readFileSync('outputs/icrapro/html-safety.js', 'utf8'));
  w.termsEscape = w.escapeHtml;
  w.eval(
    fs.readFileSync('outputs/icrapro/personnel.js', 'utf8') +
      '\nwindow.stopRequiredObserver=()=>requiredObserver.disconnect();',
  );
  w.eval(fs.readFileSync('outputs/icrapro/employee-terms-settings.js', 'utf8'));
  w.renderEmployeeTermsManagement(w.document.querySelector('#terms'), { records: false });
  await new Promise((r) => setTimeout(r, 0));
  const form = w.document.querySelector('[data-terms-publish]'),
    submit = form.querySelector('[type="submit"]'),
    confirm = form.querySelector('[data-terms-confirm-publish]'),
    panel = form.querySelector('[data-terms-confirm]'),
    status = form.querySelector('[data-terms-status]');
  let calls = [],
    finish,
    saved = false;
  w.modalFormSaved = () => {
    saved = true;
  };
  w.fetch = (url, options) => {
    calls.push({ url, options });
    return new Promise((resolve) => {
      finish = (code, data) => resolve({ status: code, ok: code === 200, json: async () => data });
    });
  };
  assert.equal(form.checkValidity(), true);
  submit.click();
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /1\.3\.0.*Veri sorumlusu.*3 etkin hesap/s);
  assert.equal(calls.length, 0);
  form.querySelector('[data-terms-cancel]').click();
  assert.equal(panel.hidden, true);
  submit.click();
  form.elements.version.value = '1.3.1';
  confirm.click();
  assert.equal(calls.length, 0, 'changed draft needs a fresh confirmation');
  assert.match(status.textContent, /Metin değişti/);
  form.elements.version.value = '';
  submit.click();
  assert.match(status.textContent, /eksik veya hatalı/);
  form.elements.version.value = '1.3.0';
  submit.click();
  confirm.click();
  confirm.click();
  assert.equal(calls.length, 1);
  assert.equal(confirm.disabled, true);
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.headers['X-Han-Request'], '1');
  finish(401, { error: 'Giriş yapın.' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(form.elements.version.value, '1.3.0');
  assert.equal(confirm.disabled, false);
  assert.match(status.textContent, /Oturumunuz sona erdi.*Metniniz bu sayfada korunuyor/s);
  assert.equal(saved, false);
  confirm.click();
  finish(200, { document: { version: '1.3.0' } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(saved, true);
  assert.match(status.textContent, /1\.3\.0 yayınlandı/);
  assert.equal(confirm.disabled, true);
});

test('Employee preview uses the real scroll and checkbox steps without accepting or publishing a document', (t) => {
  const dom = new JSDOM('', { url: 'https://test.invalid', runScripts: 'dangerously' });
  const w = dom.window;
  t.after(() => dom.window.close());
  w.hanAuth = { role: 'ceo' };
  const writes = [];
  w.authApi = (...args) => {
    writes.push(args);
    throw Error('Preview cannot call the server');
  };
  w.fetch = (...args) => {
    writes.push(args);
    throw Error('Preview cannot call the server');
  };
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.dispatchEvent(new w.Event('close'));
  };
  Object.defineProperties(w.HTMLElement.prototype, {
    clientHeight: {
      get() {
        return this.classList.contains('terms-reader') ? 200 : 0;
      },
    },
    scrollHeight: {
      get() {
        return this.classList.contains('terms-reader') ? 1000 : 0;
      },
    },
  });
  w.eval(fs.readFileSync('outputs/icrapro/html-safety.js', 'utf8'));
  w.eval(fs.readFileSync('outputs/icrapro/employee-terms.js', 'utf8'));
  w.showEmployeeTermsPreview(
    {
      ...draft(),
      title: '<img src=x onerror=alert(1)>',
      version: '1.3.0',
      domain: 'https://www.hanhukuktakip.com',
    },
    null,
  );
  const dialog = w.document.querySelector('dialog'),
    form = dialog.querySelector('form'),
    checkbox = form.elements.accepted,
    submit = form.querySelector('[type="submit"]'),
    reader = dialog.querySelector('.terms-reader');
  assert.equal(dialog.querySelector('img'), null);
  assert.match(dialog.textContent, /Önizleme.*kabul kaydı oluşturmaz/s);
  assert.equal(checkbox.disabled, true);
  assert.equal(submit.disabled, true);
  reader.scrollTop = 400;
  reader.dispatchEvent(new w.Event('scroll'));
  assert.equal(checkbox.disabled, true);
  reader.scrollTop = 800;
  reader.dispatchEvent(new w.Event('scroll'));
  assert.equal(checkbox.disabled, false);
  assert.equal(submit.disabled, true);
  checkbox.click();
  assert.equal(submit.disabled, false);
  submit.click();
  assert.match(dialog.textContent, /Bu denemede kayıt oluşturulmadı/);
  assert.equal(writes.length, 0);
  dialog.querySelector('[data-terms-logout]').click();
  assert.equal(w.document.querySelector('dialog'), null);
  assert.equal(writes.length, 0, 'closing preview must not log the CEO out');
});

test('Publishing in active record storage keeps business data and sessions, gates all roles and records acceptance separately', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    for (const role of ['admin', 'staff'])
      state.users.push({ ...state.users[0], id: role, username: role, name: role, role });
    state.data['icrapro-v1'].clients.push({ id: 'client', name: 'Preserved client' });
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    server = await serve(createApplication({ store: createStore(pool, { records: true }) }));
    const request = (path, cookie, method = 'GET', body) =>
      fetch(server.url + '/api/' + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1', ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const cookies = {};
    for (const name of ['test', 'admin', 'staff']) {
      const response = await request('login', null, 'POST', { username: name, password });
      assert.equal(response.status, 200);
      cookies[name] = response.headers.get('set-cookie').split(';')[0];
    }
    const sessionsBefore = await pool.query(
      'SELECT token_hash,account_id FROM han_private.han_sessions ORDER BY account_id',
    );
    const clientsBefore = await pool.query('SELECT body,revision FROM han_data.clients');
    const payload = { action: 'publish', version: '1.3.0', baseVersion: null, ...draft() };
    assert.equal((await request('employee-terms/settings', cookies.admin, 'PUT', payload)).status, 403);
    const publication = await request('employee-terms/settings', cookies.test, 'PUT', payload);
    assert.equal(publication.status, 200);
    const { document: doc } = await publication.json();
    assert.equal(doc.version, '1.3.0');
    assert.deepEqual(
      (await pool.query('SELECT token_hash,account_id FROM han_private.han_sessions ORDER BY account_id'))
        .rows,
      sessionsBefore.rows,
    );
    assert.deepEqual(
      (await pool.query('SELECT body,revision FROM han_data.clients')).rows,
      clientsBefore.rows,
    );
    for (const cookie of Object.values(cookies)) {
      const session = await (await request('session', cookie)).json();
      assert.ok(session.user, 'publishing must not log anyone out');
      assert.equal(session.employeeTermsRequired, true);
      assert.equal((await request('records/bootstrap', cookie)).status, 428);
      const current = await (await request('employee-terms/current', cookie)).json();
      assert.equal(current.required, true);
      assert.equal(current.document.version, '1.3.0');
    }
    assert.equal((await request('employee-terms/settings', cookies.test, 'PUT', payload)).status, 409);
    const accept = await request('employee-terms/accept', cookies.staff, 'POST', {
      version: doc.version,
      hash: doc.hash,
      accepted: true,
    });
    assert.equal(accept.status, 200);
    assert.equal((await (await request('session', cookies.staff)).json()).employeeTermsRequired, false);
    assert.equal((await (await request('session', cookies.admin)).json()).employeeTermsRequired, true);
    const history = await (await request('employee-terms/history', cookies.staff)).json();
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].accountId, 'staff');
    assert.ok(history.items[0].acceptedAt);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM han_private.han_audit WHERE area='Gizlilik Sözleşmesi' AND action='publish'",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    if (server) await server.close();
    await pg.close();
  }
});
