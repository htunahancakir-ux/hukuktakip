const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { assertWithinUserLimit, activeUsers } = require('../lib/seat-limit.cjs');
const { createSeatGate } = require('../lib/saas/seat-gate.cjs');
const { createPlatformAdmin } = require('../lib/saas/platform-auth.cjs');
const { LEGACY_TENANT_ID } = require('../lib/saas/tenant-pool.cjs');
const platform = require('../lib/saas/platform.cjs');

const fail = (status, message) => Object.assign(new Error(message), { status });
const users = (...flags) => ({ users: flags.map((active, i) => ({ id: 'u' + i, active })) });

test('the limit only refuses an increase past the purchased count', () => {
  const check = (limit, before, after) => assertWithinUserLimit(limit, before, after, fail);
  assert.equal(activeUsers(users(true, false, undefined)), 2, 'a missing flag means active');
  check(3, users(true, true), users(true, true, true));
  check(null, users(true), users(true, true, true, true));
  check(undefined, users(true), users(true, true, true, true));
  assert.throws(() => check(2, users(true, true), users(true, true, true)), (e) => e.status === 409 && /\(2\)/.test(e.message));
  assert.throws(() => check(1, users(true, false), users(true, true)), (e) => e.status === 409, 'reactivation counts');
  // An office that shrank its plan can still edit and deactivate what it has.
  check(1, users(true, true, true), users(true, true, true));
  check(1, users(true, true, true), users(true, false, true));
});

test('the seat gate reads the purchased count, skips the existing office and denies on failure', async () => {
  const { pg, pool } = await database();
  try {
    const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Op', password: 'Synthetic-Seat-Gate-Test!' })).id;
    const office = (
      await platform.openOffice(pool, op, {
        slug: 'koltuk', name: 'Kullanıcı Sınırı Hukuk', admin: { name: 'Y', username: 'y', password: 'Synthetic-Seat-Gate-Test!' },
        userCount: 3, userPriceKurus: 1000, termMonths: 1, moduleCodes: [], paid: true,
      })
    ).office;
    assert.equal(await createSeatGate(pool, { tenantId: office.id, cacheMs: 0 }).limit(), 3);
    await platform.changeUsers(pool, op, { tenantId: office.id, userCount: 5, paid: true });
    assert.equal(await createSeatGate(pool, { tenantId: office.id, cacheMs: 0 }).limit(), 5, 'follows a sale');
    assert.equal(await createSeatGate(pool, { tenantId: LEGACY_TENANT_ID }).limit(), null, 'the existing office is not limited');
    // Accounts the office creates inside its own application count in the console as well.
    const used = async () => (await platform.dashboard(pool)).officeList.find((o) => o.id === office.id).usersUsed;
    assert.equal(await used(), 1);
    await pool.query(
      "UPDATE han_private.han_state SET payload = jsonb_set(payload, '{users}', payload->'users' || '[{\"id\":\"x1\",\"username\":\"x1\",\"active\":true},{\"id\":\"x2\",\"username\":\"x2\",\"active\":false}]'::jsonb) WHERE tenant_id = $1 AND id = 1",
      [office.id],
    );
    assert.equal(await used(), 2, 'one active in-app account added, one inactive ignored');
    const broken = createSeatGate({ query: async () => { throw new Error('down'); } }, { tenantId: office.id });
    await assert.rejects(() => broken.limit(), (e) => e.status === 503);
  } finally {
    await pg.close();
  }
});

test('the application refuses accounts beyond the purchased count and never blocks existing ones', async (t) => {
  const { pg, pool } = await database();
  await importState(pool, fixture());
  let limit = 2;
  const app = await serve(createApplication({ store: createStore(pool), seats: { limit: async () => limit } }));
  t.after(async () => {
    await app.close();
    await pg.close();
  });
  const headers = { 'X-Han-Request': '1', 'Content-Type': 'application/json' };
  const login = await fetch(app.url + '/api/login', { method: 'POST', headers, body: JSON.stringify({ username: 'test', password }) });
  const authed = { ...headers, cookie: login.headers.get('set-cookie').split(';')[0] };
  const post = async (route, body) => {
    const res = await fetch(app.url + route, { method: 'POST', headers: authed, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const list = async () => (await (await fetch(app.url + '/api/users', { headers: authed })).json());
  const newUser = (name) => ({ name, username: name.toLowerCase(), password: 'Synthetic-Seat-Pass-1', role: 'staff', permissions: [] });

  assert.equal((await post('/api/users', newUser('Birinci'))).status, 200, 'second user fits the two bought');
  const blocked = await post('/api/users', newUser('Ucuncu'));
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Satın alınan kullanıcı sayısına \(2\) ulaşıldı/);
  assert.equal((await list()).length, 2, 'nothing was created');

  // Deactivating frees a place; reactivating when full is refused again.
  const first = (await list()).find((u) => u.username === 'birinci');
  assert.equal((await post('/api/users', { id: first.id, name: 'Birinci', role: 'staff', permissions: [], active: false })).status, 200);
  assert.equal((await post('/api/users', newUser('Ucuncu'))).status, 200, 'room again after a deactivation');
  const reactivate = await post('/api/users', { id: first.id, name: 'Birinci', role: 'staff', permissions: [], active: true });
  assert.equal(reactivate.status, 409, 'switching an account back on is also a new seat');

  // Shrinking the plan below the current count never locks the existing users out of editing.
  limit = 1;
  const second = (await list()).find((u) => u.username === 'ucuncu');
  assert.equal((await post('/api/users', { id: second.id, name: 'Yeniden Adlandırıldı', role: 'staff', permissions: [], active: true })).status, 200);
  assert.equal((await post('/api/users', newUser('Dorduncu'))).status, 409);
});
