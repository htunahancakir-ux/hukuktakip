const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { fixture, database, serve, password } = require('./support/postgres.cjs');
const sms = require('../lib/sms-settings.cjs');
const wa = require('../lib/whatsapp.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
process.env.SMS_ENCRYPTION_KEY = '12'.repeat(32);
process.env.WHATSAPP_ENCRYPTION_KEY = '34'.repeat(32);

test('expired SMS and WhatsApp proof cannot activate channels', async () => {
  const crypto = require('node:crypto');
  const channels = require('../lib/recovery-channels.cjs');
  const state = fixture();
  state.smsConfig = sms.configure(undefined, {
    enabled: true,
    username: '908501234567',
    password: 'Synthetic-SMS-Key',
    header: 'HANHUKUK',
  });
  state.whatsappConfig = wa.configure(undefined, {
    enabled: true,
    phoneNumberId: '123456789',
    token: 'Synthetic-WhatsApp-Provider-Token',
    resetTemplate: 'reset_test',
  });
  const token = 'a'.repeat(43),
    code = '12345678',
    salt = 'synthetic-salt';
  const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
  state.recoveryChannelTests = [
    {
      channel: 'sms',
      actorId: 'test-ceo',
      stamp: channels.stamp(state, 'sms'),
      at: Date.now(),
      expires: Date.now() - 1,
      attempts: 0,
      salt,
      hash: digest(salt + ':' + code),
    },
    {
      channel: 'whatsapp',
      actorId: 'test-ceo',
      stamp: channels.stamp(state, 'whatsapp'),
      at: Date.now(),
      expires: Date.now() - 1,
      hash: digest(token),
    },
  ];
  let result,
    input = { code };
  const ctx = {
    state,
    req: { method: 'POST' },
    res: {},
    url: { pathname: '/api/sms/recovery-test' },
    u: state.users[0],
    options: { rateChecked: true },
    body: async () => input,
    send: (_res, _status, body) => {
      result = body;
    },
    fail: (status, message) => Object.assign(Error(message), { status }),
    persist: () => {
      throw Error('Expired proof must not be persisted as valid');
    },
  };
  await channels.handle(ctx);
  assert.equal(result.ok, false);
  ctx.url.pathname = '/api/password-reset/channel-test-link';
  input = { token, confirm: true };
  await assert.rejects(channels.handle(ctx, true), { status: 400 });
  assert.equal(channels.ready(state, 'sms'), false);
  assert.equal(channels.ready(state, 'whatsapp'), false);
});

for (const records of [false, true])
  test(`channels open only after receipt proof; settings revoke proof (records=${records})`, async () => {
    const state = fixture();
    Object.assign(state.users[0], {
      mobilePhone: '905321234567',
      whatsappPhone: '905321234567',
      whatsappAllowed: true,
    });
    state.smsConfig = sms.configure(undefined, {
      enabled: true,
      username: '908501234567',
      password: 'Synthetic-SMS-Key',
      header: 'HANHUKUK',
    });
    const waInput = {
      enabled: true,
      phoneNumberId: '123456789',
      version: 'v23.0',
      language: 'tr',
      resetTemplate: 'reset_test',
      token: 'Synthetic-WhatsApp-Provider-Token',
    };
    state.whatsappConfig = wa.configure(undefined, waInput);
    const { pool, pg } = await database();
    await importState(pool, state);
    if (records) {
      await importRecords(pool);
      await activateRecords(pool);
    }
    const store = createStore(pool, { records }),
      smsCalls = [],
      waCalls = [];
    const app = await serve(
      createApplication({
        store,
        smsFetch: async (url, init) => {
          if (String(url).includes('/balance')) return new Response('100');
          if (String(url).includes('/headers')) return new Response('["HANHUKUK"]');
          smsCalls.push(JSON.parse(init.body));
          return new Response('4711');
        },
        whatsappFetch: async (_url, init) => {
          waCalls.push(JSON.parse(init.body));
          return Response.json({ messages: [{ id: 'fake-meta-message' }] });
        },
      }),
    );
    const api = async (path, input, cookie, method = 'POST') => {
      const response = await fetch(app.url + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1', ...(cookie ? { cookie } : {}) },
        ...(method === 'GET' ? {} : { body: JSON.stringify(input) }),
      });
      return {
        status: response.status,
        body: await response.json(),
        cookie: response.headers.get('set-cookie')?.split(';')[0],
      };
    };
    const channels = async () =>
      (await api('/api/password-reset/channels', undefined, undefined, 'GET')).body;
    try {
      const cookie = (await api('/api/login', { username: 'test', password })).cookie;
      assert.deepEqual(await channels(), { sms: false, whatsapp: false });
      assert.equal((await api('/api/users', undefined, undefined, 'GET')).status, 401);
      assert.equal((await api('/api/sms/recovery-test', { phone: '05321234567' })).status, 401);
      assert.equal(
        (await api('/api/password-reset/request', { account: 'test', channel: 'sms' })).status,
        503,
      );
      await api('/api/sms/test', {}, cookie);
      assert.deepEqual(
        await channels(),
        { sms: false, whatsapp: false },
        'connection tests do not prove receipt',
      );
      const sent = await api('/api/sms/recovery-test', { phone: '05321234567' }, cookie);
      assert.equal(sent.body.sms.sent, true);
      assert.deepEqual(
        await channels(),
        { sms: false, whatsapp: false },
        'provider acceptance does not prove receipt',
      );
      const testCode = smsCalls.at(-1).messages[0].msg.match(/\d{8}/)[0];
      const wrong = testCode === '00000000' ? '11111111' : '00000000';
      for (let i = 0; i < 5; i++)
        assert.equal((await api('/api/sms/recovery-test', { code: wrong }, cookie)).body.ok, false);
      assert.equal((await api('/api/sms/recovery-test', { code: testCode }, cookie)).body.ok, false);
      await api('/api/sms/recovery-test', { phone: '05321234567' }, cookie);
      const validCode = smsCalls.at(-1).messages[0].msg.match(/\d{8}/)[0];
      assert.ok(!JSON.stringify(await store.readState()).includes(validCode));
      assert.equal((await api('/api/sms/recovery-test', { code: validCode }, cookie)).body.ready, true);
      assert.deepEqual(await channels(), { sms: true, whatsapp: false });
      assert.equal(
        (await api('/api/password-reset/request', { account: 'test', channel: 'sms' })).body.channel,
        'sms',
      );
      assert.equal(waCalls.length, 0, 'explicit SMS selection does not switch to configured WhatsApp');
      const waSent = await api('/api/whatsapp/recovery-test', { phone: '05321234567' }, cookie);
      assert.equal(waSent.body.whatsapp.accepted, 1);
      const token = waCalls.at(-1).template.components.find((c) => c.type === 'button').parameters[0].text;
      assert.equal(token.length, 43);
      assert.ok(!JSON.stringify(await store.readState()).includes(token));
      assert.deepEqual(await channels(), { sms: true, whatsapp: false });
      assert.equal((await api('/api/password-reset/channel-test-link', { token })).body.usable, true);
      assert.equal(
        (await api('/api/password-reset/complete', { token, password: 'Synthetic-New-Password' })).status,
        400,
        'test link cannot change account passwords',
      );
      assert.equal(
        (await api('/api/password-reset/channel-test-link', { token, confirm: true })).body.ok,
        true,
      );
      assert.deepEqual(await channels(), { sms: true, whatsapp: true });
      assert.equal(
        (await api('/api/password-reset/channel-test-link', { token, confirm: true })).status,
        400,
        'proof token is single-use',
      );
      assert.equal(
        (await store.readState()).users[0].hash,
        state.users[0].hash,
        'live checks never change the password',
      );
      await api(
        '/api/whatsapp/config',
        { ...waInput, token: '', messageTemplate: 'unrelated_notice' },
        cookie,
        'PUT',
      );
      assert.deepEqual(
        await channels(),
        { sms: true, whatsapp: true },
        'unrelated template changes keep recovery proof',
      );
      await api(
        '/api/whatsapp/config',
        { ...waInput, token: '', resetTemplate: 'different_reset' },
        cookie,
        'PUT',
      );
      assert.deepEqual(await channels(), { sms: true, whatsapp: false });
      await api('/api/whatsapp/config', { ...waInput, token: '' }, cookie, 'PUT');
      assert.equal(
        (await api('/api/password-reset/channel-test-link', { token, confirm: true })).status,
        400,
      );
      assert.deepEqual(
        await channels(),
        { sms: true, whatsapp: false },
        'restoring old settings does not restore revoked proof',
      );
      await api('/api/sms/config', { enabled: true, header: 'NEWHEADER' }, cookie, 'PUT');
      assert.deepEqual(await channels(), { sms: false, whatsapp: false });
      assert.equal(
        (await api('/api/password-reset/request', { account: 'test', channel: 'sms' })).status,
        503,
      );
    } finally {
      await app.close();
      await pg.close();
    }
  });
