const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { createModuleGate, GATED_MODULES } = require('../lib/saas/module-gate.cjs');
const { createPlatformAdmin } = require('../lib/saas/platform-auth.cjs');
const { LEGACY_TENANT_ID } = require('../lib/saas/tenant-pool.cjs');
const platform = require('../lib/saas/platform.cjs');

const secret = 'Synthetic-Module-Gate-Test!';
const ALL_ON = {
  voip: true,
  'ai-assistant': true,
  whatsapp: true,
  'marketing-routes': true,
  'marketing-routes-service': true,
};
const OFF = {
  voip: false,
  'ai-assistant': false,
  whatsapp: false,
  'marketing-routes': false,
  'marketing-routes-service': false,
};

test('add-on gate follows the sales console: off by default, on after a sale, off after removal', async () => {
  const { pg, pool } = await database();
  try {
    const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Operatör', password: secret })).id;
    await platform.upsertModule(pool, { code: 'voip', name: 'Çağrı', monthlyPriceKurus: 5000, active: true });
    await platform.upsertModule(pool, {
      code: 'ai-assistant',
      name: 'Yapay zekâ',
      monthlyPriceKurus: 8000,
      active: true,
    });
    const office = (
      await platform.openOffice(pool, op, {
        slug: 'modulsuz',
        name: 'Modülsüz Büro',
        admin: { name: 'Y', username: 'y', password: secret },
        userCount: 2,
        userPriceKurus: 1000,
        termMonths: 1,
        moduleCodes: [],
        paid: true,
      })
    ).office;

    const gate = createModuleGate(pool, { tenantId: office.id, cacheMs: 0 });
    assert.deepEqual(await gate.all(), OFF, 'sold without add-ons');
    assert.equal(await gate.enabled('voip'), false);

    await platform.addModule(pool, op, { tenantId: office.id, moduleCode: 'voip', paid: true });
    assert.deepEqual(await gate.all(), { ...OFF, voip: true }, 'sold later');

    await platform.addModule(pool, op, { tenantId: office.id, moduleCode: 'ai-assistant', paid: true });
    assert.equal(await gate.enabled('ai-assistant'), true);
    await platform.removeModule(pool, op, { tenantId: office.id, moduleCode: 'voip' });
    assert.equal(await gate.enabled('voip'), false, 'removal switches the feature off again');

    const withModules = (
      await platform.openOffice(pool, op, {
        slug: 'paketli',
        name: 'Paketli Büro',
        admin: { name: 'Y', username: 'z', password: secret },
        userCount: 1,
        userPriceKurus: 1000,
        termMonths: 1,
        moduleCodes: ['voip', 'ai-assistant'],
        paid: true,
      })
    ).office;
    assert.deepEqual(await createModuleGate(pool, { tenantId: withModules.id }).all(), {
      ...OFF,
      voip: true,
      'ai-assistant': true,
    });

    const legacy = createModuleGate(pool, { tenantId: LEGACY_TENANT_ID });
    assert.deepEqual(await legacy.all(), ALL_ON, 'the existing office keeps every feature');
  } finally {
    await pg.close();
  }
});

test('add-on gate caches briefly and denies when the control plane cannot be asked', async () => {
  let calls = 0;
  let clock = 1000;
  let fail = false;
  const pool = {
    async query() {
      calls++;
      if (fail) throw new Error('db down');
      return { rows: [{ module_code: 'voip' }] };
    },
  };
  const gate = createModuleGate(pool, {
    tenantId: '11111111-1111-4111-8111-111111111111',
    cacheMs: 100,
    now: () => clock,
  });
  assert.equal(await gate.enabled('voip'), true);
  assert.equal(await gate.enabled('voip'), true);
  assert.equal(calls, 1, 'second lookup is cached');
  clock += 101;
  fail = true;
  await assert.rejects(
    () => gate.enabled('voip'),
    (error) => error.status === 503,
  );
  assert.deepEqual(GATED_MODULES, [
    'voip',
    'ai-assistant',
    'whatsapp',
    'marketing-routes',
    'marketing-routes-service',
  ]);
});

test('the application refuses phone and AI routes for an office without the module', async (t) => {
  const { pg, pool } = await database();
  await importState(pool, fixture());
  const enabled = new Set();
  const gate = {
    enabled: async (code) => enabled.has(code),
    all: async () => Object.fromEntries(GATED_MODULES.map((code) => [code, enabled.has(code)])),
  };
  const app = await serve(createApplication({ store: createStore(pool), modules: gate }));
  t.after(async () => {
    await app.close();
    await pg.close();
  });
  const headers = { 'X-Han-Request': '1', 'Content-Type': 'application/json' };
  const login = await fetch(app.url + '/api/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: 'test', password }),
  });
  assert.equal(login.status, 200);
  const authed = { ...headers, cookie: login.headers.get('set-cookie').split(';')[0] };
  const call = async (route, init = {}) => {
    const res = await fetch(app.url + route, { headers: authed, ...init });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  assert.deepEqual((await call('/api/modules')).body, OFF);
  for (const [route, init] of [
    ['/api/voip/calls'],
    ['/api/voip/config'],
    ['/api/voip/webhook', { method: 'POST', body: '{}' }],
    ['/api/voip/cron'],
    ['/api/ai/config'],
    ['/api/ai/test', { method: 'POST', body: '{}' }],
    ['/api/documents/conversation-report', { method: 'POST', body: JSON.stringify({ documentId: 'x' }) }],
    ['/api/whatsapp/config'],
    ['/api/whatsapp/reminder', { method: 'POST', body: '{}' }],
    ['/api/marketing/config'],
    ['/api/marketing/search', { method: 'POST', body: '{}' }],
    ['/api/marketing/routes'],
  ]) {
    const result = await call(route, init);
    assert.equal(result.status, 403, route);
    assert.match(result.body.error, /modülü bu büroda etkin değil/, route);
  }
  assert.equal((await call('/api/session')).status, 200, 'the rest of the app is unaffected');

  enabled.add('voip');
  assert.deepEqual((await call('/api/modules')).body, { ...OFF, voip: true });
  assert.notEqual((await call('/api/voip/calls')).status, 403, 'a sold module reaches its own handler');
  assert.equal((await call('/api/ai/config')).status, 403, 'only the module that was sold opens');
  assert.equal((await call('/api/whatsapp/config')).status, 403, 'voip does not open whatsapp');
  assert.equal(
    (await call('/api/marketing-prospects')).status,
    200,
    'the prospect list is core CRM, not the paid route finder',
  );

  enabled.add('whatsapp');
  enabled.add('marketing-routes');
  assert.notEqual((await call('/api/whatsapp/config')).status, 403);
  assert.notEqual((await call('/api/marketing/config')).status, 403);

  const anonymous = await fetch(app.url + '/api/modules');
  assert.equal(anonymous.status, 401);
});

test('without a gate (single office / local) every feature stays on', async (t) => {
  const { pg, pool } = await database();
  await importState(pool, fixture());
  const app = await serve(createApplication({ store: createStore(pool) }));
  t.after(async () => {
    await app.close();
    await pg.close();
  });
  const headers = { 'X-Han-Request': '1', 'Content-Type': 'application/json' };
  const login = await fetch(app.url + '/api/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: 'test', password }),
  });
  const res = await fetch(app.url + '/api/modules', {
    headers: { ...headers, cookie: login.headers.get('set-cookie').split(';')[0] },
  });
  // The map service is a subscription to the selling company's account: absent here.
  assert.deepEqual(await res.json(), { ...ALL_ON, 'marketing-routes-service': false });
});
