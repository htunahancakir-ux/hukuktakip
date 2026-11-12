const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const settings = require('../lib/iyzico-settings.cjs');

process.env.AI_ENCRYPTION_KEY ||= 'a'.repeat(64);
const API_KEY = 'sandbox-ApiKey1234';
const SECRET = 'sandbox-SecretKey-5678';

test('office iyzico integration: CEO only, sealed keys, test and payment link', async (t) => {
  const { pg, pool } = await database();
  const state = fixture();
  state.users.push({ ...state.users[0], id: 'staff', username: 'staff', role: 'staff', staffId: 'p', permissions: [] });
  state.data['icrapro-personnel-v1'] = [{ id: 'p', name: 'Personel', phone: '05320000001', active: true, officialSalary: 40000 }];
  await importState(pool, state);
  const upstream = [];
  let reply = (url) => ({ status: 'success', data: { token: 'lnk', url: 'https://iyzi.link/ABC' } });
  const iyzicoFetch = async (url, options) => {
    upstream.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined });
    return { ok: true, status: 200, json: async () => reply(url) };
  };
  const app = await serve(createApplication({ store: createStore(pool), iyzicoFetch }));
  t.after(async () => {
    await app.close();
    await pg.close();
  });
  const base = { 'X-Han-Request': '1', 'Content-Type': 'application/json' };
  async function login(username) {
    const res = await fetch(app.url + '/api/login', { method: 'POST', headers: base, body: JSON.stringify({ username, password }) });
    assert.equal(res.status, 200);
    return { ...base, cookie: res.headers.get('set-cookie').split(';')[0] };
  }
  const ceo = await login('test');
  const staff = await login('staff');
  const call = async (route, headers, method = 'GET', body) => {
    const res = await fetch(app.url + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const rawState = async () => (await pool.query('SELECT payload::text AS text FROM han_private.han_state WHERE id = 1')).rows[0].text;

  await t.test('only the CEO reaches any iyzico route', async () => {
    for (const [route, method] of [['/api/iyzico/config', 'GET'], ['/api/iyzico/config', 'PUT'], ['/api/iyzico/test', 'POST'], ['/api/iyzico/link', 'POST']])
      assert.equal((await call(route, staff, method, method === 'GET' ? undefined : {})).status, 403, route);
    const anonymous = await fetch(app.url + '/api/iyzico/config');
    assert.equal(anonymous.status, 401);
  });

  await t.test('a fresh office is not connected', async () => {
    assert.deepEqual((await call('/api/iyzico/config', ceo)).body, { configured: false, mode: 'sandbox', apiKeyHint: '', updatedAt: null });
    assert.equal((await call('/api/iyzico/link', ceo, 'POST', { name: 'Ücret', description: 'Danışmanlık', amountKurus: 10000 })).status, 400, 'no keys yet');
  });

  await t.test('keys are validated, stored sealed and never returned', async () => {
    for (const bad of [{ apiKey: 'short', secretKey: SECRET }, { apiKey: API_KEY, secretKey: 'bad key with spaces' }, { apiKey: API_KEY }, { secretKey: SECRET }, { apiKey: API_KEY, secretKey: SECRET, mode: 'staging' }])
      assert.equal((await call('/api/iyzico/config', ceo, 'PUT', bad)).status, 400, JSON.stringify(bad));
    assert.equal(await rawState().then((s) => s.includes('iyzicoConfig')), false, 'failed saves leave nothing behind');
    const saved = await call('/api/iyzico/config', ceo, 'PUT', { apiKey: API_KEY, secretKey: SECRET, mode: 'sandbox' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.configured, true);
    assert.equal(saved.body.apiKeyHint, '…1234');
    assert.ok(!JSON.stringify(saved.body).includes(SECRET) && !JSON.stringify(saved.body).includes(API_KEY));
    const again = await call('/api/iyzico/config', ceo);
    assert.ok(!JSON.stringify(again.body).includes(SECRET) && !JSON.stringify(again.body).includes(API_KEY));
    const stored = await rawState();
    assert.ok(stored.includes('"iyzicoConfig"'));
    assert.ok(!stored.includes(SECRET) && !stored.includes(API_KEY), 'plain keys are not in the stored workspace');
  });

  await t.test('changing the mode keeps the saved keys', async () => {
    const live = await call('/api/iyzico/config', ceo, 'PUT', { mode: 'live' });
    assert.equal(live.status, 200);
    assert.equal(live.body.mode, 'live');
    assert.equal(live.body.configured, true);
    assert.equal(live.body.apiKeyHint, '…1234');
    await call('/api/iyzico/config', ceo, 'PUT', { mode: 'sandbox' });
  });

  await t.test('the test button uses typed keys when given, else the saved ones, and stores nothing', async () => {
    upstream.length = 0;
    reply = () => ({ status: 'success' });
    assert.deepEqual((await call('/api/iyzico/test', ceo, 'POST', {})).body, { ok: true });
    assert.equal(upstream[0].url, 'https://sandbox-api.iyzipay.com/payment/bin/check');
    const savedAuth = Buffer.from(upstream[0].options.headers.Authorization.slice(8), 'base64').toString();
    assert.match(savedAuth, new RegExp('^apiKey:' + API_KEY));
    const typed = await call('/api/iyzico/test', ceo, 'POST', { apiKey: 'typed-ApiKey-0000', secretKey: 'typed-Secret-0000', mode: 'live' });
    assert.equal(typed.body.ok, true);
    assert.equal(upstream[1].url, 'https://api.iyzipay.com/payment/bin/check');
    assert.match(Buffer.from(upstream[1].options.headers.Authorization.slice(8), 'base64').toString(), /^apiKey:typed-ApiKey-0000/);
    assert.equal((await call('/api/iyzico/config', ceo)).body.apiKeyHint, '…1234', 'testing does not replace the saved key');
    reply = () => ({ status: 'failure', errorMessage: 'Geçersiz anahtar' });
    assert.deepEqual((await call('/api/iyzico/test', ceo, 'POST', {})).body, { ok: false, message: 'Geçersiz anahtar' });
  });

  await t.test('a payment link is created for validated amounts only and returns an iyzico URL', async () => {
    upstream.length = 0;
    reply = () => ({ status: 'success', data: { token: 'lnk', url: 'https://iyzi.link/ABC' } });
    const link = await call('/api/iyzico/link', ceo, 'POST', { name: 'Danışmanlık', description: 'Kasım ücreti', amountKurus: 125050 });
    assert.deepEqual(link.body, { url: 'https://iyzi.link/ABC' });
    assert.equal(upstream[0].url, 'https://sandbox-api.iyzipay.com/v2/iyzilink/products');
    assert.equal(upstream[0].body.price, '1250.50');
    assert.equal(upstream[0].body.currencyCode, 'TRY');
    const before = upstream.length;
    for (const bad of [{ amountKurus: 99 }, { amountKurus: 12.5 }, { amountKurus: 100_000_001 }, { amountKurus: '1000' }, { name: 'x' }, { description: '' }])
      assert.equal((await call('/api/iyzico/link', ceo, 'POST', { name: 'Danışmanlık', description: 'Kasım ücreti', amountKurus: 10000, ...bad })).status, 400, JSON.stringify(bad));
    assert.equal(upstream.length, before, 'nothing invalid reached iyzico');
    reply = () => ({ status: 'success', data: { token: 'lnk', url: 'https://evil.example/x' } });
    assert.equal((await call('/api/iyzico/link', ceo, 'POST', { name: 'Danışmanlık', description: 'Kasım ücreti', amountKurus: 10000 })).status, 400);
  });

  await t.test('clearing removes the keys', async () => {
    const cleared = await call('/api/iyzico/config', ceo, 'PUT', { clear: true });
    assert.equal(cleared.body.configured, false);
    assert.ok(!(await rawState()).includes('iyzicoConfig'));
    assert.equal((await call('/api/iyzico/link', ceo, 'POST', { name: 'Danışmanlık', description: 'Kasım ücreti', amountKurus: 10000 })).status, 400);
  });
});

test('office iyzico settings: merging, hints and missing encryption key', () => {
  const first = settings.configure(undefined, { apiKey: API_KEY, secretKey: SECRET });
  assert.equal(first.mode, 'sandbox');
  assert.equal(first.apiKeyHint, '…1234');
  assert.ok(first.apiKeyEnc && first.secretKeyEnc && !JSON.stringify(first).includes(SECRET));
  const second = settings.configure(first, { apiKey: 'another-ApiKey-9999' });
  assert.equal(second.apiKeyHint, '…9999');
  assert.equal(second.secretKeyEnc, first.secretKeyEnc, 'a blank secret keeps the saved one');
  assert.equal(settings.configure(second, { clear: true }), undefined);
  assert.deepEqual(settings.publicConfig(undefined), { configured: false, mode: 'sandbox', apiKeyHint: '', updatedAt: null });
  const saved = process.env.AI_ENCRYPTION_KEY;
  const backup = process.env.BACKUP_ENCRYPTION_KEY;
  delete process.env.AI_ENCRYPTION_KEY;
  delete process.env.BACKUP_ENCRYPTION_KEY;
  delete process.env.IYZICO_ENCRYPTION_KEY;
  try {
    assert.throws(() => settings.configure(undefined, { apiKey: API_KEY, secretKey: SECRET }), (e) => e.status === 503);
  } finally {
    process.env.AI_ENCRYPTION_KEY = saved;
    if (backup !== undefined) process.env.BACKUP_ENCRYPTION_KEY = backup;
  }
});
