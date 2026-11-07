const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { CookieJar, JSDOM } = require('jsdom');
const { sessionCookie, sessionKey, sessionIsValid } = require('../lib/session-policy.cjs');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { database, fixture, serve, password } = require('./support/postgres.cjs');

test('session cookie is hidden from scripts, restricted to HTTPS and host, and expires on logout', () => {
  const token = crypto.randomBytes(32).toString('hex'),
    jar = new CookieJar();
  const url = 'https://app.example.test/';
  const serialized = sessionCookie(token, { secure: true });
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/'])
    assert.ok(serialized.includes(flag));
  assert.doesNotMatch(serialized, /Domain=|Max-Age=/);
  jar.setCookieSync(serialized, url);
  const dom = new JSDOM('', { url, cookieJar: jar });
  try {
    assert.equal(dom.window.document.cookie, '');
    assert.equal(jar.getCookieStringSync(url), 'han_session=' + token);
    assert.equal(jar.getCookieStringSync('http://app.example.test/'), '');
    assert.equal(jar.getCookieStringSync('https://other.app.example.test/'), '');
    assert.equal(jar.getCookiesSync(url)[0].sameSite, 'strict');
    jar.setCookieSync(sessionCookie('', { secure: true, maxAge: 0 }), url);
    assert.equal(jar.getCookieStringSync(url), '');
  } finally {
    dom.window.close();
  }
});

test('session parser rejects malformed and duplicate cookies; server expiry is enforced', () => {
  const token = 'a'.repeat(64),
    expected = crypto.createHash('sha256').update(token).digest('hex');
  const key = (cookie) => sessionKey({ headers: { cookie } });
  assert.equal(key('other=1; han_session=' + token), expected);
  assert.equal(key('han_session=' + token + '; han_session=' + 'b'.repeat(64)), '');
  assert.equal(key('han_session=bad-token'), '');
  assert.equal(key('han_session=' + token + '%0a'), '');
  assert.equal(sessionIsValid({ deviceType: 'desktop', until: 99 }, 100), false);
  assert.equal(sessionIsValid({ deviceType: 'desktop', until: 101 }, 100), true);
});

test('production CSRF checks reject foreign or unproven mutations before accessing the database', async () => {
  let databaseCalls = 0;
  const unexpected = async () => {
    databaseCalls++;
    throw Error('Must not access database');
  };
  const app = await serve(
    createApplication({
      cloud: true,
      appOrigin: 'https://app.example.test',
      store: {
        transaction: unexpected,
        security: { readIdentity: unexpected, consumeAttempt: unexpected, transaction: unexpected },
      },
    }),
  );
  try {
    const base = { 'X-Han-Request': '1', 'Content-Type': 'application/json' };
    const badHeaders = [
      base,
      { ...base, Origin: 'null' },
      { ...base, Origin: 'https://attacker.test' },
      { ...base, Origin: 'https://app.example.test.attacker.test' },
      { ...base, Origin: 'https://sibling.example.test', 'Sec-Fetch-Site': 'same-site' },
      { ...base, Origin: 'https://app.example.test', 'Sec-Fetch-Site': 'cross-site' },
      { ...base, Referer: 'https://attacker.test/page' },
      {
        ...base,
        'X-Forwarded-Host': 'attacker.test',
        'X-Forwarded-Proto': 'https',
        Origin: 'https://attacker.test',
      },
      { Origin: 'https://app.example.test', 'Content-Type': 'application/x-www-form-urlencoded' },
    ];
    for (const route of [
      '/api/login',
      '/api/logout',
      '/api/data?key=icrapro-v1',
      '/api/presence',
      '/api/backups/run',
    ]) {
      for (const headers of badHeaders) {
        const response = await fetch(app.url + route, { method: 'POST', headers, body: '{}' });
        assert.equal(response.status, 403, route + ': ' + JSON.stringify(headers));
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(response.headers.get('access-control-allow-origin'), null);
      }
    }
    assert.equal(databaseCalls, 0);
    // Machine-only endpoints never fall back to session-cookie authentication.
    assert.equal((await fetch(app.url + '/api/backups/cron')).status, 401);
    assert.equal((await fetch(app.url + '/api/scheduled-reminders/cron', { method: 'POST' })).status, 401);
  } finally {
    await app.close();
  }
});

test('same-origin sign-in, password rotation and logout retain secure cookie flags and revoke old sessions', async () => {
  const { pg, pool } = await database();
  const state = fixture();
  await importState(pool, state);
  const origin = 'https://app.example.test';
  const app = await serve(createApplication({ cloud: true, appOrigin: origin, store: createStore(pool) }));
  try {
    const post = (route, body, extra = {}) =>
      fetch(app.url + route, {
        method: 'POST',
        headers: { Origin: origin, 'X-Han-Request': '1', 'Content-Type': 'application/json', ...extra },
        body: JSON.stringify(body),
      });
    const login = await post('/api/login', { username: 'test', password, remember: true });
    assert.equal(login.status, 200);
    const first = login.headers.get('set-cookie');
    assert.match(first, /HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=1209600/);
    assert.match(login.headers.get('strict-transport-security'), /max-age=/);
    const cookie = first.split(';')[0];
    const stored = (await pool.query('SELECT token_hash FROM han_private.han_sessions')).rows[0];
    assert.equal(stored.token_hash, sessionKey({ headers: { cookie } }));
    assert.notEqual(stored.token_hash, cookie.slice(12));
    // Origin may be omitted only with same-origin Referer or Fetch Metadata.
    for (const proof of [{ Referer: origin + '/dashboard' }, { 'Sec-Fetch-Site': 'same-origin' }]) {
      const presence = await fetch(app.url + '/api/presence', {
        method: 'POST',
        headers: { 'X-Han-Request': '1', cookie, ...proof },
      });
      assert.equal(presence.status, 200);
    }
    const changed = await post(
      '/api/account/password',
      { currentPassword: password, password: 'Synthetic-New-Password-Only' },
      { cookie },
    );
    assert.equal(changed.status, 200);
    const next = changed.headers.get('set-cookie');
    assert.match(next, /HttpOnly; Secure; SameSite=Strict; Path=\//);
    assert.doesNotMatch(next, /Max-Age=/);
    assert.notEqual(next.split(';')[0], cookie);
    const oldSession = await (await fetch(app.url + '/api/session', { headers: { cookie } })).json();
    assert.equal(oldSession.user, null);
    const signedOut = await post('/api/logout', {}, { cookie: next.split(';')[0] });
    assert.equal(signedOut.status, 200);
    assert.match(
      signedOut.headers.get('set-cookie'),
      /HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=0/,
    );
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM han_private.han_sessions')).rows[0].n, 0);
    const after = (await pool.query('SELECT payload FROM han_private.han_state WHERE id=1')).rows[0].payload;
    assert.deepEqual(after.data, state.data);
  } finally {
    await app.close();
    await pg.close();
  }
});
