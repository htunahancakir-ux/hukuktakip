const { test } = require('node:test');
const assert = require('node:assert/strict');
const units = require('../lib/personnel-departments.cjs');
const { fixture, database, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createTenantPool, LEGACY_TENANT_ID } = require('../lib/saas/tenant-pool.cjs');
test('Renaming built-in and custom units changes labels while payroll and permissions keep stable identities', () => {
  const state = fixture();
  state.data['icrapro-personnel-v1'] = [
    { id: 'manager', department: 'Yönetici', officialSalary: 1000 },
    { id: 'agent', name: 'Agent', department: 'Call Center-Y', active: true, officialSalary: 1000 },
    { id: 'other', department: 'Diğer', officialSalary: 0 },
  ];
  const before = structuredClone(state.data);
  const calculate = require('../outputs/icrapro/personnel-bonus.cjs').calculateCallcenterBonus;
  const bonusBefore = calculate(state, '2026-11');
  units.rename(state, 'Yönetici', 'Koordinasyon', 'Yönetici');
  units.rename(state, 'Call Center-Y', 'Y Ekibi', 'Call Center-Y');
  units.rename(state, 'Diğer', 'Destek', 'Diğer');
  assert.deepEqual(state.data, before);
  assert.deepEqual(calculate(state, '2026-11'), bonusBefore);
  assert.equal(units.catalog(state).find((u) => u.id === 'Yönetici').name, 'Koordinasyon');
  assert(!units.departments(state).includes('Koordinasyon'));
  assert.throws(
    () => units.add(state, 'koordinasyon'),
    (e) => e.code === 409,
  );
  assert.throws(
    () => units.rename(state, 'Pazarlama', 'Y Ekibi', 'Pazarlama'),
    (e) => e.code === 409,
  );
  assert.throws(
    () => units.rename(state, 'Yönetici', 'Başka', 'Yönetici'),
    (e) => e.code === 409,
  );
  assert.throws(
    () => units.rename(state, 'missing', 'Yeni', 'missing'),
    (e) => e.code === 404,
  );
  assert.throws(
    () => units.rename(state, 'Pazarlama', '<script>', 'Pazarlama'),
    (e) => e.code === 400,
  );
  units.add(state, 'Saha');
  units.rename(state, 'Saha', 'Saha & Operasyon', 'Saha');
  assert.equal(units.catalog(state).find((u) => u.id === 'Saha').name, 'Saha & Operasyon');
  units.rename(state, 'Saha', 'Saha', 'Saha & Operasyon');
  assert(!Object.hasOwn(state.personnelDepartmentLabels, 'Saha'));
});

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
  assert.equal(bonus.isCallcenter({ department: 'Temlik' }), true);
  assert.equal(bonus.isCallcenter({ department: 'Call Center-T' }), true);
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
        assert.deepEqual(Object.keys(list.body), ['departments', 'units']);
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
        const rename = {
          action: 'rename',
          id: 'Call Center-T',
          name: 'Tahsilat T Ekibi',
          previousName: 'Call Center-T',
        };
        assert.equal(
          (await call('POST', rename, admin)).status,
          405,
          'rename is never interpreted as adding another unit',
        );
        assert.equal((await call('PATCH', rename, staff)).status, 403);
        assert.equal((await call('PATCH', rename, readonly)).status, 403);
        assert.equal((await call('PATCH', rename, admin)).status, 200);
        const afterRename = await store.readState();
        assert.deepEqual(afterRename.data, saved.data);
        assert.deepEqual(afterRename.users, saved.users);
        assert.equal(afterRename.personnelDepartmentLabels['Call Center-T'], 'Tahsilat T Ekibi');
        assert.equal(
          (await call('PATCH', { ...rename, name: 'Yanlış', previousName: 'Call Center-T' })).status,
          409,
        );
        assert.equal(
          (await call('PATCH', { action: 'rename', id: 'Call Center-T', name: 'Eksik' })).status,
          400,
        );
        assert.equal(
          (
            await call('PATCH', {
              action: 'rename',
              id: 'Pazarlama',
              name: 'Tahsilat T Ekibi',
              previousName: 'Pazarlama',
            })
          ).status,
          409,
        );
        if (records) {
          const bootstrap = await fetch(server.url + '/api/records/bootstrap', { headers: ceo });
          const data = await bootstrap.json();
          assert.equal(bootstrap.status, 200);
          assert.equal(
            data.personnelDepartmentUnits.find((unit) => unit.id === 'Call Center-T').name,
            'Tahsilat T Ekibi',
          );
          assert.equal(data.data['icrapro-personnel-v1'][0].department, 'Temlik');
        }
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
        assert.equal(
          (await call('GET')).body.units.find((unit) => unit.id === 'Call Center-T').name,
          'Tahsilat T Ekibi',
        );
      } finally {
        if (server) await server.close();
        await pg.close();
      }
    },
  );
