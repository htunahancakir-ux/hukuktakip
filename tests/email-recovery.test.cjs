const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { password, fixture, database, serve } = require('./support/postgres.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');

// E-mail recovery on an installation whose only sender is the server's own SMTP account
// (lib/recovery-email.cjs), with the office state kept as one document and as record tables.
for (const records of [false, true])
  test(`email recovery needs an address verified with the password; bounded single-use codes revoke sessions (records=${records})`, async () => {
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
    const reset = (account) => request('/api/password-reset/request', { account }).then(settle);
    const complete = (code, newPassword) =>
      request('/api/password-reset/email-complete', { account: 'test', code, password: newPassword });
    const code = (digits) => sent.at(-1).text.match(new RegExp(`\\b\\d{${digits}}\\b`))[0];
    try {
      const login = await request('/api/login', { username: 'test', password });
      assert.equal(login.status, 200);
      const cookie = login.cookie;
      const profile = await request('/api/account/contact', undefined, cookie, 'GET');
      assert.equal(profile.status, 200);
      assert.deepEqual(
        [profile.body.emailVerification, profile.body.emailVerified],
        [true, false],
        'Hesabım offers verification when the SMTP sender is configured',
      );
      assert.deepEqual(
        (await request('/api/password-reset/channels', undefined, undefined, 'GET')).body.channels,
        ['email'],
        'the sign-in screen reads the open ways without a session',
      );
      const unknown = await request('/api/password-reset/request', { account: 'missing' });
      const unverified = await request('/api/password-reset/request', { account: 'test' });
      await settle();
      assert.deepEqual(unknown.body, unverified.body);
      assert.equal(sent.length, 0, 'an address nobody verified receives nothing');

      assert.equal((await request('/api/email-verification/send', {})).status, 401);
      assert.equal((await request('/api/email-verification/send', {}, cookie)).status, 200);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, 'owner@example.test');
      assert.equal(sent[0].fromName, 'Han Hukuk', 'the office’s own name is the sender name');
      const enrollment = code(6);
      const snapshot = await store.readState();
      assert.ok(snapshot.emailRecovery.length);
      assert.ok(!JSON.stringify(snapshot).includes(enrollment));
      const confirm = (input) => request('/api/email-verification/confirm', input, cookie);
      assert.equal((await confirm({ code: enrollment })).status, 403, 'the current password is asked');
      assert.equal((await confirm({ code: enrollment, password: 'wrong' })).status, 403);
      assert.equal((await confirm({ code: enrollment, password })).body.emailVerified, true);
      assert.equal((await confirm({ code: enrollment, password })).body.ok, false, 'a code works once');

      await reset('owner@example.test');
      const first = code(8);
      const wrong = first === '00000000' ? '11111111' : '00000000';
      const nextPassword = 'Email-Recovery-New-Password-Only-Test';
      for (let i = 0; i < 5; i++) assert.equal((await complete(wrong, nextPassword)).body.ok, false);
      assert.equal((await complete(first, nextPassword)).body.ok, false, 'five wrong tries kill the code');

      await reset('test');
      const expired = code(8);
      await store.transaction(({ state, saveState }) => {
        for (const row of state.emailRecovery) if (row.kind === 'reset') row.expires = 1;
        saveState(state);
      });
      assert.equal((await complete(expired, nextPassword)).body.ok, false);

      await reset('test');
      const active = code(8);
      const sentCount = sent.length;
      await reset('test');
      assert.equal(sent.length, sentCount, 'three reset codes per day is the limit');
      assert.equal((await complete(active, nextPassword)).body.ok, true);
      assert.equal((await complete(active, nextPassword)).body.ok, false);
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
      await reset('test');
      assert.equal(sent.length, before);
      assert.equal(
        (await request('/api/account/contact', undefined, relogin.cookie, 'GET')).body.emailVerified,
        false,
      );
    } finally {
      await app.close();
      await pg.close();
    }
  });

test('recipient validation rejects multiple addresses and header injection; a changed contact is not verified', () => {
  const { emailAddress, cleanName } = require('../lib/brevo-email.cjs');
  const { isVerified } = require('../lib/email-recovery.cjs');
  assert.equal(emailAddress('a@example.test,attacker@example.test'), '');
  assert.equal(emailAddress('a@example.test\r\nBcc: victim@example.test'), '');
  assert.equal(cleanName('Büro\r\nBcc: victim@example.test'), 'Büro Bcc: victim@example.test');
  const user = (extra) => ({ id: 'u', email: 'a@example.test', ...extra });
  assert.equal(isVerified({ data: {} }, user({ emailVerified: { address: 'a@example.test' } })), true);
  assert.equal(isVerified({ data: {} }, user({ emailVerified: { address: 'b@example.test' } })), false);
  // The marker of the first e-mail recovery release still counts, for the same address only.
  assert.equal(isVerified({ data: {} }, user({ recoveryEmail: 'a@example.test' })), true);
  assert.equal(isVerified({ data: {} }, user({ recoveryEmail: 'b@example.test' })), false);
});

test('the SMTP sender exists only with both credentials and a valid sender address', () => {
  const { fromEnv } = require('../lib/recovery-email.cjs');
  assert.equal(fromEnv({}), null);
  assert.equal(fromEnv({ BREVO_SMTP_LOGIN: 'login@example.test' }), null);
  assert.throws(
    () => fromEnv({ BREVO_SMTP_LOGIN: 'login@example.test', BREVO_SMTP_KEY: 'k', BREVO_FROM_EMAIL: 'not-an-address' }),
    /BREVO_FROM_EMAIL/,
  );
  const sender = fromEnv({
    BREVO_SMTP_LOGIN: 'login@example.test',
    BREVO_SMTP_KEY: 'synthetic-key',
    BREVO_FROM_EMAIL: 'noreply@example.test',
  });
  assert.equal(typeof sender.send, 'function');
});
