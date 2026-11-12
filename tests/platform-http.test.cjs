const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { database, serve } = require('./support/postgres.cjs');
const { createPlatformAdmin } = require('../lib/saas/platform-auth.cjs');
const { createPlatformHandler } = require('../lib/platform-app.cjs');
const { createTenantRouter } = require('../lib/saas/tenant-router.cjs');
const platform = require('../lib/saas/platform.cjs');

const password = 'Synthetic-Platform-Http-Test!';
const BASE = 'han.example.com';

test('platform console HTTP: authentication, request origin and routing', async (t) => {
  const { pg, pool } = await database();
  const servers = [];
  try {
    const admin = await createPlatformAdmin(pool, { username: 'root', name: 'Operatör', password });
    const server = await serve(createPlatformHandler({ pool, secureCookies: false }));
    servers.push(server);
    const call = async (path, { method = 'GET', body, cookie, headers = {} } = {}) => {
      const response = await fetch(server.url + '/api/platform/' + path, {
        method,
        headers: {
          ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-Han-Request': '1' } : {}),
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: await response.json(), setCookie: response.headers.get('set-cookie') };
    };
    const signIn = async (user = 'root', pass = password) => {
      const result = await call('login', { method: 'POST', body: { username: user, password: pass } });
      return { ...result, cookie: (result.setCookie || '').split(';')[0] };
    };
    await platform.upsertModule(pool, { code: 'voip', name: 'Çağrı', monthlyPriceKurus: 5000, active: true });
    let cookie;

    await t.test('every console route requires a platform session', async () => {
      for (const path of ['dashboard', 'modules', 'offices/' + '0'.repeat(8) + '-0000-4000-8000-' + '0'.repeat(12)])
        assert.equal((await call(path)).status, 401, path);
      assert.equal((await call('offices', { method: 'POST', body: {} })).status, 401);
      assert.deepEqual((await call('session')).json, { admin: null });
    });

    await t.test('login failures are uniform and a session cookie is host-only and HttpOnly', async () => {
      const wrongPassword = await signIn('root', 'wrong-password-123');
      const unknownUser = await signIn('nobody', 'wrong-password-123');
      assert.deepEqual([wrongPassword.status, unknownUser.status], [401, 401]);
      assert.equal(wrongPassword.json.error, unknownUser.json.error);
      const ok = await signIn();
      assert.equal(ok.status, 200);
      assert.match(ok.setCookie, /^han_platform=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800$/);
      assert.ok(!/Domain=/i.test(ok.setCookie));
      cookie = ok.cookie;
      assert.equal((await call('session', { cookie })).json.admin.username, 'root');
    });

    await t.test('mutations need the request header and a same-origin request', async () => {
      const body = { code: 'ai-assistant', name: 'AI', monthlyPriceKurus: 100, active: false };
      const plain = await fetch(server.url + '/api/platform/modules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify(body),
      });
      assert.equal(plain.status, 403);
      const foreign = await call('modules', { method: 'POST', body, cookie, headers: { Origin: 'https://evil.example' } });
      assert.equal(foreign.status, 403);
      assert.equal((await call('modules', { method: 'POST', body, cookie })).status, 200);
      assert.equal((await call('dashboard', { method: 'PUT', cookie })).status, 405);
    });

    let tenantId;
    await t.test('a sale over HTTP is attributed to the session operator, not to the request body', async () => {
      const sale = await call('offices', {
        method: 'POST',
        cookie,
        body: {
          slug: 'office-one', name: 'Birinci Büro', userCount: 3, userPriceKurus: 10000, termMonths: 1,
          moduleCodes: ['voip'], paid: true, admin: { name: 'Ada', username: 'ada', password },
          createdBy: '11111111-1111-4111-8111-111111111111', adminId: 'forged',
        },
      });
      assert.equal(sale.status, 200, JSON.stringify(sale.json));
      assert.equal(sale.json.payableKurus, 3 * 10000 + 5000);
      tenantId = sale.json.office.id;
      const creators = (await pool.query('SELECT DISTINCT created_by FROM han_saas.sales WHERE tenant_id = $1', [tenantId])).rows;
      assert.deepEqual(creators, [{ created_by: admin.id }]);
      assert.equal((await call('dashboard', { cookie })).json.revenue.paidKurus, 35000);
    });

    await t.test('the path decides the office, and bad input is a 4xx with a message', async () => {
      const other = '22222222-2222-4222-8222-222222222222';
      const users = await call(`offices/${tenantId}/users`, { method: 'POST', cookie, body: { tenantId: other, userCount: 4, chargeKurus: 0 } });
      assert.equal(users.status, 200);
      assert.equal((await call(`offices/${tenantId}`, { cookie })).json.office.userLimit, 4);
      assert.equal((await call(`offices/${other}`, { cookie })).status, 404);
      assert.equal((await call('offices/not-a-uuid', { cookie })).status, 404);
      const bad = await call(`offices/${tenantId}/renew`, { method: 'POST', cookie, body: { termMonths: 0 } });
      assert.equal(bad.status, 400);
      assert.ok(typeof bad.json.error === 'string' && !/at |\.cjs/.test(bad.json.error));
      const status = await call(`offices/${tenantId}/status`, { method: 'POST', cookie, body: { status: 'suspended', reason: 'Test' } });
      assert.equal(status.status, 200);
      assert.equal((await call('nope', { cookie })).status, 404);
      const huge = await fetch(server.url + '/api/platform/modules', {
        method: 'POST', headers: { cookie, 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pad: 'x'.repeat(70_000) }),
      });
      assert.equal(huge.status, 413);
    });

    await t.test('logout, expiry and deactivated operators end access', async () => {
      const second = await signIn();
      assert.equal((await call('dashboard', { cookie: second.cookie })).status, 200);
      await call('logout', { method: 'POST', cookie: second.cookie });
      assert.equal((await call('dashboard', { cookie: second.cookie })).status, 401);
      const third = await signIn();
      await pool.query('UPDATE han_saas.platform_sessions SET expires_at = $1', [Date.now() - 1]);
      assert.equal((await call('dashboard', { cookie: third.cookie })).status, 401);
      const fourth = await signIn();
      await pool.query('UPDATE han_saas.platform_admins SET active = false');
      assert.equal((await call('dashboard', { cookie: fourth.cookie })).status, 401);
      assert.equal((await signIn()).status, 401);
      await pool.query('UPDATE han_saas.platform_admins SET active = true');
      await assert.rejects(createPlatformAdmin(pool, { username: 'ROOT', name: 'Kopya', password }), (e) => e.status === 409);
      await assert.rejects(
        createPlatformAdmin(pool, { username: 'short', name: 'K', password: 'elevenchars' }),
        (e) => e.status === 400,
      );
    });

    await t.test('repeated failures are rate limited, even with the right password', async () => {
      let limited = 0;
      for (let i = 0; i < 12 && !limited; i++) {
        const result = await signIn('root', 'wrong-password-123');
        if (result.status === 429) limited = i + 1;
      }
      assert.ok(limited > 0 && limited <= 9, 'locked out after at most 8 attempts');
      assert.equal((await signIn()).status, 429);
    });

    await t.test('only the admin host reaches the console; office hosts never do', async () => {
      await pool.query('DELETE FROM han_saas.platform_login_attempts');
      const platformHandler = createPlatformHandler({ pool, appOrigin: 'https://admin.' + BASE, secureCookies: true });
      await pool.query("UPDATE han_saas.tenants SET status = 'enabled' WHERE slug = 'office-one'");
      await pool.query("UPDATE han_saas.subscriptions SET access_until = CURRENT_TIMESTAMP + interval '30 days'");
      const router = createTenantRouter({
        pool,
        baseDomain: BASE,
        cacheMs: 0,
        createPlatformHandler: () => platformHandler,
        createHandler: () => async (_req, res) => res.end('office-app'),
      });
      const front = await serve(router);
      servers.push(front);
      const request = (host, path) =>
        new Promise((resolve, reject) => {
          const url = new URL(front.url + path);
          http
            .get({ hostname: url.hostname, port: url.port, path, headers: { host } }, (response) => {
              let body = '';
              response.on('data', (chunk) => (body += chunk));
              response.on('end', () => resolve({ status: response.statusCode, body }));
            })
            .on('error', reject);
        });
      assert.deepEqual(JSON.parse((await request('admin.' + BASE, '/api/platform/session')).body), { admin: null });
      assert.equal((await request('admin.' + BASE, '/api/platform/dashboard')).status, 401);
      assert.equal((await request('office-one.' + BASE, '/api/platform/dashboard')).body, 'office-app');
      assert.equal((await request(BASE, '/api/platform/dashboard')).body, 'office-app');
      assert.equal((await request('evil.com', '/api/platform/session')).status, 404);
      assert.equal((await request('admin.evil.com', '/api/platform/session')).status, 404);
      const bare = createTenantRouter({ pool, baseDomain: BASE, createHandler: () => async () => {} });
      const noPlatform = await serve(bare);
      servers.push(noPlatform);
      const url = new URL(noPlatform.url);
      const status = await new Promise((resolve) =>
        http.get({ hostname: url.hostname, port: url.port, path: '/', headers: { host: 'admin.' + BASE } }, (r) => resolve(r.statusCode)),
      );
      assert.equal(status, 404);
    });
  } finally {
    for (const server of servers) await server.close();
    await pg.close();
  }
});
