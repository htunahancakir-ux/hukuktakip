const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.SMS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { importState, createStore } = require('../lib/postgres-store.cjs');
const { createApplication } = require('../lib/application.cjs');
const { createBackupService, decryptState } = require('../lib/backup-service.cjs');
const { createVerimorSms, smsNumber } = require('../lib/verimor-sms.cjs');
const smsSettings = require('../lib/sms-settings.cjs');
const { password, fixture, database, serve } = require('./support/postgres.cjs');

const API_PASSWORD = 'Verimor-Api-Secret-Only-Test';
const ACCOUNT = '908501234567';
const PHONE = '905321234567';

// Fake Verimor SMS API v2. `fail` = { status, text } makes every call answer with that error.
function verimor() {
  const fake = { calls: [], fail: null };
  fake.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'sms.verimor.com.tr');
    fake.calls.push({
      path: parsed.pathname,
      query: parsed.searchParams,
      method: init.method,
      body: init.body ? JSON.parse(init.body) : null,
    });
    if (fake.fail) return new Response(fake.fail.text, { status: fake.fail.status });
    if (parsed.pathname === '/v2/send.json') return new Response('4711');
    if (parsed.pathname === '/v2/balance') return new Response('1250');
    if (parsed.pathname === '/v2/headers') return new Response('["HANHUKUK"]');
    return new Response('', { status: 404 });
  };
  fake.sent = () => fake.calls.filter((call) => call.path === '/v2/send.json');
  return fake;
}

const savedConfig = (input = {}) =>
  smsSettings.configure(undefined, {
    username: ACCOUNT,
    password: API_PASSWORD,
    header: 'HANHUKUK',
    enabled: true,
    ...input,
  });

async function start(state) {
  const { pg, pool } = await database();
  await importState(pool, state);
  const store = createStore(pool);
  const sms = verimor();
  const pending = [];
  const app = await serve(
    createApplication({ store, smsFetch: sms.fetch, background: (task) => pending.push(task) }),
  );
  const send = (route, input, { cookie, method = 'POST' } = {}) =>
    fetch(app.url + route, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1', ...(cookie && { cookie }) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(input ?? {}) }),
    });
  const login = (username, secret = password) => send('/api/login', { username, password: secret });
  const cookieFor = async (username) => (await login(username)).headers.get('set-cookie').split(';')[0];
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  return {
    pool,
    store,
    sms,
    send,
    login,
    cookieFor,
    settle,
    async close() {
      await settle();
      await app.close();
      await pg.close();
    },
  };
}

test('Verimor client sends the v2 body, maps errors and normalizes numbers', async () => {
  const sms = verimor();
  const client = createVerimorSms({
    username: ACCOUNT,
    password: API_PASSWORD,
    header: 'HANHUKUK',
    fetcher: sms.fetch,
  });
  const result = await client.send({ to: '0532 123 45 67', text: 'Deneme' });
  assert.deepEqual(result, { campaignId: '4711', dest: PHONE });
  const [call] = sms.calls;
  assert.equal(call.path, '/v2/send.json');
  assert.equal(call.method, 'POST');
  assert.deepEqual(call.body, {
    username: ACCOUNT,
    password: API_PASSWORD,
    source_addr: 'HANHUKUK',
    valid_for: '00:30',
    messages: [{ msg: 'Deneme', dest: PHONE }],
  });
  assert.equal(await client.balance(), 1250);
  assert.deepEqual(await client.headers(), ['HANHUKUK']);
  assert.equal(sms.calls[1].query.get('password'), API_PASSWORD);

  sms.fail = { status: 401, text: '' };
  await assert.rejects(
    client.send({ to: PHONE, text: 'x' }),
    (e) => /IP/.test(e.message) && e.status === 502,
  );
  sms.fail = { status: 400, text: 'INSUFFICIENT_CREDITS' };
  await assert.rejects(client.send({ to: PHONE, text: 'x' }), (e) => /kredisi/.test(e.message));
  sms.fail = null;
  const before = sms.calls.length;
  await assert.rejects(client.send({ to: '02121234567', text: 'x' }), (e) => e.status === 400);
  assert.equal(sms.calls.length, before, 'Invalid numbers never reach Verimor');
  assert.throws(
    () => createVerimorSms({ username: 'abc', password: 'x' }),
    (e) => e.status === 412,
  );
  const offline = createVerimorSms({
    username: ACCOUNT,
    password: API_PASSWORD,
    fetcher: async () => {
      throw new Error('offline');
    },
  });
  await assert.rejects(offline.balance(), (e) => e.status === 502);

  for (const value of ['0532 123 45 67', '5321234567', '+90 (532) 123-45-67', '905321234567', '05321234567'])
    assert.equal(smsNumber(value), PHONE, value);
  for (const value of ['02121234567', '12345', '', null, undefined, '9053212345678'])
    assert.equal(smsNumber(value), '', String(value));
});

test('SMS settings over HTTP: CEO only, password sealed and never returned', async () => {
  const state = fixture();
  state.users.push({
    ...state.users[0],
    id: 'sms-staff',
    username: 'staff',
    name: 'Personel',
    role: 'staff',
  });
  const app = await start(state);
  try {
    const ceo = await app.cookieFor('test');
    const staff = await app.cookieFor('staff');
    const input = { username: ACCOUNT, password: API_PASSWORD, header: 'HANHUKUK', enabled: true };
    assert.equal((await app.send('/api/sms/config', input, { cookie: staff, method: 'PUT' })).status, 403);
    assert.equal((await app.send('/api/sms/config', null, { cookie: staff, method: 'GET' })).status, 403);
    assert.equal((await app.send('/api/sms/test', {}, { cookie: staff })).status, 403);

    const saved = await app.send('/api/sms/config', input, { cookie: ceo, method: 'PUT' });
    assert.equal(saved.status, 200);
    const savedText = await saved.text();
    assert.doesNotMatch(savedText, new RegExp(API_PASSWORD));
    assert.equal(JSON.parse(savedText).enabled, true);
    const read = await app.send('/api/sms/config', null, { cookie: ceo, method: 'GET' });
    const readText = await read.text();
    assert.doesNotMatch(readText, new RegExp(API_PASSWORD));
    assert.doesNotMatch(readText, /passwordEnc/);
    assert.deepEqual(
      (({ configured, enabled, username, header }) => ({ configured, enabled, username, header }))(
        JSON.parse(readText),
      ),
      { configured: true, enabled: true, username: ACCOUNT, header: 'HANHUKUK' },
    );
    const stored = (await app.store.readState()).smsConfig;
    assert.ok(stored.passwordEnc);
    assert.doesNotMatch(JSON.stringify(await app.store.readState()), new RegExp(API_PASSWORD));

    // A blank password keeps the saved one.
    const kept = await app.send(
      '/api/sms/config',
      { username: ACCOUNT, password: '', header: 'YENI', enabled: true },
      { cookie: ceo, method: 'PUT' },
    );
    assert.equal(kept.status, 200);
    const after = (await app.store.readState()).smsConfig;
    assert.equal(after.passwordEnc, stored.passwordEnc);
    assert.equal(after.header, 'YENI');

    const tested = await app.send('/api/sms/test', {}, { cookie: ceo });
    assert.equal(tested.status, 200);
    assert.deepEqual(await tested.json(), { ok: true, balance: 1250, headers: ['HANHUKUK'] });
    assert.ok(app.sms.calls.every((call) => call.query.get('password') === API_PASSWORD));

    const sent = await app.send('/api/sms/send-test', { phone: '0532 123 45 67' }, { cookie: ceo });
    assert.equal(sent.status, 200);
    assert.deepEqual(await sent.json(), { ok: true, sms: { sent: true } });
    assert.equal(app.sms.sent().length, 1);
    assert.equal(app.sms.sent()[0].body.messages[0].dest, PHONE);
    assert.equal(app.sms.sent()[0].body.source_addr, 'YENI');

    app.sms.fail = { status: 400, text: 'INSUFFICIENT_CREDITS' };
    const failed = await (await app.send('/api/sms/send-test', { phone: PHONE }, { cookie: ceo })).json();
    assert.equal(failed.ok, true);
    assert.equal(failed.sms.sent, false);
    assert.match(failed.sms.error, /kredisi/);
    app.sms.fail = null;
    assert.equal((await app.send('/api/sms/send-test', { phone: '123' }, { cookie: ceo })).status, 400);
  } finally {
    await app.close();
  }
});

test('SMS password recovery: one-time code, same answer for every account, limits', async () => {
  const state = fixture();
  state.users[0].mobilePhone = PHONE;
  state.smsConfig = savedConfig();
  const app = await start(state);
  const request = async (account) => {
    const response = await app.send('/api/password-reset/request', { account });
    assert.equal(response.status, 200);
    const body = await response.json();
    await app.settle();
    return body;
  };
  const complete = async (code, newPassword = 'Replacement-Synthetic-Only') => {
    const response = await app.send('/api/password-reset/sms-complete', {
      account: 'test',
      code,
      password: newPassword,
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const lastCode = () =>
    app.sms
      .sent()
      .at(-1)
      .body.messages[0].msg.match(/\b(\d{8})\b/)[1];
  const otherThan = (code) => (code === '00000000' ? '11111111' : '00000000');
  try {
    const unknown = await request('unknown');
    const known = await request('test');
    assert.deepEqual(unknown, { ok: true, channel: 'sms' });
    assert.deepEqual(known, unknown);
    assert.equal(app.sms.sent().length, 1);
    const message = app.sms.sent()[0].body;
    assert.equal(message.messages[0].dest, PHONE);
    assert.equal(message.username, ACCOUNT);
    assert.equal(message.password, API_PASSWORD);
    const code = lastCode();
    assert.match(code, /^\d{8}$/);
    const saved = await app.store.readState();
    assert.equal(saved.smsRecovery.length, 1);
    assert.doesNotMatch(JSON.stringify(saved), new RegExp(code));

    const wrong = await complete(otherThan(code));
    assert.equal(wrong.ok, false);
    assert.ok(wrong.error);
    assert.equal((await app.store.readState()).smsRecovery[0].attempts, 1, 'Wrong attempt is committed');
    assert.deepEqual(await complete(code), { ok: true, username: 'test' });
    assert.equal((await app.login('test')).status, 401);
    assert.equal((await app.login('test', 'Replacement-Synthetic-Only')).status, 200);
    assert.equal((await complete(code, 'Another-Synthetic-Password')).ok, false, 'Code is single use');
    assert.equal((await app.login('test', 'Another-Synthetic-Password')).status, 401);

    // Five wrong tries kill a fresh code (requested by phone number this time).
    await request('0 532 123 45 67');
    assert.equal(app.sms.sent().length, 2);
    const fresh = lastCode();
    for (let i = 0; i < 5; i++) assert.equal((await complete(otherThan(fresh))).ok, false);
    assert.equal((await complete(fresh, 'Another-Synthetic-Password')).ok, false);
    assert.equal((await app.login('test', 'Another-Synthetic-Password')).status, 401);

    // Third request of the day is sent; the fourth answers the same but sends nothing.
    assert.deepEqual(await request('test'), unknown);
    assert.equal(app.sms.sent().length, 3);
    assert.deepEqual(await request('test'), unknown);
    assert.equal(app.sms.sent().length, 3);
  } finally {
    await app.close();
  }
});

// Validation and Verimor errors must reach the CEO with their status and message, not as a
// generic server error.
test('SMS settings errors reach the CEO with their status and message', async () => {
  const app = await start(fixture());
  try {
    const ceo = await app.cookieFor('test');
    const invalid = await app.send(
      '/api/sms/config',
      { username: 'abc', password: 'x' },
      { cookie: ceo, method: 'PUT' },
    );
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /hesap numaranızdır/);
    const unsaved = await app.send('/api/sms/test', {}, { cookie: ceo });
    assert.equal(unsaved.status, 412);
    const saved = await app.send(
      '/api/sms/config',
      { username: ACCOUNT, password: API_PASSWORD, enabled: true },
      { cookie: ceo, method: 'PUT' },
    );
    assert.equal(saved.status, 200);
    app.sms.fail = { status: 401, text: '' };
    const rejected = await app.send('/api/sms/test', {}, { cookie: ceo });
    assert.equal(rejected.status, 502);
    assert.match((await rejected.json()).error, /IP/);
  } finally {
    await app.close();
  }
});

test('Password reset channel: WhatsApp wins, otherwise SMS only when enabled', async () => {
  const cases = [
    {
      name: 'whatsapp configured',
      extra: { whatsappConfig: { enabled: true, resetTemplate: 'x' }, smsConfig: savedConfig() },
      status: 200,
      body: { ok: true, channel: 'whatsapp' },
    },
    { name: 'nothing configured', extra: {}, status: 503 },
    { name: 'sms disabled', extra: { smsConfig: savedConfig({ enabled: false }) }, status: 503 },
  ];
  for (const item of cases) {
    const state = { ...fixture(), ...item.extra };
    state.users[0].mobilePhone = PHONE;
    const app = await start(state);
    try {
      for (const account of ['test', 'unknown']) {
        const response = await app.send('/api/password-reset/request', { account });
        assert.equal(response.status, item.status, item.name);
        if (item.body) assert.deepEqual(await response.json(), item.body, item.name);
        await app.settle();
      }
      assert.equal(app.sms.calls.length, 0, item.name);
    } finally {
      await app.close();
    }
  }
});

test('Backups leave out SMS credentials and recovery codes', async (t) => {
  const keys = [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
    'BACKUP_ENCRYPTION_KEY',
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    R2_ACCOUNT_ID: 'example',
    R2_ACCESS_KEY_ID: 'test',
    R2_SECRET_ACCESS_KEY: 'test',
    R2_BUCKET_NAME: 'hanhukuktakip',
    BACKUP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'han-sms-backup-test-'));
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    for (const key of keys)
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
  });
  const state = {
    users: [{ id: 'ceo' }],
    data: { 'icrapro-v1': { docs: [] } },
    smsConfig: savedConfig(),
    smsRecovery: [{ userId: 'ceo', at: Date.now(), expires: Date.now() + 1, salt: 's', hash: 'h' }],
  };
  let policy = {};
  const store = {
    async readState() {
      return structuredClone(state);
    },
    async readPolicy() {
      return structuredClone(policy);
    },
    async updatePolicy(change) {
      const copy = structuredClone(policy);
      const result = change(copy);
      if (result !== null) policy = copy;
      return result;
    },
  };
  let remote;
  const backups = createBackupService({
    store,
    localDirectory: directory,
    upload: async (name, bytes) => {
      remote = { name, bytes };
    },
  });
  assert.equal((await backups.run({ force: true })).ok, true);
  const restored = decryptState(remote.bytes, Buffer.from(process.env.BACKUP_ENCRYPTION_KEY, 'hex'));
  assert.equal('smsConfig' in restored, false);
  assert.equal('smsRecovery' in restored, false);
  assert.deepEqual(restored, { users: state.users, data: state.data });
});

// The SMS page once vanished from the served scripts in a merge: the settings tab then
// failed with "smsSettingsPage is not defined". Every workspace script must be served.
test('every workspace script on disk is in the served script list', () => {
  const served = new Set(require('../outputs/icrapro/workspace-assets.js'));
  const missing = fs
    .readdirSync('outputs/icrapro')
    .filter((name) => /^workspace-.*\.js$/.test(name) && name !== 'workspace-assets.js' && !served.has(name));
  assert.deepEqual(missing, []);
});
