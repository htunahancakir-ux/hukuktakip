const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const vm = require('node:vm');
const { PGlite } = require('@electric-sql/pglite');
const { migrate, importState, createStore } = require('../lib/postgres-store.cjs');
const { createApplication } = require('../lib/application.cjs');
const { encryptState } = require('../lib/backup-service.cjs');
const { restoreBackup } = require('../scripts/restore-backup.cjs');
const workspaceScripts = require('../outputs/icrapro/workspace-assets.js');
const { reserveReset } = require('../lib/whatsapp.cjs');

const { password, fixture, database, serve } = require('./support/postgres.cjs');

test('PostgreSQL import preserves all fields and refuses overwrite', async () => {
  const { pg, pool } = await database();
  try {
    const state = fixture();
    state.customMetadata = { text: 'Türkçe kayıt', amount: 12345 };
    await importState(pool, state);
    assert.deepEqual((await pool.query('SELECT payload FROM han_private.han_state')).rows[0].payload, state);
    await assert.rejects(importState(pool, fixture()), (e) => e.code === '23505');
    assert.equal(
      (await pool.query("SELECT relrowsecurity FROM pg_class WHERE relname='han_state'")).rows[0]
        .relrowsecurity,
      true,
    );
  } finally {
    await pg.close();
  }
});

test('Two application instances share sessions, reject stale writes, persist logout and rate limits', async () => {
  const { pg, pool } = await database();
  await importState(pool, fixture());
  const store = createStore(pool);
  const one = await serve(createApplication({ store })),
    two = await serve(createApplication({ store }));
  try {
    const headers = { 'Content-Type': 'application/json', 'X-Han-Request': '1' };
    const login = await fetch(one.url + '/api/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'test', password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const stored = (await pool.query('SELECT token_hash FROM han_private.han_sessions')).rows;
    assert.equal(stored.length, 1);
    assert.notEqual(stored[0].token_hash, cookie.split('=')[1], 'Only token hashes are stored');
    const session = await (await fetch(two.url + '/api/session', { headers: { cookie } })).json();
    assert.equal(session.user.id, 'test-ceo');
    const url = '/api/data?key=icrapro-settings-v1';
    const old = await fetch(one.url + url, { headers: { cookie } });
    const etag = old.headers.get('etag');
    const put = async (base, value, tag) =>
      fetch(base + url, {
        method: 'PUT',
        headers: { ...headers, cookie, ...(tag ? { 'If-Match': tag } : {}) },
        body: JSON.stringify({ value }),
      });
    assert.equal((await put(one.url, { firm: { name: 'New' } }, null)).status, 428);
    const written = await put(one.url, { firm: { name: 'New' } }, etag);
    assert.equal(written.status, 200);
    assert.notEqual(written.headers.get('etag'), etag);
    assert.equal((await put(two.url, { firm: { name: 'Stale' } }, etag)).status, 409);
    assert.equal((await (await fetch(two.url + url, { headers: { cookie } })).json()).firm.name, 'New');
    const setup = await fetch(one.url + '/api/setup', { method: 'POST', headers, body: '{}' });
    assert.equal(setup.status, 403);
    assert.equal(
      (await fetch(one.url + '/api/logout', { method: 'POST', headers: { ...headers, cookie }, body: '{}' }))
        .status,
      200,
    );
    assert.equal((await (await fetch(two.url + '/api/session', { headers: { cookie } })).json()).user, null);
    for (let i = 0; i < 8; i++)
      assert.equal(
        (
          await fetch((i % 2 ? one : two).url + '/api/login', {
            method: 'POST',
            headers,
            body: JSON.stringify({ username: 'test', password: 'wrong' }),
          })
        ).status,
        401,
      );
    assert.equal(
      (
        await fetch(two.url + '/api/login', {
          method: 'POST',
          headers,
          body: JSON.stringify({ username: 'test', password }),
        })
      ).status,
      429,
    );
  } finally {
    await one.close();
    await two.close();
    await pg.close();
  }
});

test('Only the CEO can see active users, while every signed-in user refreshes their own presence', async (t) => {
  const keys = [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
    'BACKUP_ENCRYPTION_KEY',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    R2_ACCOUNT_ID: 'test-account',
    R2_ACCESS_KEY_ID: 'test-access',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    R2_BUCKET_NAME: 'test-bucket',
    BACKUP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  });
  t.after(() => {
    for (const key of keys)
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
  });
  const { pg, pool } = await database();
  const state = fixture();
  state.users.push({
    ...state.users[0],
    id: 'test-staff',
    username: 'staff',
    name: 'Test Personel',
    role: 'staff',
    permissions: [],
  });
  state.users.push({
    ...state.users[0],
    id: 'legacy-staff',
    username: 'legacy',
    name: 'Eski Oturum',
    role: 'staff',
    permissions: [],
  });
  await importState(pool, state);
  const store = createStore(pool);
  await store.transaction(async (tx) => {
    tx.sessions.set('legacy-session', {
      id: 'legacy-staff',
      deviceType: 'desktop',
      until: Date.now() + 60000,
    });
    tx.sessions.set('invalid-session', {
      id: 'legacy-staff',
      deviceType: 'mobile',
      until: Date.now() + 60000,
      seenAt: 'invalid',
    });
  });
  await store.updatePolicy((policy) => {
    const now = new Date().toISOString();
    Object.assign(policy, { enabled: true, intervalDays: 1, lastSuccessAt: now, lastR2At: now });
    return true;
  });
  const app = await serve(createApplication({ store }));
  try {
    const headers = { 'Content-Type': 'application/json', 'X-Han-Request': '1' };
    const login = async (username) => {
      const response = await fetch(app.url + '/api/login', {
        method: 'POST',
        headers,
        body: JSON.stringify({ username, password }),
      });
      assert.equal(response.status, 200);
      return response.headers.get('set-cookie').split(';')[0];
    };
    const ceo = await login('test');
    const staff = await login('staff');
    assert.equal((await fetch(app.url + '/api/presence')).status, 401);
    assert.equal((await fetch(app.url + '/api/presence', { headers: { cookie: staff } })).status, 403);
    assert.equal(
      (
        await fetch(app.url + '/api/presence', {
          method: 'POST',
          headers: { 'X-Han-Request': '1', cookie: staff },
        })
      ).status,
      200,
    );
    const result = await (await fetch(app.url + '/api/presence', { headers: { cookie: ceo } })).json();
    assert.equal(result.windowMinutes, 3);
    assert.deepEqual(new Set(result.active.map((user) => user.id)), new Set(['test-ceo', 'test-staff']));
    assert.deepEqual(Object.keys(result.active[0]).sort(), ['id', 'lastSeenAt', 'name', 'role']);
  } finally {
    await app.close();
    await pg.close();
  }
});

test('Desktop and mobile can coexist, but a second session of either type requires replacing all sessions', async () => {
  const { pg, pool } = await database();
  await importState(pool, fixture());
  const store = createStore(pool);
  const one = await serve(createApplication({ store }));
  const two = await serve(createApplication({ store }));
  try {
    const legacyToken = crypto.randomBytes(32).toString('hex');
    await store.transaction(async ({ sessions }) => {
      sessions.set(crypto.createHash('sha256').update(legacyToken).digest('hex'), {
        id: 'test-ceo',
        until: Date.now() + 60000,
      });
    });
    const sessionUser = async (app, cookie) =>
      (await (await fetch(app.url + '/api/session', { headers: { cookie } })).json()).user;
    assert.equal(await sessionUser(one, 'han_session=' + legacyToken), null);

    const login = (app, userAgent, data = {}) =>
      fetch(app.url + '/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Han-Request': '1',
          'User-Agent': userAgent,
        },
        body: JSON.stringify({ username: 'test', password, ...data }),
      });
    const desktopAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
    const androidAgent = 'Mozilla/5.0 (Linux; Android 14) Mobile';
    const iphoneAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';
    const getCookie = (response) => response.headers.get('set-cookie').split(';')[0];
    const competing = await Promise.all([login(one, desktopAgent), login(two, desktopAgent)]);
    assert.deepEqual(competing.map((response) => response.status).sort(), [200, 409]);
    const conflict = competing.find((response) => response.status === 409);
    assert.equal(conflict.headers.get('set-cookie'), null);
    const warning = await conflict.json();
    assert.equal(warning.code, 'session_replacement_required');
    assert.match(warning.error, /Tüm cihazlardan çıkılacaktır/);
    const desktopCookie = getCookie(competing.find((response) => response.status === 200));

    const phone = await login(two, androidAgent);
    assert.equal(phone.status, 200);
    const mobileCookie = getCookie(phone);
    assert.equal((await login(one, iphoneAgent)).status, 409);
    assert.equal((await login(two, desktopAgent, { replaceSessions: true, password: 'wrong' })).status, 401);
    assert.equal((await sessionUser(two, desktopCookie)).id, 'test-ceo');
    assert.equal((await sessionUser(one, mobileCookie)).id, 'test-ceo');

    const confirmed = await login(two, desktopAgent, { replaceSessions: true });
    assert.equal(confirmed.status, 200);
    assert.equal(await sessionUser(one, desktopCookie), null);
    assert.equal(await sessionUser(two, mobileCookie), null);
    assert.equal((await sessionUser(one, getCookie(confirmed))).id, 'test-ceo');
    assert.equal((await login(two, androidAgent)).status, 200);
  } finally {
    await one.close();
    await two.close();
    await pg.close();
  }
});

test('The account owner can change only their own password and choose a persistent sign-in', async () => {
  const { pg, pool } = await database();
  await importState(pool, fixture());
  const app = await serve(createApplication({ store: createStore(pool) }));
  try {
    const headers = { 'Content-Type': 'application/json', 'X-Han-Request': '1' };
    const mobileHeaders = { ...headers, 'Sec-CH-UA-Mobile': '?1' };
    const login = async (remember = false, secret = password, requestHeaders = headers) =>
      fetch(app.url + '/api/login', {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({ username: 'test', password: secret, ...(remember && { remember: true }) }),
      });
    const temporary = await login();
    assert.equal(temporary.status, 200);
    assert.doesNotMatch(temporary.headers.get('set-cookie'), /Max-Age=/);

    const remembered = await login(true, password, mobileHeaders);
    assert.equal(remembered.status, 200);
    assert.match(remembered.headers.get('set-cookie'), /Max-Age=1209600/);
    const cookie = remembered.headers.get('set-cookie').split(';')[0];

    const wrong = await fetch(app.url + '/api/account/password', {
      method: 'POST',
      headers: { ...headers, cookie },
      body: JSON.stringify({ currentPassword: 'wrong-password', password: 'New-Synthetic-Password' }),
    });
    assert.equal(wrong.status, 400);

    const changedPassword = 'New-Synthetic-Password';
    const changed = await fetch(app.url + '/api/account/password', {
      method: 'POST',
      headers: { ...mobileHeaders, cookie },
      body: JSON.stringify({ currentPassword: password, password: changedPassword }),
    });
    assert.equal(changed.status, 200);
    assert.doesNotMatch(changed.headers.get('set-cookie'), /Max-Age=/);
    assert.equal((await (await fetch(app.url + '/api/session', { headers: { cookie } })).json()).user, null);
    assert.equal((await login(false, password)).status, 401);
    assert.equal((await login(false, changedPassword)).status, 200);
  } finally {
    await app.close();
    await pg.close();
  }
});

test('Transaction failure rolls back state; buffered response prevents false success', async () => {
  const { pg, pool } = await database();
  await importState(pool, fixture());
  const store = createStore(pool);
  try {
    await assert.rejects(
      store.transaction(async (tx) => {
        tx.state.data['icrapro-settings-v1'] = { broken: true };
        tx.saveState(tx.state);
        throw Error('Synthetic failure');
      }),
    );
    assert.deepEqual(
      (await pool.query('SELECT payload FROM han_private.han_state')).rows[0].payload.data[
        'icrapro-settings-v1'
      ],
      {},
    );
    const broken = createStore({
      query: (...args) => pool.query(...args),
      async connect() {
        const db = await pool.connect();
        return {
          release: db.release,
          query(sql, params) {
            if (sql === 'COMMIT') throw Error('Synthetic commit failure');
            return db.query(sql, params);
          },
        };
      },
    });
    const app = await serve(createApplication({ store: broken }));
    try {
      const response = await fetch(app.url + '/api/login', {
        method: 'POST',
        headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'test', password }),
      });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM han_private.han_sessions')).rows[0].n,
        0,
      );
    } finally {
      await app.close();
    }
  } finally {
    await pg.close();
  }
});

test('Vercel mode fails closed without database and accepts only configured HTTPS origin', async () => {
  const unavailable = await serve(createApplication({ cloud: true }));
  try {
    assert.equal((await fetch(unavailable.url + '/api/session')).status, 503);
  } finally {
    await unavailable.close();
  }
  const { pg, pool } = await database();
  await importState(pool, fixture());
  const app = await serve(
    createApplication({ cloud: true, store: createStore(pool), appOrigin: 'https://example.invalid' }),
  );
  try {
    const request = (origin) =>
      fetch(app.url + '/api/login', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Han-Request': '1' },
        body: JSON.stringify({ username: 'test', password }),
      });
    assert.equal((await request('https://attacker.invalid')).status, 403);
    const response = await request('https://example.invalid');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /; Secure/);
    assert.equal((await fetch(app.url + '/work/hanhukuk-state.json')).status, 404);
    assert.equal((await fetch(app.url + '/access-server.cjs')).status, 404);
  } finally {
    await app.close();
    await pg.close();
  }
});

test('Managers can download with a record of the last sender; only the CEO can restore', async (t) => {
  for (const [name, value] of Object.entries({
    R2_ACCOUNT_ID: 'test',
    R2_BUCKET_NAME: 'test',
    R2_ACCESS_KEY_ID: 'test',
    R2_SECRET_ACCESS_KEY: 'test',
  })) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const state = fixture();
  state.users.push(
    { ...state.users[0], id: 'test-admin', username: 'admin', name: 'Test Admin', role: 'admin' },
    { ...state.users[0], id: 'test-staff', username: 'staff', role: 'staff' },
  );
  const filename = '2026-11-06T20-00-00-000Z-00000000-0000-4000-8000-000000000001.hnb';
  const legacyKey = 'hanhukuk/' + filename;
  const newKey = 'hanhukuk/production/' + filename.replace('11-06', '11-07');
  state.backupPolicy = { lastObjectKey: newKey, legacyObjectKey: legacyKey };
  const encryptionKey = crypto.randomBytes(32);
  const encrypted = encryptState(state, encryptionKey);
  const { pg, pool } = await database();
  t.after(() => pg.close());
  await importState(pool, state);
  const r2Client = () => ({
    destroy() {},
    async send(command) {
      const { Key, Prefix } = command.input;
      if (Prefix === 'hanhukuk/production/2026-11-')
        return { Contents: [{ Key: newKey, Size: encrypted.length }] };
      assert.ok([legacyKey, newKey].includes(Key));
      return {
        ContentLength: encrypted.length,
        Metadata: { format: 'hanhukuk-backup-v1' },
        ...(command.constructor.name === 'GetObjectCommand' ? { Body: Readable.from([encrypted]) } : {}),
      };
    },
  });
  const app = await serve(
    createApplication({
      cloud: true,
      store: createStore(pool),
      appOrigin: 'https://example.invalid',
      backupR2Client: r2Client,
    }),
  );
  try {
    async function login(username) {
      const response = await fetch(app.url + '/api/login', {
        method: 'POST',
        headers: { Origin: 'https://example.invalid', 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(response.status, 200);
      return { cookie: response.headers.get('set-cookie').split(';')[0] };
    }
    const ceo = await login('test');
    const admin = await login('admin');
    const staff = await login('staff');
    for (const route of [
      '/api/due-installments',
      '/api/call-reminders',
      '/api/messages/summary',
      '/api/work-orders?scope=all',
      '/api/report-data',
      '/api/payroll-report',
      '/api/bonus2',
    ]) {
      const response = await fetch(app.url + route, { headers: admin });
      assert.equal(response.status, 200, route);
      assert.equal(typeof (await response.json()), 'object');
    }
    const list = app.url + '/api/backups/files?month=2026-11';
    const download = (key) => app.url + '/api/backups/download?key=' + encodeURIComponent(key);
    const lastDownload = async (headers) =>
      (await (await fetch(app.url + '/api/backups', { headers })).json()).lastDownload;
    assert.equal((await fetch(list)).status, 403);
    assert.equal((await fetch(list, { headers: staff })).status, 403);
    assert.equal((await fetch(download(legacyKey), { headers: staff })).status, 403);
    assert.equal(await lastDownload(admin), null);
    const listed = await (await fetch(list, { headers: admin })).json();
    assert.deepEqual(
      listed.backups.map((row) => row.key),
      [newKey, legacyKey],
    );
    const response = await fetch(download(legacyKey), { headers: admin });
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('content-disposition'),
      `attachment; filename="hanhukuk-canli-${filename}"`,
    );
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const downloaded = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(downloaded, encrypted);
    const first = await lastDownload(ceo);
    assert.equal(first.filename, 'hanhukuk-canli-' + filename);
    assert.equal(first.backupAt, '2026-11-06T20:00:00.000Z');
    assert.equal(first.name, 'Test Admin');
    assert.equal(first.username, 'admin');
    assert.ok(Number.isFinite(Date.parse(first.downloadedAt)));
    assert.equal((await fetch(download('hanhukuk/local/' + filename), { headers: ceo })).status, 404);
    assert.deepEqual(await lastDownload(admin), first);
    const next = await fetch(download(newKey), { headers: ceo });
    assert.equal(next.status, 200);
    await next.arrayBuffer();
    const latest = await lastDownload(admin);
    assert.equal(latest.username, 'test');
    assert.equal(latest.backupAt, '2026-11-07T20:00:00.000Z');
    assert.ok(latest.downloadedAt >= first.downloadedAt);
    const audit = await (
      await fetch(app.url + '/api/audit?category=changes&action=download', { headers: admin })
    ).json();
    assert.deepEqual(
      audit.items.map((row) => row.actor_username),
      ['test', 'admin'],
    );
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'han-restore-'));
    const file = path.join(directory, 'download.hnb');
    const localTarget = path.join(directory, 'recovered.json');
    try {
      await fs.writeFile(file, downloaded);
      const restore = (username) =>
        restoreBackup({
          file,
          localTarget,
          rawKey: encryptionKey.toString('hex'),
          credentials: async () => ({ username, password }),
        });
      await assert.rejects(restore('admin'), /etkin CEO/);
      await assert.rejects(fs.stat(localTarget), { code: 'ENOENT' });
      await restore('test');
      const { backupPolicy, ...expected } = state;
      assert.deepEqual(JSON.parse(await fs.readFile(localTarget, 'utf8')), expected);
      await assert.rejects(restore('test'), /Hedef dosya zaten var/);
    } finally {
      await fs.rm(file, { force: true });
      await fs.rm(localTarget, { force: true });
      await fs.rmdir(directory);
    }
  } finally {
    await app.close();
  }
});

test('Audit tracks successful changes and separates login, logout and failed login', async () => {
  const { pg, pool } = await database();
  const state = fixture();
  state.users.push(
    { ...state.users[0], id: 'audit-admin', username: 'admin', role: 'admin', name: 'Deneme Yönetici' },
    {
      ...state.users[0],
      id: require('../lib/deletion-policy.cjs').OWNER_ID,
      username: 'owner',
      role: 'ceo',
      name: 'HAN',
    },
    { ...state.users[0], id: 'audit-staff', username: 'staff', role: 'staff', staffId: 'person-1' },
  );
  state.data['icrapro-personnel-v1'].push({ id: 'person-1', name: 'Personel', active: true });
  state.data['icrapro-v1'].clients.push({ id: 'client-1', name: 'Çağdaş Hukuk', type: 'Firma' });
  state.data['icrapro-v1'].docs.push(
    {
      id: 'doc-1',
      debtor: 'Çağdaş Borçlu',
      number: 'EVR-1',
      relatedStaff: 'person-1',
      phone1: '0532 987 65 43',
      amount: 0,
    },
    { id: 'doc-2', debtor: 'Çağdaş Diğer', number: 'EVR-2', relatedStaff: 'person-2', amount: 0 },
  );
  await importState(pool, state);
  const app = await serve(createApplication({ store: createStore(pool) }));
  try {
    const mutation = { 'X-Han-Request': '1', 'Content-Type': 'application/json' };
    const post = (url, data, cookie) =>
      fetch(app.url + url, {
        method: 'POST',
        headers: { ...mutation, ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(data),
      });
    const login = async (username) => {
      const result = await post('/api/login', { username, password });
      assert.equal(result.status, 200);
      return result.headers.get('set-cookie').split(';')[0];
    };
    const admin = await login('admin');
    const staff = await login('staff');
    assert.equal(
      (await post('/api/login', { username: 'admin', password: 'bad-synthetic-secret' })).status,
      401,
    );
    assert.equal(
      (await post('/api/users/password', { id: 'test-ceo', password: 'replacement-not-allowed' }, admin))
        .status,
      403,
    );
    assert.equal((await fetch(app.url + '/api/audit', { headers: { cookie: staff } })).status, 403);
    assert.equal((await fetch(app.url + '/api/search?q=evrak')).status, 401);
    async function search(query, cookie) {
      const result = await fetch(app.url + '/api/search?q=' + encodeURIComponent(query), {
        headers: { cookie },
      });
      assert.equal(result.status, 200);
      return (await result.json()).items.map((item) => item.id).sort();
    }
    assert.deepEqual(await search('cagdas', admin), ['client-1', 'doc-1', 'doc-2']);
    assert.deepEqual(await search('cagdas', staff), ['doc-1']);
    assert.deepEqual(await search('5329876543', staff), ['doc-1']);
    const dataUrl = app.url + '/api/data?key=icrapro-v1';
    async function update(change, status = 200, cookie = admin) {
      const old = await fetch(dataUrl, { headers: { cookie } });
      const value = await old.json();
      change(value);
      const next = await fetch(dataUrl, {
        method: 'PUT',
        headers: { ...mutation, cookie, 'If-Match': old.headers.get('etag') },
        body: JSON.stringify({ value }),
      });
      assert.equal(next.status, status);
    }
    await update((value) =>
      value.docs.push({ id: 'audit-doc', debtor: 'Synthetic private name', number: 'EVR-3', amount: 0 }),
    );
    await update((value) => {
      value.docs.find((row) => row.id === 'audit-doc').notes = 'Synthetic private content';
    });
    assert.equal((await post('/api/documents/delete', { documentId: 'audit-doc' }, admin)).status, 403);
    const owner = await login('owner');
    assert.equal((await post('/api/documents/delete', { documentId: 'audit-doc' }, owner)).status, 200);
    assert.equal(
      (await fetch(app.url + '/api/documents/archived', { headers: { cookie: staff } })).status,
      403,
    );
    const archived = await (
      await fetch(app.url + '/api/documents/archived', { headers: { cookie: admin } })
    ).json();
    assert.equal(archived.items[0].number, 'EVR-3');
    assert.equal(archived.items[0].deletedByName, 'HAN');
    assert.equal((await post('/api/logout', {}, staff)).status, 200);
    const log = async (category, extras = '') => {
      const response = await fetch(app.url + '/api/audit?category=' + category + extras, {
        headers: { cookie: admin },
      });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.doesNotMatch(body, /bad-synthetic-secret|replacement-not-allowed|Synthetic private/);
      return JSON.parse(body).items;
    };
    assert.deepEqual(
      (await log('login')).map((row) => row.actor_username),
      ['owner', 'staff', 'admin'],
    );
    assert.deepEqual(
      (await log('logout')).map((row) => row.actor_username),
      ['staff'],
    );
    assert.deepEqual(
      (await log('failed')).map((row) => [row.actor_username, row.action]),
      [['admin', 'failed']],
    );
    const records = (await log('changes', '&actor=' + encodeURIComponent('Deneme Yönetici'))).filter(
      (row) => row.record_ref === 'EVR-3',
    );
    assert.deepEqual(
      records.map((row) => row.action),
      ['update', 'create'],
    );
    assert.ok(records[0].fields.includes('Notlar'));
    assert.ok(records.every((row) => row.area === 'Evraklar' && row.actor_username === 'admin'));
    assert.ok(records.every((row) => Number.isFinite(Date.parse(row.at))));
    assert.equal(
      (await log('changes', '&action=delete')).every((row) => row.action === 'delete'),
      true,
    );
    assert.equal((await post('/api/documents/restore', { documentId: 'audit-doc' }, admin)).status, 200);
    const restored = await (await fetch(dataUrl, { headers: { cookie: admin } })).json();
    assert.equal(restored.docs.find((row) => row.id === 'audit-doc').notes, 'Synthetic private content');
    assert.ok(!restored.archivedNumbers.includes('EVR-3'));
    assert.equal((await log('changes', '&action=restore'))[0].record_ref, 'EVR-3');
    await update(
      (value) => {
        value.docs = value.docs.filter((row) => row.id !== 'doc-2');
      },
      200,
      owner,
    );
    const removed = await (
      await fetch(app.url + '/api/documents/archived', { headers: { cookie: admin } })
    ).json();
    assert.deepEqual(
      removed.items.map((row) => row.number),
      ['EVR-2'],
    );
    await update(
      (value) => value.docs.push({ id: 'number-reuse', debtor: 'Test', number: 'EVR-2', amount: 0 }),
      409,
    );
  } finally {
    await app.close();
    await pg.close();
  }
});

test('Every workspace browser module is served in the shared manifest; server internals stay private', async () => {
  const app = await serve(createApplication({ cloud: true }));
  try {
    const html = await (await fetch(app.url + '/')).text();
    assert.ok(html.indexOf('src="workspace-assets.js"') >= 0);
    assert.ok(html.indexOf('src="workspace-assets.js"') < html.indexOf('src="auth.js"'));
    assert.match(html, /href="workspace-layout\.css"/);
    assert.ok(html.indexOf('src="login-recovery.js"') >= 0);
    assert.ok(html.indexOf('src="login-recovery.js"') < html.indexOf('src="auth.js"'));
    const preAuth = [
      'html-safety.js',
      'workspace-assets.js',
      'login-layout.js',
      'login-recovery.js',
      'modal-dismissal.js',
      'employee-terms.js',
      'employee-terms-settings.js',
    ];
    for (const file of preAuth) {
      const index = html.indexOf('src="' + file + '"');
      assert.ok(index >= 0 && index < html.indexOf('src="auth.js"'), file);
    }
    const publicScripts = [...preAuth, 'auth.js', ...workspaceScripts];
    assert.equal(new Set(publicScripts).size, publicScripts.length);
    const scripts = await Promise.all(
      publicScripts.map(async (file) => {
        const response = await fetch(app.url + '/' + file);
        assert.equal(response.status, 200, file);
        assert.match(response.headers.get('content-type'), /javascript/);
        return response.text();
      }),
    );
    assert.doesNotThrow(() => new vm.Script(scripts.join('\n;\n')));
    assert.equal((await fetch(app.url + '/access-accounts.cjs')).status, 404);
    assert.equal((await fetch(app.url + '/audit-events.jsonl')).status, 404);
  } finally {
    await app.close();
  }
});

test('CEO publishes immutable terms; new and existing accounts must accept and see only their own history', async () => {
  const { draft } = require('../lib/employee-terms.cjs');
  const { pg, pool } = await database();
  const state = fixture();
  state.users.push({ ...state.users[0], id: 'existing-admin', role: 'admin', username: 'admin' });
  await importState(pool, state);
  const app = await serve(createApplication({ store: createStore(pool) }));
  const request = (path, cookie, method = 'GET', body) =>
    fetch(app.url + '/api/' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async (username) => {
    const response = await request('login', null, 'POST', { username, password });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const publish = (cookie, version, baseVersion, controllerName) =>
    request('employee-terms/settings', cookie, 'PUT', {
      action: 'publish',
      ...draft(controllerName),
      version,
      baseVersion,
    });
  const accept = (cookie, doc, values) =>
    request('employee-terms/accept', cookie, 'POST', {
      version: doc.version,
      hash: doc.hash,
      accepted: true,
      ...values,
    });
  const current = async (cookie) => (await request('employee-terms/current', cookie)).json();
  try {
    assert.equal((await request('employee-terms/history')).status, 401);
    const ceo = await login('test');
    const admin = await login('admin');
    assert.equal((await publish(admin, '1.3.0', null)).status, 403);
    const initial = await publish(ceo, '1.3.0', null);
    assert.equal(initial.status, 200);
    const { document: doc } = await initial.json();
    assert.equal(doc.controllerName, 'Han Hukuk (Av. Hasan Bahadır Patan)');
    assert.match(doc.sections[2].highlight, /ekran görüntüsü almaz/);
    assert.equal((await current(admin)).notice, null);
    assert.equal((await (await request('session', admin)).json()).employeeTermsRequired, true);
    for (const path of [
      'data?key=icrapro-v1',
      'search?q=test',
      'backups',
      'audit',
      'scheduled-reminders',
      'employee-terms/records',
    ]) {
      const result = await request(path, admin);
      assert.equal(result.status, 428, path);
      assert.equal((await result.json()).code, 'employee_terms_required');
    }
    assert.equal((await accept(admin, doc, { hash: 'stale' })).status, 409);
    assert.equal((await accept(admin, doc, { accepted: false })).status, 400);
    const [first, duplicate] = await Promise.all([accept(admin, doc), accept(admin, doc)]);
    assert.equal(first.status, 200);
    const { acceptedAt } = await first.json();
    assert.deepEqual(await duplicate.json(), { acceptedAt });
    assert.equal((await request('data?key=icrapro-v1', admin)).status, 200);
    const history = await (await request('employee-terms/history', admin)).json();
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].accountId, 'existing-admin');
    assert.equal(history.items[0].acceptedAt, acceptedAt);
    assert.equal((await accept(ceo, doc)).status, 200);
    const resend = await request('employee-terms/settings', ceo, 'PUT', {
      action: 'resend',
      version: doc.version,
      recipient: 'existing-admin',
    });
    assert.deepEqual(await resend.json(), { recipients: 1 });
    const { reminder } = await current(admin);
    assert.ok(reminder);
    assert.equal((await current(ceo)).reminder, null);
    assert.equal(
      (
        await request('employee-terms/reminder-seen', admin, 'POST', {
          version: doc.version,
          hash: doc.hash,
          sentAt: reminder,
        })
      ).status,
      200,
    );
    assert.equal((await current(admin)).reminder, null);
    assert.equal((await current(admin)).acceptedAt, acceptedAt);
    const added = await request('users', ceo, 'POST', {
      username: 'new-staff',
      name: 'Yeni çalışan',
      password,
      role: 'staff',
    });
    assert.equal(added.status, 200);
    const staff = await login('new-staff');
    assert.equal((await current(staff)).required, true);
    assert.equal((await request('employee-terms/history?version=1.3.0', staff)).status, 404);
    assert.equal((await request('logout', staff, 'POST', {})).status, 200);
    assert.equal((await publish(ceo, '1.3.0', '1.3.0')).status, 409);
    const update = await publish(ceo, '1.3.1', '1.3.0', 'Yeni veri sorumlusu');
    assert.equal(update.status, 200);
    assert.equal((await current(admin)).required, true);
    const old = await (await request('employee-terms/history?version=1.3.0', admin)).json();
    assert.equal(old.document.controllerName, doc.controllerName);
    assert.equal(old.document.hash, doc.hash);
    const noticeResult = await request('employee-terms/settings', ceo, 'PUT', {
      action: 'notice',
      version: 'A1',
      url: 'https://example.test/notice',
    });
    assert.equal(noticeResult.status, 200);
    const { notice } = await current(admin);
    assert.equal((await request('employee-terms/notice-opened', admin, 'POST', notice)).status, 200);
    assert.equal((await current(admin)).required, true);
    const stored = await pool.query("SELECT payload->'employeeTerms' AS terms FROM han_private.han_state");
    assert.equal(stored.rows[0].terms.acceptances.length, 2);
    assert.equal(stored.rows[0].terms.noticeEvents.length, 1);
  } finally {
    await app.close();
    await pg.close();
  }
});

test('Scheduled reminders respect ownership, local time and destination consent; cron claims a due job once', async (t) => {
  const { digest, scheduleTime } = require('../lib/scheduled-reminders.cjs');
  const { configure } = require('../lib/whatsapp.cjs');
  const previous = process.env.WHATSAPP_ENCRYPTION_KEY;
  process.env.WHATSAPP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  t.after(() => {
    if (previous === undefined) delete process.env.WHATSAPP_ENCRYPTION_KEY;
    else process.env.WHATSAPP_ENCRYPTION_KEY = previous;
  });
  assert.equal(scheduleTime('2030-02-29', '10:00', 0), null);
  assert.equal(scheduleTime('2030-11-07', '00:02', 0), '2030-11-06T21:02:00.000Z');
  const { pg, pool } = await database();
  const state = fixture();
  const secret = crypto.randomBytes(32).toString('hex');
  state.reminderScheduler = { hash: digest(secret) };
  state.users[0].whatsappAllowed = true;
  state.users[0].whatsappPhone = '905321234567';
  state.users.push({
    ...state.users[0],
    id: 'other',
    role: 'staff',
    username: 'other',
    whatsappAllowed: false,
  });
  state.data['icrapro-v1'].docs.push({ id: 'test-file', number: 'EVR-1', debtor: 'Örnek Borçlu' });
  state.whatsappConfig = configure(null, {
    enabled: true,
    phoneNumberId: '10000000001',
    reminderTemplate: 'reminder',
    token: 'synthetic-private-reminder-token-only',
  });
  await importState(pool, state);
  const store = createStore(pool);
  const messages = [];
  const app = await serve(
    createApplication({
      store,
      whatsappFetch: async (_url, { body }) => {
        messages.push(JSON.parse(body));
        return Response.json({ messages: [{ id: 'accepted' }] });
      },
    }),
  );
  const call = (path, method, headers, body) =>
    fetch(app.url + '/api/' + path, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json', 'X-Han-Request': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async (username) => ({
    cookie: (await call('login', 'POST', {}, { username, password })).headers.get('set-cookie').split(';')[0],
  });
  try {
    const ceo = await login('test');
    const other = await login('other');
    const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const create = {
      action: 'create',
      note: 'Gizli dosya notu',
      date,
      time: '12:00',
      whatsapp: true,
      targetType: 'document',
      targetId: 'test-file',
    };
    assert.equal((await call('scheduled-reminders', 'POST', other, create)).status, 404);
    const created = await call('scheduled-reminders', 'POST', ceo, create);
    assert.equal(created.status, 200);
    const { id } = await created.json();
    assert.deepEqual((await (await call('scheduled-reminders', 'GET', other)).json()).items, []);
    assert.equal((await call('scheduled-reminders', 'POST', other, { action: 'cancel', id })).status, 404);
    await store.transaction(({ state, saveState }) => {
      state.scheduledReminders[0].dueAt = new Date(Date.now() - 60000).toISOString();
      saveState(state);
    });
    const cron = (authorization) => call('scheduled-reminders/cron', 'POST', { authorization }, {});
    assert.equal((await cron('Bearer ' + '0'.repeat(64))).status, 401);
    const runs = await Promise.all([cron('Bearer ' + secret), cron('Bearer ' + secret)]);
    assert.deepEqual(
      runs.map((row) => row.status),
      [200, 200],
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, '905321234567');
    assert.doesNotMatch(JSON.stringify(messages[0]), /Gizli dosya notu|Örnek Borçlu|EVR-1/);
    const own = await (await call('scheduled-reminders', 'GET', ceo)).json();
    assert.equal(own.items[0].deliveryStatus, 'accepted');
    assert.equal(own.items[0].target.detail, 'EVR-1');
    assert.equal(own.dueCount, 1);
    assert.equal((await call('scheduled-reminders', 'POST', ceo, { action: 'complete', id })).status, 200);
    assert.equal((await (await call('scheduled-reminders?summary', 'GET', ceo)).json()).dueCount, 0);
  } finally {
    await app.close();
    await pg.close();
  }
});

test('WhatsApp recovery uses one-time links, registered contacts and private credentials', async (t) => {
  const previous = process.env.WHATSAPP_ENCRYPTION_KEY;
  process.env.WHATSAPP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  t.after(() => {
    if (previous === undefined) delete process.env.WHATSAPP_ENCRYPTION_KEY;
    else process.env.WHATSAPP_ENCRYPTION_KEY = previous;
  });
  const { pg, pool } = await database();
  const state = fixture();
  state.users.push({
    ...state.users[0],
    id: 'wa-staff',
    username: 'staff',
    name: 'Test Personel',
    role: 'staff',
    whatsappPhone: '905321234567',
    whatsappAllowed: true,
  });
  state.data['icrapro-v1'].docs.push({
    id: 'wa-doc',
    debtor: 'Çağdaş Şahin',
    number: 'S-0042',
    docType: 'Senet',
    amount: 170,
    originalDocument: 'Alındı',
    deliveredBy: 'Teslim Eden',
    receivedBy: 'Teslim Alan',
  });
  await importState(pool, state);
  const store = createStore(pool);
  const token = 'Synthetic-Test-Token-Not-For-Provider';
  const messages = [],
    pending = [],
    uploads = [];
  const app = await serve(
    createApplication({
      store,
      background: (task) => pending.push(task),
      whatsappFetch: async (url, options) => {
        assert.equal(options.headers.Authorization, 'Bearer ' + token);
        assert.equal(new URL(url).hostname, 'graph.facebook.com');
        if (url.endsWith('/media')) {
          const file = options.body.get('file');
          uploads.push({ mime: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
          return Response.json({ id: 'test-media' });
        }
        messages.push(JSON.parse(options.body));
        return Response.json({ messages: [{ id: 'test-message' }] });
      },
    }),
  );
  try {
    const send = (path, input, { cookie, method = 'POST' } = {}) =>
      fetch(app.url + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1', ...(cookie && { cookie }) },
        body: JSON.stringify(input),
      });
    const ceo = (await send('/api/login', { username: 'test', password })).headers
      .get('set-cookie')
      .split(';')[0];
    const staff = (await send('/api/login', { username: 'staff', password })).headers
      .get('set-cookie')
      .split(';')[0];
    const config = {
      enabled: true,
      phoneNumberId: '123456789',
      token,
      resetTemplate: 'password_link_tr',
      reminderTemplate: 'work_notice',
      messageTemplate: 'office_message',
      documentTemplate: 'office_document',
    };
    assert.equal((await send('/api/whatsapp/config', config, { cookie: staff, method: 'PUT' })).status, 403);
    const saved = await send('/api/whatsapp/config', config, { cookie: ceo, method: 'PUT' });
    assert.equal(saved.status, 200);
    const savedConfig = await saved.text();
    assert.doesNotMatch(savedConfig, /Synthetic-Test-Token/);
    assert.equal(JSON.parse(savedConfig).tokenSaved, true);
    assert.notEqual((await store.readState()).whatsappConfig.sealedToken, token);

    const unknown = await (await send('/api/password-reset/request', { account: 'unknown' })).json();
    const requested = await (
      await send('/api/password-reset/request', { account: '0 (532) 123 45 67' })
    ).json();
    await Promise.all(pending);
    assert.deepEqual(unknown, requested);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, '905321234567');
    const [counts, button] = messages[0].template.components;
    assert.deepEqual(
      counts.parameters.map((value) => value.text),
      ['0', '2', '7'],
    );
    const linkToken = button.parameters[0].text;
    assert.match(linkToken, /^[a-zA-Z0-9_-]{43}$/);
    assert.doesNotMatch(JSON.stringify(await store.readState()), new RegExp(linkToken));
    assert.deepEqual(
      await (await send('/api/password-reset/request', { account: 'staff' })).json(),
      requested,
    );
    assert.equal(messages.length, 1);

    const changedPassword = 'Replacement-Synthetic-Only';
    assert.equal(
      (await send('/api/password-reset/complete', { token: linkToken, password: changedPassword })).status,
      200,
    );
    assert.equal(
      (await send('/api/password-reset/complete', { token: linkToken, password: changedPassword })).status,
      400,
    );
    assert.equal(
      (await (await fetch(app.url + '/api/session', { headers: { cookie: staff } })).json()).user,
      null,
    );
    assert.equal((await send('/api/login', { username: 'staff', password })).status, 401);
    assert.equal((await send('/api/login', { username: 'staff', password: changedPassword })).status, 200);

    const inApp = await send(
      '/api/messages',
      { recipientIds: ['wa-staff'], subject: 'Deneme', text: 'İç mesaj', whatsapp: false },
      { cookie: ceo },
    );
    assert.equal(inApp.status, 201);
    assert.equal(messages.length, 1);
    const both = await send(
      '/api/messages',
      { recipientIds: ['wa-staff'], subject: 'Deneme', text: 'İç mesaj', whatsapp: true },
      { cookie: ceo },
    );
    assert.equal((await both.json()).whatsapp.accepted, 1);
    const doc = {
      documentId: 'wa-doc',
      kind: 'receipt',
      phone: '05320000000',
      consent: true,
      remember: true,
    };
    assert.equal(
      (await send('/api/whatsapp/document', { ...doc, consent: false }, { cookie: ceo })).status,
      400,
    );
    const shared = await send('/api/whatsapp/document', doc, { cookie: ceo });
    assert.equal(shared.status, 200);
    assert.equal((await shared.json()).whatsapp.accepted, 1);
    assert.equal(uploads[0].mime, 'application/pdf');
    assert.equal(uploads[0].bytes.subarray(0, 5).toString(), '%PDF-');
    assert.equal((await store.readState()).data['icrapro-v1'].docs[0].whatsappPhone, '905320000000');
  } finally {
    await app.close();
    await pg.close();
  }
});

test('Password link quotas enforce all three rolling windows', () => {
  const state = {},
    user = { id: 'demo', hash: 'test-hash' };
  const begin = Date.UTC(2026, 10, 1);
  const request = (days) => reserveReset(state, user, begin + days * 86400000);
  assert.deepEqual(request(0).remaining, [0, 2, 7]);
  assert.equal(request(0.5), null);
  assert.ok(request(1));
  assert.ok(request(2));
  assert.equal(request(3), null);
  for (const days of [7, 8, 9, 14, 15]) assert.ok(request(days));
  assert.equal(request(16), null);
  assert.ok(request(30));
});
