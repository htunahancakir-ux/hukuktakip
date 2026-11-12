const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { createVerimorSms, smsNumber, segments } = require('../lib/verimor-sms.cjs');
const platformSms = require('../lib/saas/platform-sms.cjs');
const { createPlatformAdmin } = require('../lib/saas/platform-auth.cjs');
const { createPlatformHandler } = require('../lib/platform-app.cjs');
const { officeManagers, resetManager } = require('../lib/saas/office-recovery.cjs');
const { verifyPassword } = require('../lib/password-policy.cjs');
const platform = require('../lib/saas/platform.cjs');

process.env.PLATFORM_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
const API_PASSWORD = 'Synthetic-Verimor-Api-Pass';
const opPassword = 'Synthetic-Platform-Sms-Test!';

// A stand-in for sms.verimor.com.tr that records every call.
function fakeVerimor({ status = 200, body = '4711' } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    const path = new URL(url).pathname;
    const reply = (s, text) => ({ ok: s < 400, status: s, text: async () => text });
    if (status !== 200) return reply(status, body);
    if (path === '/v2/balance') return reply(200, '1250');
    if (path === '/v2/headers') return reply(200, '["HANHUKUK","DENEME"]');
    if (path === '/v2/send.json') return reply(200, body);
    return reply(404, '');
  };
  return { calls, fetcher, sent: () => calls.filter((c) => c.url.endsWith('/send.json')) };
}

test('Verimor client sends the documented JSON and maps errors', async () => {
  assert.equal(smsNumber('0532 123 45 67'), '905321234567');
  assert.equal(smsNumber('+90 (532) 123-45-67'), '905321234567');
  assert.equal(smsNumber('0212 123 45 67'), '', 'landlines are refused');
  assert.equal(segments('a'.repeat(160)), 1);
  assert.equal(segments('a'.repeat(161)), 2);
  assert.equal(segments('ş'.repeat(156)), 2, 'Turkish letters shrink a segment');

  const ok = fakeVerimor();
  const client = createVerimorSms({ username: '908501234567', password: API_PASSWORD, header: 'HANHUKUK', fetcher: ok.fetcher });
  assert.deepEqual(await client.send({ to: '05321234567', text: 'Merhaba' }), { campaignId: '4711', dest: '905321234567' });
  const sent = ok.sent()[0];
  assert.equal(sent.url, 'https://sms.verimor.com.tr/v2/send.json');
  assert.equal(sent.method, 'POST');
  assert.deepEqual(sent.body, {
    username: '908501234567',
    password: API_PASSWORD,
    source_addr: 'HANHUKUK',
    valid_for: '00:30',
    messages: [{ msg: 'Merhaba', dest: '905321234567' }],
  });
  assert.equal(await client.balance(), 1250);
  assert.deepEqual(await client.headers(), ['HANHUKUK', 'DENEME']);
  await assert.rejects(() => client.send({ to: '123', text: 'x' }), (e) => e.status === 400);

  const unauthorized = createVerimorSms({ username: '908501234567', password: 'x', fetcher: fakeVerimor({ status: 401, body: 'Geçersiz kullanıcı adı/şifre' }).fetcher });
  await assert.rejects(() => unauthorized.balance(), (e) => e.code === 'UNAUTHORIZED' && /IP/.test(e.message));
  const noCredit = createVerimorSms({ username: '908501234567', password: 'x', fetcher: fakeVerimor({ status: 400, body: 'INSUFFICIENT_CREDITS' }).fetcher });
  await assert.rejects(() => noCredit.send({ to: '05321234567', text: 'x' }), (e) => e.code === 'INSUFFICIENT_CREDITS' && /kredisi/.test(e.message));
  const down = createVerimorSms({ username: '908501234567', password: 'x', fetcher: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(() => down.balance(), (e) => e.status === 502);
  assert.throws(() => createVerimorSms({ username: 'abc', password: 'x' }), (e) => e.status === 412);
});

test('platform SMS settings are sealed, testable before saving, logged and capped per office', async () => {
  const { pg, pool } = await database();
  try {
    const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Op', password: opPassword })).id;
    const fake = fakeVerimor();
    assert.deepEqual((await platformSms.getSettings(pool)).configured, false);
    await assert.rejects(() => platformSms.sendSms(pool, { to: '05321234567', text: 'x', purpose: 'test' }, { fetcher: fake.fetcher }), (e) => e.status === 412);

    // Test with typed values before anything is saved.
    const tested = await platformSms.testSettings(pool, { username: '908501234567', password: API_PASSWORD }, { fetcher: fake.fetcher });
    assert.deepEqual(tested, { ok: true, balance: 1250, headers: ['HANHUKUK', 'DENEME'] });
    await assert.rejects(() => platformSms.saveSettings(pool, op, { username: '12ab' , password: 'x' }), (e) => e.status === 400);

    const saved = await platformSms.saveSettings(pool, op, { username: '908501234567', password: API_PASSWORD, header: 'HANHUKUK', enabled: true });
    assert.deepEqual([saved.configured, saved.enabled, saved.username, saved.header], [true, true, '908501234567', 'HANHUKUK']);
    const raw = JSON.stringify((await pool.query("SELECT value FROM han_saas.platform_settings WHERE key = 'sms'")).rows[0].value);
    assert.ok(!raw.includes(API_PASSWORD), 'API password is sealed at rest');
    assert.ok(!JSON.stringify(await platformSms.getSettings(pool)).includes(API_PASSWORD), 'and never returned');

    // A blank password keeps the saved one; the header can change on its own.
    await platformSms.saveSettings(pool, op, { header: 'DENEME' });
    await platformSms.testSettings(pool, {}, { fetcher: fake.fetcher });
    assert.ok(fake.calls.at(-1).url.includes('password=' + encodeURIComponent(API_PASSWORD)), 'saved password used');

    const office = (
      await platform.openOffice(pool, op, {
        slug: 'sms-buro', name: 'SMS Büro', admin: { name: 'Y', username: 'y', password: opPassword },
        userCount: 2, userPriceKurus: 1000, termMonths: 1, moduleCodes: [], paid: true,
      })
    ).office;
    const sender = platformSms.createPlatformSms(pool, { tenantId: office.id, fetcher: fake.fetcher, cacheMs: 0 });
    assert.equal(await sender.available(), true);
    await sender.send({ to: '05321234567', text: 'Gecici sifreniz: 12345678.' });
    assert.equal(fake.sent().at(-1).body.source_addr, 'DENEME');
    const settings = await platformSms.getSettings(pool);
    assert.equal(settings.usage.monthSent, 1);
    assert.equal(settings.recent[0].dest, '90532*****67', 'numbers are stored masked');
    assert.equal(settings.recent[0].office, 'SMS Büro');
    const stored = JSON.stringify((await pool.query('SELECT * FROM han_saas.sms_log')).rows);
    assert.ok(!stored.includes('12345678') && !stored.includes('905321234567'), 'no message text or full number stored');

    for (let i = 1; i < platformSms.DAILY_LIMIT_PER_OFFICE; i++) await sender.send({ to: '05321234567', text: 'x' });
    await assert.rejects(() => sender.send({ to: '05321234567', text: 'x' }), (e) => e.status === 429);
    assert.equal(fake.sent().length, platformSms.DAILY_LIMIT_PER_OFFICE, 'the blocked one never reached Verimor');
    assert.equal((await platformSms.getSettings(pool)).usage.blocked30, 1);

    await platformSms.saveSettings(pool, op, { enabled: false });
    assert.equal(await sender.available(), false, 'switching it off stops recovery SMS');
    await assert.rejects(() => sender.send({ to: '05321234567', text: 'x' }), (e) => e.status === 412);
  } finally {
    await pg.close();
  }
});

test('Şifremi unuttum: without office WhatsApp, a one-time SMS password lets the user set a new password', async (t) => {
  const { pg, pool } = await database();
  const state = fixture();
  state.users[0].mobilePhone = '905321234567';
  await importState(pool, state);
  const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Op', password: opPassword })).id;
  await platformSms.saveSettings(pool, op, { username: '908501234567', password: API_PASSWORD, header: 'HANHUKUK', enabled: true });
  const fake = fakeVerimor();
  const pending = [];
  const app = await serve(
    createApplication({
      store: createStore(pool),
      platformSms: platformSms.createPlatformSms(pool, { fetcher: fake.fetcher, cacheMs: 0 }),
      background: (promise) => pending.push(promise),
    }),
  );
  t.after(async () => {
    await app.close();
    await pg.close();
  });
  const headers = { 'X-Han-Request': '1', 'Content-Type': 'application/json' };
  const post = async (route, body) => {
    const res = await fetch(app.url + route, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const lastCode = () => /(\d{8})/.exec(fake.sent().at(-1).body.messages[0].msg)[1];

  const unknown = await post('/api/password-reset/request', { account: 'nobody' });
  const known = await post('/api/password-reset/request', { account: '0532 123 45 67' });
  await Promise.all(pending);
  assert.deepEqual(unknown, known, 'the answer never reveals whether the account exists');
  assert.deepEqual(known.body, { ok: true, channel: 'sms' });
  assert.equal(fake.sent().length, 1);
  assert.equal(fake.sent()[0].body.messages[0].dest, '905321234567');
  const code = lastCode();
  assert.ok(!JSON.stringify((await pool.query('SELECT payload FROM han_private.han_state')).rows).includes(code), 'only a hash is stored');

  const weak = await post('/api/password-reset/sms-complete', { account: 'test', code, password: 'short' });
  assert.equal(weak.status, 400);
  const wrong = await post('/api/password-reset/sms-complete', { account: 'test', code: '00000000', password: 'New-Synthetic-Password-1' });
  assert.deepEqual(wrong.body.ok, false);
  const done = await post('/api/password-reset/sms-complete', { account: '05321234567', code, password: 'New-Synthetic-Password-1' });
  assert.deepEqual(done.body, { ok: true, username: 'test' });
  assert.equal((await post('/api/login', { username: 'test', password })).status, 401, 'old password is gone');
  assert.equal((await post('/api/login', { username: 'test', password: 'New-Synthetic-Password-1' })).status, 200);
  const reused = await post('/api/password-reset/sms-complete', { account: 'test', code, password: 'Another-Synthetic-Pass-2' });
  assert.equal(reused.body.ok, false, 'a temporary password works once');

  // Five wrong tries kill a fresh code even if the right one comes next.
  await post('/api/password-reset/request', { account: 'test' });
  await Promise.all(pending);
  const fresh = lastCode();
  for (let i = 0; i < 5; i++) await post('/api/password-reset/sms-complete', { account: 'test', code: String(10000000 + i), password: 'Another-Synthetic-Pass-2' });
  assert.equal((await post('/api/password-reset/sms-complete', { account: 'test', code: fresh, password: 'Another-Synthetic-Pass-2' })).body.ok, false);

  // Per-account limit: 3 a day. The fourth request is answered the same way but sends nothing.
  const before = fake.sent().length;
  await post('/api/password-reset/request', { account: 'test' });
  await post('/api/password-reset/request', { account: 'test' });
  await Promise.all(pending);
  assert.equal(fake.sent().length, before + 1, 'third request of the day sent, fourth silently not');
});

test('once the office sets up WhatsApp, or when platform SMS is off, recovery does not use platform SMS', async (t) => {
  const run = async ({ whatsapp, available }) => {
    const { pg, pool } = await database();
    const state = fixture();
    state.users[0].mobilePhone = '905321234567';
    if (whatsapp) state.whatsappConfig = { enabled: true, resetTemplate: 'password_link_tr' };
    await importState(pool, state);
    const sent = [];
    const app = await serve(
      createApplication({
        store: createStore(pool),
        platformSms: { available: async () => available, send: async (job) => sent.push(job) },
        background: () => {},
      }),
    );
    try {
      const res = await fetch(app.url + '/api/password-reset/request', {
        method: 'POST',
        headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: 'test' }),
      });
      return { status: res.status, body: await res.json(), sent };
    } finally {
      await app.close();
      await pg.close();
    }
  };
  const viaWhatsApp = await run({ whatsapp: true, available: true });
  assert.deepEqual([viaWhatsApp.status, viaWhatsApp.body.channel, viaWhatsApp.sent.length], [200, 'whatsapp', 0], 'office WhatsApp wins');
  const nothing = await run({ whatsapp: false, available: false });
  assert.equal(nothing.status, 503, 'no WhatsApp and no platform SMS: the old "not set up" answer');
  assert.equal(nothing.sent.length, 0);
});

test('console: an operator resets an office manager by SMS code or a one-time temporary password', async () => {
  const { pg, pool } = await database();
  try {
    const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Op', password: opPassword })).id;
    const fake = fakeVerimor();
    const office = (
      await platform.openOffice(pool, op, {
        slug: 'kilitli', name: 'Kilitli Büro', admin: { name: 'Ceo Kişi', username: 'ceo', password: opPassword },
        userCount: 2, userPriceKurus: 1000, termMonths: 1, moduleCodes: [], paid: true,
      })
    ).office;
    const managers = await officeManagers(pool, office.id);
    assert.equal(managers.length, 1);
    const ceo = managers[0];
    assert.equal(ceo.phone, null);

    // SMS needs the platform service switched on and a registered mobile.
    await assert.rejects(() => resetManager(pool, op, { tenantId: office.id, userId: ceo.id, mode: 'sms' }, { fetcher: fake.fetcher }), (e) => e.status === 412);
    await platformSms.saveSettings(pool, op, { username: '908501234567', password: API_PASSWORD, enabled: true });
    await assert.rejects(() => resetManager(pool, op, { tenantId: office.id, userId: ceo.id, mode: 'sms' }, { fetcher: fake.fetcher }), (e) => e.status === 409);
    await pool.query(
      `UPDATE han_private.han_state SET payload = jsonb_set(payload, '{users,0,mobilePhone}', '"905551112233"') WHERE tenant_id = $1 AND id = 1`,
      [office.id],
    );
    assert.equal((await officeManagers(pool, office.id))[0].phone, '90555*****33');
    const bySms = await resetManager(pool, op, { tenantId: office.id, userId: ceo.id, mode: 'sms' }, { fetcher: fake.fetcher });
    assert.deepEqual(bySms, { mode: 'sms', username: 'ceo', phone: '90555*****33' });
    assert.equal(fake.sent()[0].body.messages[0].dest, '905551112233');
    const payload = (await pool.query('SELECT payload FROM han_private.han_state WHERE tenant_id = $1', [office.id])).rows[0].payload;
    assert.equal(payload.smsRecovery.length, 1, 'the code row lives in the office state, hashed');
    assert.ok(await verifyPassword(opPassword, payload.users[0]), 'an SMS code does not change the password by itself');

    const byPassword = await resetManager(pool, op, { tenantId: office.id, userId: ceo.id, mode: 'password' });
    assert.equal(byPassword.mode, 'password');
    assert.match(byPassword.temporaryPassword, /^[A-Za-z0-9_-]{12}$/);
    const after = (await pool.query('SELECT payload FROM han_private.han_state WHERE tenant_id = $1', [office.id])).rows[0].payload;
    assert.ok(await verifyPassword(byPassword.temporaryPassword, after.users[0]));
    assert.ok(!(await verifyPassword(opPassword, after.users[0])));

    const events = (await pool.query("SELECT detail FROM han_saas.tenant_events WHERE action = 'manager_password_reset' ORDER BY id")).rows;
    assert.deepEqual(events.map((e) => e.detail.mode), ['sms', 'password']);
    assert.ok(!JSON.stringify(events).includes(byPassword.temporaryPassword), 'the temporary password is not logged');

    await assert.rejects(() => resetManager(pool, op, { tenantId: office.id, userId: 'nope', mode: 'password' }), (e) => e.status === 404);
    await assert.rejects(() => resetManager(pool, op, { tenantId: office.id, userId: ceo.id, mode: 'email' }), (e) => e.status === 400);
  } finally {
    await pg.close();
  }
});

test('console HTTP: SMS settings and manager reset need an operator session', async (t) => {
  const { pg, pool } = await database();
  await createPlatformAdmin(pool, { username: 'root', name: 'Op', password: opPassword });
  const fake = fakeVerimor();
  const server = await serve(createPlatformHandler({ pool, secureCookies: false, smsFetch: fake.fetcher, requireTotp: false }));
  t.after(async () => {
    await server.close();
    await pg.close();
  });
  const call = async (path, { method = 'GET', body, cookie } = {}) => {
    const res = await fetch(server.url + '/api/platform/' + path, {
      method,
      headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-Han-Request': '1' } : {}), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json(), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  for (const path of ['settings/sms', 'offices/x/managers']) assert.equal((await call(path)).status, 401, path);
  assert.equal((await call('settings/sms', { method: 'POST', body: {} })).status, 401);
  const cookie = (await call('login', { method: 'POST', body: { username: 'root', password: opPassword } })).cookie;
  const saved = await call('settings/sms', { method: 'POST', cookie, body: { username: '908501234567', password: API_PASSWORD, enabled: true } });
  assert.equal(saved.status, 200);
  assert.ok(!JSON.stringify(saved.json).includes(API_PASSWORD));
  assert.deepEqual((await call('settings/sms/test', { method: 'POST', cookie, body: {} })).json.headers, ['HANHUKUK', 'DENEME']);
  assert.equal((await call('settings/sms/send-test', { method: 'POST', cookie, body: { phone: '05321234567' } })).status, 200);
  assert.equal(fake.sent().length, 1);
  const audit = (await call('operators', { cookie })).json.audit.map((a) => a.action);
  assert.ok(audit.includes('settings.sms') && audit.includes('settings.sms_test'));
});
