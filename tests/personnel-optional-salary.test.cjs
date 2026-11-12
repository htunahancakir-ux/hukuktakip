const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { fixture, database, serve, password } = require('./support/postgres.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
test('Other department toggles salary requirements without clearing values; generic required enforcement respects the exemption', () => {
  const dom = new JSDOM(
    '<form><select name="department"><option>Diğer</option><option>İcra</option></select><label>Maaş *<input name="officialSalary" type="number" required></label><label>Prim 1 *<input name="unofficialSalary" type="number" required></label></form>',
    { runScripts: 'dangerously', url: 'http://localhost' },
  );
  try {
    const w = dom.window;
    w.eval(
      fs.readFileSync('outputs/icrapro/personnel.js', 'utf8') +
        '\nwindow.stopObserver=()=>requiredObserver.disconnect();',
    );
    const form = w.document.querySelector('form');
    w.setupPersonnelSalaryRequirements(form);
    w.enforceRequired(form);
    assert.equal(form.elements.officialSalary.required, false);
    assert.equal(form.elements.unofficialSalary.required, false);
    assert.equal(form.checkValidity(), true);
    form.elements.officialSalary.value = '25000';
    form.elements.department.value = 'İcra';
    form.elements.department.dispatchEvent(new w.Event('change'));
    assert.equal(form.elements.officialSalary.required, true);
    assert.equal(form.elements.officialSalary.value, '25000');
    form.elements.department.value = 'Diğer';
    form.elements.department.dispatchEvent(new w.Event('change'));
    w.enforceRequired(form);
    assert.equal(form.elements.officialSalary.required, false);
    w.stopObserver();
  } finally {
    dom.window.close();
  }
});
test('Server permits blank salary and Prim 1 only for Other, including later payroll edits', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const s = fixture();
    await importState(pool, s);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(require('../lib/application.cjs').createApplication({ store }));
    const login = await fetch(server.url + '/api/login', {
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
    const post = async (path, body) => {
      const r = await fetch(server.url + path, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const record = {
      id: 'other',
      name: 'Örnek Personel',
      department: 'Diğer',
      officialSalary: '',
      unofficialSalary: '',
      bonus: 0,
      active: true,
    };
    let result = await post('/api/personnel-save', { record, account: {} });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    let saved = (await store.readState()).data['icrapro-personnel-v1'][0];
    assert.equal(saved.officialSalary, 0);
    assert.equal(saved.unofficialSalary, 0);
    result = await post('/api/personnel-payroll', {
      staffId: 'other',
      officialSalary: '',
      unofficialSalary: '',
      bonus: 0,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(
      (await post('/api/personnel-save', { record: { ...record, department: 'İcra' }, account: {} })).status,
      400,
    );
    assert.equal(
      (await post('/api/personnel-save', { record: { ...record, officialSalary: -1 }, account: {} })).status,
      400,
    );
    result = await post('/api/personnel-save', {
      record: { ...record, department: 'İcra', officialSalary: 25000 },
      account: {},
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(
      (
        await post('/api/personnel-payroll', {
          staffId: 'other',
          officialSalary: '',
          unofficialSalary: '',
          bonus: 0,
        })
      ).status,
      400,
    );
    saved = (await store.readState()).data['icrapro-personnel-v1'][0];
    assert.equal(saved.officialSalary, 25000);
  } finally {
    await server?.close();
    await pg.close();
  }
});
