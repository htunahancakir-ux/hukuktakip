const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { password, fixture, database, serve } = require('./support/postgres.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');

for (const records of [false, true])
  test(`email recovery requires self-enrollment; bounded single-use codes revoke sessions (records=${records})`, async () => {
    const state = fixture();
    state.users[0].email = 'owner@example.test';
    const { pg, pool } = await database();
    await importState(pool, state);
    if (records) {
      await importRecords(pool);
      await activateRecords(pool);
    }
    const store = createStore(pool, { records });
    const sent = [],
      pending = [];
    const app = await serve(
      createApplication({
        store,
        recoveryEmail: { send: async (job) => sent.push(job) },
        background: (p) => pending.push(p),
      }),
    );
    const request = async (path, body, cookie, method = 'POST') => {
      const response = await fetch(app.url + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1', ...(cookie && { cookie }) },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: await response.json(),
        cookie: response.headers.get('set-cookie')?.split(';')[0],
      };
    };
    const settle = async () => {
      await Promise.all(pending.splice(0));
    };
    const code = () => sent.at(-1).text.match(/\d{8}/)[0];
    try {
      const login = await request('/api/login', { username: 'test', password });
      assert.equal(login.status, 200);
      const cookie = login.cookie;
      const readiness = await request('/api/account/recovery-email', undefined, cookie, 'GET');
      assert.equal(readiness.status, 200);
      assert.equal(
        readiness.body.available,
        true,
        'Hesabım must show enrollment when the SMTP sender is configured',
      );
      assert.equal(readiness.body.verified, false);
      const unknown = await request('/api/password-reset/email-request', { account: 'missing' });
      const unverified = await request('/api/password-reset/email-request', { account: 'test' });
      assert.deepEqual(unknown.body, unverified.body);
      assert.equal(sent.length, 0);
      assert.equal((await request('/api/account/recovery-email', { password })).status, 401);
      assert.equal((await request('/api/account/recovery-email', { password: 'wrong' }, cookie)).status, 403);
      assert.equal((await request('/api/account/recovery-email', { password }, cookie)).status, 200);
      await settle();
      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, 'owner@example.test');
      const enrollment = code();
      const snapshot = await store.readState();
      assert.ok(snapshot.emailRecovery.length);
      assert.ok(!JSON.stringify(snapshot).includes(enrollment));
      assert.equal(
        (await request('/api/account/recovery-email', { code: enrollment }, cookie)).body.verified,
        true,
      );
      assert.equal(
        (await request('/api/account/recovery-email', { code: enrollment }, cookie)).body.ok,
        false,
      );
      await request('/api/password-reset/email-request', { account: 'owner@example.test' });
      await settle();
      const reset = code();
      const wrong = reset === '00000000' ? '11111111' : '00000000';
      const nextPassword = 'Email-Recovery-New-Password-Only-Test';
      for (let i = 0; i < 5; i++)
        assert.equal(
          (
            await request('/api/password-reset/email-complete', {
              account: 'test',
              code: wrong,
              password: nextPassword,
            })
          ).body.ok,
          false,
        );
      assert.equal(
        (
          await request('/api/password-reset/email-complete', {
            account: 'test',
            code: reset,
            password: nextPassword,
          })
        ).body.ok,
        false,
      );
      await request('/api/password-reset/email-request', { account: 'test' });
      await settle();
      const expired = code();
      await store.transaction(({ state, saveState }) => {
        for (const row of state.emailRecovery) if (row.kind === 'reset') row.expires = 1;
        saveState(state);
      });
      assert.equal(
        (
          await request('/api/password-reset/email-complete', {
            account: 'test',
            code: expired,
            password: nextPassword,
          })
        ).body.ok,
        false,
      );
      await request('/api/password-reset/email-request', { account: 'test' });
      await settle();
      const active = code();
      const sentCount = sent.length;
      await request('/api/password-reset/email-request', { account: 'test' });
      await settle();
      assert.equal(sent.length, sentCount, 'three reset codes per day is the limit');
      const result = await request('/api/password-reset/email-complete', {
        account: 'test',
        code: active,
        password: nextPassword,
      });
      assert.equal(result.body.ok, true);
      assert.equal(
        (
          await request('/api/password-reset/email-complete', {
            account: 'test',
            code: active,
            password: nextPassword,
          })
        ).body.ok,
        false,
      );
      assert.equal((await request('/api/session', undefined, cookie, 'GET')).body.user, null);
      const relogin = await request('/api/login', { username: 'test', password: nextPassword });
      assert.equal(relogin.status, 200);
      // Editing the profile does not redirect recovery to a replacement address.
      await request(
        '/api/account/contact',
        { email: 'replacement@example.test', mobilePhone: '' },
        relogin.cookie,
        'PUT',
      );
      const before = sent.length;
      await request('/api/password-reset/email-request', { account: 'test' });
      await settle();
      assert.equal(sent.length, before);
      assert.equal(
        (await request('/api/account/recovery-email', undefined, relogin.cookie, 'GET')).body.verified,
        false,
      );
    } finally {
      await app.close();
      await pg.close();
    }
  });

test('recipient validation rejects multiple addresses and header injection; changed contact disables recovery', () => {
  const { addressFor, email } = require('../lib/recovery-email.cjs');
  assert.equal(email('a@example.test,attacker@example.test'), '');
  assert.equal(email('a@example.test\r\nBcc: victim@example.test'), '');
  assert.equal(addressFor({ data: {} }, { email: 'a@example.test', recoveryEmail: 'b@example.test' }), '');
});
