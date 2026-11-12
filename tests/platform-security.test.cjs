const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { database, serve } = require('./support/postgres.cjs');
const { createPlatformAdmin } = require('../lib/saas/platform-auth.cjs');
const { createPlatformHandler } = require('../lib/platform-app.cjs');
const totp = require('../lib/saas/totp.cjs');

const password = 'Synthetic-Platform-Security-Test!';
process.env.PLATFORM_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

test('TOTP matches the RFC 6238 SHA-1 test vectors and rejects reuse of a window', () => {
  const secret = totp.base32(Buffer.from('12345678901234567890'));
  // RFC 6238 appendix B, SHA-1 (8-digit codes truncated to the last 6 digits).
  for (const [time, expected] of [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])
    assert.equal(totp.codeAt(secret, Math.floor(time / 30)), expected, 'T=' + time);
  const now = 1_700_000_000_000;
  const code = totp.codeAt(secret, totp.stepAt(now));
  assert.equal(totp.matchStep(secret, code, now), totp.stepAt(now));
  assert.equal(totp.matchStep(secret, totp.codeAt(secret, totp.stepAt(now) - 1), now), totp.stepAt(now) - 1, 'one step of drift');
  assert.equal(totp.matchStep(secret, totp.codeAt(secret, totp.stepAt(now) - 3), now), null, 'three steps old');
  for (const bad of ['', 'abcdef', '12345', '1234567', null]) assert.equal(totp.matchStep(secret, bad, now), null);
  assert.deepEqual(totp.fromBase32(totp.base32(Buffer.from('hello world'))), Buffer.from('hello world'));
});

test('operator two-factor sign-in, recovery codes, password change and operator management', async (t) => {
  const { pg, pool } = await database();
  const servers = [];
  try {
    const root = await createPlatformAdmin(pool, { username: 'root', name: 'Kök Operatör', password });
    const server = await serve(createPlatformHandler({ pool, secureCookies: false }));
    servers.push(server);
    const call = async (path, { method = 'GET', body, cookie } = {}) => {
      const response = await fetch(server.url + '/api/platform/' + path, {
        method,
        headers: {
          ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-Han-Request': '1' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: await response.json(), cookie: (response.headers.get('set-cookie') || '').split(';')[0] };
    };
    // The address limiter (8 per 15 minutes) is covered by the login tests; here it is reset
    // so the many sign-ins of this scenario do not trip it.
    const signIn = async (username, pass, code) => {
      await pool.query('DELETE FROM han_saas.platform_login_attempts');
      return call('login', { method: 'POST', body: { username, password: pass, ...(code === undefined ? {} : { code }) } });
    };
    let session = (await signIn('root', password)).cookie;
    let secret;
    let recovery;

    await t.test('an operator without two-factor signs in with the password alone', async () => {
      assert.equal((await call('account', { cookie: session })).json.totpEnabled, false);
    });

    await t.test('setup needs a correct code from the authenticator; nothing is enforced before that', async () => {
      const start = await call('account/totp/start', { method: 'POST', body: {}, cookie: session });
      assert.equal(start.status, 200);
      assert.match(start.json.uri, /^otpauth:\/\/totp\/Hukuk%20Takip%20Platformu:root\?secret=[A-Z2-7]+&/);
      secret = start.json.secret.replace(/ /g, '');
      const wrong = await call('account/totp/confirm', { method: 'POST', body: { code: '000000' }, cookie: session });
      assert.equal(wrong.status, 400);
      assert.equal((await signIn('root', password)).status, 200, 'still password-only until confirmed');
      const stored = (await pool.query('SELECT totp_pending_enc, totp_secret_enc FROM han_saas.platform_admins WHERE username = $1', ['root'])).rows[0];
      assert.ok(stored.totp_pending_enc && !stored.totp_pending_enc.includes(secret), 'pending secret is sealed');
      assert.equal(stored.totp_secret_enc, null);

      const confirm = await call('account/totp/confirm', {
        method: 'POST',
        body: { code: totp.codeAt(secret, totp.stepAt(Date.now())) },
        cookie: session,
      });
      assert.equal(confirm.status, 200);
      recovery = confirm.json.recoveryCodes;
      assert.equal(recovery.length, 8);
      assert.match(recovery[0], /^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
      const row = (await pool.query('SELECT recovery_hashes FROM han_saas.platform_admins WHERE username = $1', ['root'])).rows[0];
      assert.equal(row.recovery_hashes.length, 8);
      assert.ok(!JSON.stringify(row.recovery_hashes).includes(recovery[0].replace('-', '')), 'only hashes are stored');
      assert.equal((await call('account', { cookie: session })).json.recoveryCodesLeft, 8);
      assert.equal((await call('account/totp/start', { method: 'POST', body: {}, cookie: session })).status, 409, 'cannot start twice');
    });

    await t.test('sign-in now needs a valid code, never accepts a code twice, and signals when one is needed', async () => {
      const missing = await signIn('root', password);
      assert.equal(missing.status, 401);
      assert.equal(missing.json.totpRequired, true);
      assert.equal(missing.cookie, '', 'no session without the second factor');
      assert.equal((await signIn('root', password, '123456')).status, 401);
      assert.equal((await signIn('root', 'wrong-password-123', totp.codeAt(secret, totp.stepAt(Date.now())))).status, 401);

      // The confirming code's window is already consumed; the next window works once.
      const future = totp.codeAt(secret, totp.stepAt(Date.now()) + 1);
      const ok = await signIn('root', password, future);
      assert.equal(ok.status, 200);
      assert.ok(ok.cookie.startsWith('han_platform='));
      session = ok.cookie;
      const replay = await signIn('root', password, future);
      assert.equal(replay.status, 401, 'a used code cannot sign in again');
      const older = await signIn('root', password, totp.codeAt(secret, totp.stepAt(Date.now())));
      assert.equal(older.status, 401, 'an earlier window than the last accepted one is refused');
    });

    await t.test('a recovery code works exactly once', async () => {
      const first = await signIn('root', password, recovery[0].toLowerCase());
      assert.equal(first.status, 200, 'case-insensitive');
      assert.equal((await signIn('root', password, recovery[0])).status, 401, 'single use');
      assert.equal((await signIn('root', password, recovery[1].replace('-', ''))).status, 200, 'dash is optional');
      assert.equal((await call('account', { cookie: session })).json.recoveryCodesLeft, 6);
    });

    await t.test('turning it off needs the password and a code', async () => {
      const noCode = await call('account/totp/disable', { method: 'POST', body: { password }, cookie: session });
      assert.equal(noCode.status, 403);
      const wrongPassword = await call('account/totp/disable', { method: 'POST', body: { password: 'nope-nope-nope-1', code: recovery[2] }, cookie: session });
      assert.equal(wrongPassword.status, 403);
      assert.equal((await call('account', { cookie: session })).json.totpEnabled, true);
    });

    await t.test('password change checks the current password and ends other sessions', async () => {
      const other = (await signIn('root', password, recovery[3])).cookie;
      assert.equal((await call('account', { cookie: other })).status, 200);
      const tooShort = await call('account/password', { method: 'POST', body: { current: password, next: 'short' }, cookie: session });
      assert.equal(tooShort.status, 400);
      const wrongCurrent = await call('account/password', { method: 'POST', body: { current: 'wrong-wrong-wrong', next: 'Brand-New-Password-1!' }, cookie: session });
      assert.equal(wrongCurrent.status, 403);
      const changed = await call('account/password', { method: 'POST', body: { current: password, next: 'Brand-New-Password-1!' }, cookie: session });
      assert.equal(changed.status, 200);
      assert.equal((await call('account', { cookie: session })).status, 200, 'the session that changed it stays');
      assert.equal((await call('account', { cookie: other })).status, 401, 'every other session is signed out');
      assert.equal((await signIn('root', password, recovery[4])).status, 401, 'old password no longer works');
      const again = await signIn('root', 'Brand-New-Password-1!', recovery[4]);
      assert.equal(again.status, 200);
      session = again.cookie;
      const cleanup = await call('account/password', { method: 'POST', body: { current: 'Brand-New-Password-1!', next: password }, cookie: session });
      assert.equal(cleanup.status, 200);
    });

    await t.test('operators: add, deactivate, reset password and two-factor; everything is audited', async () => {
      const added = await call('operators', { method: 'POST', body: { username: 'ayse', name: 'Ayşe Operatör', password: 'Temporary-Password-12' }, cookie: session });
      assert.equal(added.status, 200);
      assert.equal((await call('operators', { method: 'POST', body: { username: 'ayse', name: 'X', password: 'Temporary-Password-12' }, cookie: session })).status, 409);
      assert.equal((await call('operators', { method: 'POST', body: { username: 'kisa', name: 'X', password: 'short' }, cookie: session })).status, 400);

      const listed = (await call('operators', { cookie: session })).json;
      assert.deepEqual(
        listed.operators.map((o) => [o.username, o.active, o.totpEnabled]),
        [['ayse', true, false], ['root', true, true]],
      );
      assert.ok(!JSON.stringify(listed).match(/hash|salt|secret/i), 'no credential material is listed');
      const ayse = listed.operators.find((o) => o.username === 'ayse').id;

      const ayseSession = (await signIn('ayse', 'Temporary-Password-12')).cookie;
      assert.equal((await call('account', { cookie: ayseSession })).status, 200);
      assert.equal((await call('operators/' + ayse + '/reset-password', { method: 'POST', body: { password: 'Second-Password-1234' }, cookie: session })).status, 200);
      assert.equal((await call('account', { cookie: ayseSession })).status, 401, 'reset ends the target sessions');
      assert.equal((await signIn('ayse', 'Temporary-Password-12')).status, 401);
      assert.equal((await signIn('ayse', 'Second-Password-1234')).status, 200);

      assert.equal((await call('operators/' + ayse + '/active', { method: 'POST', body: { active: false }, cookie: session })).status, 200);
      assert.equal((await signIn('ayse', 'Second-Password-1234')).status, 401, 'a deactivated operator cannot sign in');
      assert.equal((await call('operators/' + root.id + '/active', { method: 'POST', body: { active: false }, cookie: session })).status, 409, 'not yourself');
      assert.equal((await call('operators/' + root.id + '/reset-password', { method: 'POST', body: { password: 'Another-Password-123' }, cookie: session })).status, 409);
      assert.equal((await call('operators/' + root.id + '/reset-totp', { method: 'POST', body: {}, cookie: session })).status, 409);
      await call('operators/' + ayse + '/active', { method: 'POST', body: { active: true }, cookie: session });

      // Ayşe enrolls, loses the phone, and another operator resets her second factor.
      const ayseCookie = (await signIn('ayse', 'Second-Password-1234')).cookie;
      const start = await call('account/totp/start', { method: 'POST', body: {}, cookie: ayseCookie });
      await call('account/totp/confirm', { method: 'POST', body: { code: totp.codeAt(start.json.secret.replace(/ /g, ''), totp.stepAt(Date.now())) }, cookie: ayseCookie });
      assert.equal((await signIn('ayse', 'Second-Password-1234')).json.totpRequired, true);
      assert.equal((await call('operators/' + ayse + '/reset-totp', { method: 'POST', body: {}, cookie: session })).status, 200);
      assert.equal((await signIn('ayse', 'Second-Password-1234')).status, 200, 'back to password-only after a reset');

      const audit = (await call('operators', { cookie: session })).json.audit.map((a) => a.action);
      for (const action of ['totp.enable', 'password.change', 'operator.add', 'operator.reset_password', 'operator.disable', 'operator.enable', 'operator.reset_totp'])
        assert.ok(audit.includes(action), action);
    });

    await t.test('disabling with the right password and code clears the secret and recovery codes', async () => {
      const row = () => pool.query('SELECT totp_secret_enc, recovery_hashes FROM han_saas.platform_admins WHERE username = $1', ['root']).then((r) => r.rows[0]);
      assert.ok((await row()).totp_secret_enc);
      const done = await call('account/totp/disable', { method: 'POST', body: { password, code: recovery[5] }, cookie: session });
      assert.equal(done.status, 200);
      const after = await row();
      assert.equal(after.totp_secret_enc, null);
      assert.deepEqual(after.recovery_hashes, []);
      assert.equal((await signIn('root', password)).status, 200);
    });
  } finally {
    for (const server of servers) await server.close();
    await pg.close();
  }
});

test('by default two-step sign-in is optional until platform SMS is switched on', async () => {
  const platformSms = require('../lib/saas/platform-sms.cjs');
  const { pg, pool } = await database();
  const servers = [];
  try {
    const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Operatör', password })).id;
    const open = async () => {
      const server = await serve(createPlatformHandler({ pool, secureCookies: false }));
      servers.push(server);
      return async (path, { method = 'GET', body, cookie } = {}) => {
        const response = await fetch(server.url + '/api/platform/' + path, {
          method,
          headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-Han-Request': '1' } : {}), ...(cookie ? { cookie } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, json: await response.json(), cookie: (response.headers.get('set-cookie') || '').split(';')[0] };
      };
    };
    let call = await open();
    const cookie = (await call('login', { method: 'POST', body: { username: 'root', password } })).cookie;
    assert.equal((await call('session', { cookie })).json.totpSetupRequired, undefined);
    assert.equal((await call('dashboard', { cookie })).status, 200, 'SMS not set up: no two-step needed');
    assert.equal((await call('account', { cookie })).json.totpRequired, false);

    // Saved but switched off still does not require it.
    await platformSms.saveSettings(pool, op, { username: '908501234567', password: 'Verimor-Secret-Only-Test', enabled: false });
    call = await open();
    assert.equal((await call('dashboard', { cookie })).status, 200);

    await platformSms.saveSettings(pool, op, { enabled: true });
    call = await open(); // the SMS status is cached for 15 s per server
    assert.equal((await call('session', { cookie })).json.totpSetupRequired, true);
    const blocked = await call('dashboard', { cookie });
    assert.equal(blocked.status, 403, 'SMS on: two-step sign-in required');
    assert.equal(blocked.json.totpSetupRequired, true);
    assert.equal((await call('account', { cookie })).json.totpRequired, true);
  } finally {
    for (const server of servers) await server.close();
    await pg.close();
  }
});

test('with PLATFORM_REQUIRE_TOTP an operator can only reach the account page until two-factor is on', async () => {
  const { pg, pool } = await database();
  const servers = [];
  try {
    await createPlatformAdmin(pool, { username: 'root', name: 'Operatör', password });
    const server = await serve(createPlatformHandler({ pool, secureCookies: false, requireTotp: true }));
    servers.push(server);
    const call = async (path, { method = 'GET', body, cookie } = {}) => {
      const response = await fetch(server.url + '/api/platform/' + path, {
        method,
        headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-Han-Request': '1' } : {}), ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: await response.json(), cookie: (response.headers.get('set-cookie') || '').split(';')[0] };
    };
    const login = await call('login', { method: 'POST', body: { username: 'root', password } });
    assert.equal(login.status, 200, 'sign-in itself works so setup is possible');
    const cookie = login.cookie;
    assert.equal((await call('session', { cookie })).json.totpSetupRequired, true);
    for (const path of ['dashboard', 'offices/x', 'finance', 'operators']) {
      const blocked = await call(path, { cookie });
      assert.equal(blocked.status, 403, path);
      assert.equal(blocked.json.totpSetupRequired, true, path);
    }
    assert.equal((await call('account', { cookie })).json.totpRequired, true);
    const start = await call('account/totp/start', { method: 'POST', body: {}, cookie });
    const confirm = await call('account/totp/confirm', {
      method: 'POST',
      body: { code: totp.codeAt(start.json.secret.replace(/ /g, ''), totp.stepAt(Date.now())) },
      cookie,
    });
    assert.equal(confirm.status, 200);
    assert.equal((await call('dashboard', { cookie })).status, 200, 'unlocked once enabled');
    assert.equal(
      (await call('account/totp/disable', { method: 'POST', body: { password, code: confirm.json.recoveryCodes[0] }, cookie })).status,
      409,
      'cannot be switched off while the server requires it',
    );
  } finally {
    for (const server of servers) await server.close();
    await pg.close();
  }
});

test('without a server key, enrolling fails closed instead of storing a readable secret', async () => {
  const saved = process.env.PLATFORM_ENCRYPTION_KEY;
  const other = [process.env.AI_ENCRYPTION_KEY, process.env.BACKUP_ENCRYPTION_KEY];
  delete process.env.PLATFORM_ENCRYPTION_KEY;
  delete process.env.AI_ENCRYPTION_KEY;
  delete process.env.BACKUP_ENCRYPTION_KEY;
  const { pg, pool } = await database();
  try {
    const admin = await createPlatformAdmin(pool, { username: 'root', name: 'Operatör', password });
    const account = require('../lib/saas/platform-account.cjs');
    await assert.rejects(() => account.startTotpSetup(pool, admin.id), (error) => error.status === 412);
    const row = (await pool.query('SELECT totp_pending_enc FROM han_saas.platform_admins')).rows[0];
    assert.equal(row.totp_pending_enc, null);
  } finally {
    process.env.PLATFORM_ENCRYPTION_KEY = saved;
    if (other[0]) process.env.AI_ENCRYPTION_KEY = other[0];
    if (other[1]) process.env.BACKUP_ENCRYPTION_KEY = other[1];
    await pg.close();
  }
});
