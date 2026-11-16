const { test } = require('node:test');
const assert = require('node:assert/strict');
const units = require('../lib/personnel-departments.cjs');
const { fixture, database, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createTenantPool, LEGACY_TENANT_ID } = require('../lib/saas/tenant-pool.cjs');

test('Department names preserve built-in rules, normalize Temlik and reject duplicates or invalid input', () => {
  const state = fixture();
  state.data['icrapro-personnel-v1'] = [{ id: 'p', department: 'Temlik' }];
  assert(units.departments(state).includes('Call Center-T'));
  assert(!units.departments(state).includes('Temlik'));
  assert.equal(units.add(state, '  Saha   Operasyon  '), 'Saha Operasyon');
  assert.equal(units.departments(state).filter((n) => n === 'Saha Operasyon').length, 1);
  for (const name of ['saha operasyon', 'TEMLİK', 'call center-t'])
    assert.throws(
      () => units.add(state, name),
      (e) => e.code === 409,
    );
  for (const name of ['', null, 'x'.repeat(61), '<img src=x>', 'İş\nBirimi'])
    assert.throws(
      () => units.add(state, name),
      (e) => e.code === 400,
    );
  const bonus = require('../outputs/icrapro/personnel-bonus.cjs');
  assert.equal(bonus.isCallcenter({ department: 'Temlik' }), false);
  assert.equal(bonus.isCallcenter({ department: 'Call Center-T' }), false);
  assert.equal(
    require('../lib/ceo-pin.cjs').scopeFor(new URL('http://test/api/personnel-departments'), 'POST'),
    'permissions',
  );
});

for (const records of [false, true])
  test(
    'Managers persist department names and staff selections without changing salaries or unrelated data: ' +
      records,
    async () => {
      const { pg, pool: rootPool } = await database();
      const pool = createTenantPool(rootPool, LEGACY_TENANT_ID);
      let server;
      try {
        const state = fixture();
        const legacy = {
          id: 'legacy',
          name: 'Örnek Personel',
          department: 'Temlik',
          officialSalary: 1000,
          unofficialSalary: 200,
          bonus: 50,
          active: true,
        };
        state.data['icrapro-personnel-v1'] = [legacy];
        for (const name of ['admin', 'staff', 'readonly'])
          state.users.push({
            ...state.users[0],
            id: name,
            username: name,
            role: name === 'staff' ? 'staff' : 'admin',
            readOnly: name === 'readonly',
          });
        await importState(pool, state);
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
            'X-Han-Request': '1',
            'Content-Type': 'application/json',
            cookie: r.headers.get('set-cookie').split(';')[0],
          };
        };
        const ceo = await login('test'),
          admin = await login('admin'),
          staff = await login('staff'),
          readonly = await login('readonly');
        const call = async (method, body, headers = ceo, path = '/api/personnel-departments') => {
          const r = await fetch(server.url + path, {
            method,
            headers,
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          return { status: r.status, body: await r.json() };
        };
        assert.equal((await call('GET', null, {})).status, 401);
        assert.equal((await call('GET', null, staff)).status, 403);
        assert.equal((await call('POST', { name: 'Yetkisiz' }, staff)).status, 403);
        assert.equal((await call('POST', { name: 'Salt Okunur' }, readonly)).status, 403);
        const list = await call('GET', null, admin);
        assert.equal(list.status, 200);
        assert.deepEqual(Object.keys(list.body), ['departments']);
        assert(list.body.departments.includes('Call Center-T'));
        assert(!list.body.departments.includes('Temlik'));
        const created = await call('POST', { name: 'Saha Operasyon' }, admin);
        assert.equal(created.status, 200, JSON.stringify(created.body));
        assert(created.body.departments.includes('Saha Operasyon'));
        assert.equal((await call('POST', { name: ' saha  operasyon ' })).status, 409);
        assert.equal((await call('POST', { name: '<script>alert(1)</script>' })).status, 400);
        const saved = await store.readState();
        assert.deepEqual(saved.personnelDepartments, ['Saha Operasyon']);
        assert.deepEqual(saved.data['icrapro-personnel-v1'], [legacy]);
        assert.deepEqual(saved.data['icrapro-v1'], state.data['icrapro-v1']);
        assert.deepEqual(saved.data['hanhukuk-accounting-v1'], state.data['hanhukuk-accounting-v1']);
        assert.deepEqual(saved.users, state.users);
        const selected = await call(
          'POST',
          {
            record: {
              id: 'new',
              name: 'Yeni Personel',
              department: 'Saha Operasyon',
              officialSalary: 1000,
              unofficialSalary: 0,
              bonus: 0,
              active: true,
            },
            account: {},
          },
          admin,
          '/api/personnel-save',
        );
        assert.equal(selected.status, 200, JSON.stringify(selected.body));
        assert.equal(
          (await store.readState()).data['icrapro-personnel-v1'].find((p) => p.id === 'new').department,
          'Saha Operasyon',
        );
        const renamed = await call('POST', { record: legacy, account: {} }, admin, '/api/personnel-save');
        assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
        const person = (await store.readState()).data['icrapro-personnel-v1'].find((p) => p.id === legacy.id);
        assert.equal(person.department, 'Call Center-T');
        assert.equal(person.officialSalary, 1000);
        assert.equal(person.unofficialSalary, 200);
        assert.equal(person.bonus, 50);
        await server.close();
        server = await serve(createApplication({ store: createStore(pool, { records }) }));
        assert(
          (await call('GET')).body.departments.includes('Saha Operasyon'),
          'names survive a new server instance',
        );
      } finally {
        if (server) await server.close();
        await pg.close();
      }
    },
  );
