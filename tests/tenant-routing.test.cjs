const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database } = require('./support/postgres.cjs');
const { createTenant } = require('../lib/saas/tenants.cjs');
const { createTenantResolver, parseHost } = require('../lib/saas/tenant-resolver.cjs');
const { createTenantRouter } = require('../lib/saas/tenant-router.cjs');
const { LEGACY_TENANT_ID } = require('../lib/saas/tenant-pool.cjs');

const BASE = 'han.example.com';
const req = (host, extra = {}) => ({ headers: { host, ...extra } });
const status = (code) => (error) => error.status === code;

test('host parsing accepts only the bare domain or one valid label', () => {
  assert.deepEqual(parseHost(req(BASE), BASE), { legacy: true });
  assert.deepEqual(parseHost(req('WWW.' + BASE), BASE), { legacy: true });
  assert.deepEqual(parseHost(req('admin.' + BASE), BASE), { platform: true });
  assert.deepEqual(parseHost(req('Office-One.HAN.example.com:443'), BASE), { slug: 'office-one' });
  for (const host of [
    'evil.com',
    'han.example.com.evil.com',
    'a.b.han.example.com',
    '-x.han.example.com',
    '.han.example.com',
    'xhan.example.com',
    '',
  ])
    assert.throws(() => parseHost(req(host), BASE), status(404), host);
  assert.throws(() => parseHost({ headers: {} }, BASE), status(404));
});

test('without a base domain the deployment stays on the existing office', async () => {
  const resolver = createTenantResolver(null, { baseDomain: '' });
  assert.equal((await resolver.resolve(req('anything.example.org'))).tenantId, LEGACY_TENANT_ID);
  assert.throws(() => createTenantResolver(null, { baseDomain: 'not a domain' }), /valid domain/);
  assert.throws(() => createTenantResolver(null, { baseDomain: BASE }), /DATABASE_URL/);
});

test('subdomains resolve to enabled, subscribed offices only', async (t) => {
  const { pg, pool } = await database();
  try {
    const one = await createTenant(pool, { slug: 'office-one', name: 'Birinci Büro', ownerUserId: 'alice' });
    const two = await createTenant(pool, { slug: 'office-two', name: 'İkinci Büro', ownerUserId: 'bob' });
    const resolver = () => createTenantResolver(pool, { baseDomain: BASE, cacheMs: 0 });
    const resolve = (host, extra) => resolver().resolve(req(host, extra));

    await t.test('provisioning offices are not reachable', async () => {
      await assert.rejects(resolve('office-one.' + BASE), status(403));
    });
    await pool.query("UPDATE han_saas.tenants SET status = 'enabled'");

    await t.test('each subdomain maps to its own office', async () => {
      assert.equal((await resolve('office-one.' + BASE)).tenantId, one.id);
      assert.equal((await resolve('office-two.' + BASE)).tenantId, two.id);
      assert.equal((await resolve(BASE)).tenantId, LEGACY_TENANT_ID);
    });

    await t.test('the legacy office is not reachable through a subdomain', async () => {
      await assert.rejects(resolve('existing-office.' + BASE), status(403));
    });

    await t.test('client-supplied headers cannot select an office', async () => {
      const result = await resolve('office-one.' + BASE, {
        'x-forwarded-host': 'office-two.' + BASE,
        'x-tenant-id': two.id,
      });
      assert.equal(result.tenantId, one.id);
      await assert.rejects(resolve('unknown.' + BASE), status(403));
      await assert.rejects(resolve("x'--." + BASE), status(404));
    });

    await t.test('suspension, lapsed billing and expiry deny access', async () => {
      await pool.query("UPDATE han_saas.tenants SET status = 'suspended' WHERE id = $1", [one.id]);
      await assert.rejects(resolve('office-one.' + BASE), status(403));
      await pool.query("UPDATE han_saas.tenants SET status = 'enabled' WHERE id = $1", [one.id]);
      await pool.query("UPDATE han_saas.subscriptions SET status = 'past_due' WHERE tenant_id = $1", [one.id]);
      await assert.rejects(resolve('office-one.' + BASE), status(403));
      await pool.query(
        `UPDATE han_saas.subscriptions SET status = 'trialing',
         access_until = CURRENT_TIMESTAMP - interval '1 second' WHERE tenant_id = $1`,
        [one.id],
      );
      await assert.rejects(resolve('office-one.' + BASE), status(403));
      assert.equal((await resolve('office-two.' + BASE)).tenantId, two.id);
    });

    await t.test('the short cache bounds lookups but still expires', async () => {
      let queries = 0;
      const counting = { query: (...args) => (queries++, pool.query(...args)) };
      const cached = createTenantResolver(counting, { baseDomain: BASE, cacheMs: 60000 });
      await cached.resolve(req('office-two.' + BASE));
      await cached.resolve(req('office-two.' + BASE));
      assert.equal(queries, 1);
      await pool.query("UPDATE han_saas.tenants SET status = 'suspended' WHERE id = $1", [two.id]);
      const fresh = createTenantResolver(counting, { baseDomain: BASE, cacheMs: 0 });
      await assert.rejects(fresh.resolve(req('office-two.' + BASE)), status(403));
    });
  } finally {
    await pg.close();
  }
});

test('the router builds one handler per office with a server-resolved tenant', async () => {
  const rows = { 'office-a': 'a0000000-0000-4000-8000-00000000000a', 'office-b': 'b0000000-0000-4000-8000-00000000000b' };
  const pool = {
    async query(_sql, [slug]) {
      return { rows: rows[slug] ? [{ id: rows[slug], slug }] : [] };
    },
  };
  const created = [];
  const router = createTenantRouter({
    pool,
    baseDomain: BASE,
    createHandler: (tenant) => {
      created.push(tenant);
      return async (_req, res) => res.end(JSON.stringify(tenant.tenantId));
    },
  });
  const call = async (host) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(body) { this.body = body; } };
    await router(req(host), res);
    return res;
  };
  assert.equal((await call('office-a.' + BASE)).body, JSON.stringify(rows['office-a']));
  assert.equal((await call('office-b.' + BASE)).body, JSON.stringify(rows['office-b']));
  await call('office-a.' + BASE);
  await call(BASE);
  assert.deepEqual(
    created.map((tenant) => [tenant.slug, tenant.baseDomain]),
    [['office-a', BASE], ['office-b', BASE], [null, BASE]],
  );
  const denied = await call('nobody.' + BASE);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.headers['Cache-Control'], 'no-store');
  assert.equal((await call('evil.com')).statusCode, 404);
  assert.equal(created.length, 3);
});

test('scheduled jobs requested on the deployment address run for the existing office', async () => {
  // The hosting platform calls vercel.json crons on its own *.vercel.app address.
  const resolver = createTenantResolver({}, { baseDomain: BASE, cacheMs: 0 });
  const onDeployment = (url) => resolver.resolve({ ...req('han-project-abc123.vercel.app'), url });
  for (const path of ['/api/backups/cron', '/api/personnel-ledger/cron', '/api/backups/cron?x=1'])
    assert.deepEqual(await onDeployment(path), { tenantId: LEGACY_TENANT_ID, slug: null }, path);
  // Nothing else is served on that address: no pages, no sign-in, no other job.
  for (const path of ['/', '/api/session', '/api/login', '/api/backups', '/api/backups/cron/x', '/api/voip/cron', undefined])
    await assert.rejects(onDeployment(path), status(404), String(path));
  // On the console's address the job path is still the console's, never an office's.
  assert.deepEqual(await resolver.resolve({ ...req('admin.' + BASE), url: '/api/backups/cron' }), { platform: true });
});

test('our own server serves the console, browser files and loopback jobs', async () => {
  const http = require('node:http');
  const { serve } = require('./support/postgres.cjs');
  const { createStandaloneHandler } = require('../lib/saas/deployment.cjs');
  const { pg, pool } = await database();
  const server = await serve(createStandaloneHandler({ pool, cloud: false, baseDomain: BASE }));
  const ask = (host, path, { method = 'GET', headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const request = http.request(server.url + path, { method, headers: { host, ...headers } }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      request.on('error', reject);
      request.end(body);
    });
  try {
    const admin = 'admin.' + BASE;
    const root = await ask(admin, '/');
    assert.equal(root.status, 200);
    assert.match(root.text, /platform\.js/);
    assert.equal((await ask(admin, '/platform.js')).status, 200);
    // The console answers on its own address instead of the office application.
    const login = await ask(admin, '/api/platform/login', {
      method: 'POST',
      headers: { origin: 'https://' + admin, 'x-han-request': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'wrong-password-123' }),
    });
    assert.equal(login.status, 401, login.text);
    assert.equal((await ask(admin, '/api/session')).status, 404);
    // Scheduled jobs call the loopback address; they belong to the existing office.
    const local = await ask('127.0.0.1:4317', '/api/session');
    assert.notEqual(local.status, 404, local.text);
    assert.deepEqual(local, await ask('www.' + BASE, '/api/session'));
    // Browser files are the same everywhere; data of an unknown office is not.
    assert.equal((await ask('nobody.' + BASE, '/app.js')).status, 200);
    assert.equal((await ask('nobody.' + BASE, '/api/session')).status, 403);
    assert.equal((await ask('evil.example.org', '/api/session')).status, 404);
  } finally {
    await server.close();
    await pg.close();
  }
});
