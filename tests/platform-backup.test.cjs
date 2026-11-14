// Yönetim → Yedekleme: the operator console backs up every office and its own data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { database, fixture, serve } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { decryptState, format } = require('../lib/backup-service.cjs');
const { createPlatformAdmin } = require('../lib/saas/platform-auth.cjs');
const { createPlatformHandler } = require('../lib/platform-app.cjs');
const { LEGACY_TENANT_ID } = require('../lib/saas/tenant-pool.cjs');
const platformBackup = require('../lib/saas/platform-backup.cjs');
const platformMaps = require('../lib/saas/platform-maps.cjs');
const platform = require('../lib/saas/platform.cjs');

Object.assign(process.env, {
  R2_ACCOUNT_ID: 'example',
  R2_ACCESS_KEY_ID: 'test',
  R2_SECRET_ACCESS_KEY: 'test',
  R2_BUCKET_NAME: 'hanhukuktakip',
  BACKUP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  PLATFORM_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  CRON_SECRET: 'synthetic-cron-secret-for-tests',
});
const opPassword = 'Synthetic-Platform-Backup-Test!';
const SERVICE_KEY = 'AIza' + 'S'.repeat(35);
const open = (bytes) => decryptState(bytes, Buffer.from(process.env.BACKUP_ENCRYPTION_KEY, 'hex'));

async function world() {
  const { pg, pool } = await database();
  await importState(pool, fixture());
  const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Op', password: opPassword })).id;
  const office = (
    await platform.openOffice(pool, op, {
      slug: 'ikinci',
      name: 'İkinci Büro',
      admin: { name: 'Yönetici', username: 'ikinci', password: opPassword },
      userCount: 2,
      userPriceKurus: 1000,
      termMonths: 1,
      moduleCodes: [],
      paid: true,
    })
  ).office;
  const uploads = [];
  const upload = async (key, data) => {
    uploads.push({ key, data });
  };
  return { pg, pool, op, office, uploads, upload };
}

test('one press backs up the console and every office, each into its own folder', async () => {
  const { pg, pool, op, office, uploads, upload } = await world();
  try {
    await platformMaps.saveSettings(pool, op, { apiKey: SERVICE_KEY, enabled: true });
    // A tenant row without a workspace yet (still being set up) is reported, not failed.
    await pool.query("INSERT INTO han_saas.tenants(id, slug, name) VALUES ($1, 'bos-buro', 'Boş Büro')", [crypto.randomUUID()]);

    const before = await platformBackup.status(pool);
    assert.equal(before.enabled, false);
    assert.equal(before.lastSuccessAt, null);
    assert.deepEqual(
      before.offices.map((o) => [o.name, o.hasData, o.lastSuccessAt]),
      [
        ['Mevcut Büro', true, null],
        ['İkinci Büro', true, null],
        ['Boş Büro', false, null],
      ],
    );

    const run = await platformBackup.runAll(pool, { adminId: op, upload });
    assert.equal(run.ok, true);
    assert.deepEqual(run.results.map((r) => [r.name, r.result]).sort(), [
      ['Boş Büro', 'empty'],
      ['Mevcut Büro', 'saved'],
      ['İkinci Büro', 'saved'],
    ]);
    assert.equal(uploads.length, 3);
    const [consoleFile, ...officeFiles] = uploads;
    assert.match(consoleFile.key, /^hanhukuk\/platform\/production\/\d{4}-.*\.hnb$/);
    const existing = officeFiles.find((file) => /^hanhukuk\/production\//.test(file.key));
    const second = officeFiles.find((file) => file.key.startsWith(`hanhukuk/tenants/${office.id}/production/`));
    assert.ok(existing && second, 'each office is written under its own prefix');

    // The console's file: every control-plane table, without sessions or sealed credentials.
    const bundle = open(consoleFile.data);
    assert.equal(bundle._hanPlatformBackup.version, 1);
    assert.deepEqual(bundle.tables.tenants.map((t) => t.slug).sort(), ['bos-buro', 'existing-office', 'ikinci']);
    assert.equal(bundle.tables.sales.length, 1);
    assert.equal(bundle.tables.platform_admins[0].username, 'root');
    for (const table of platformBackup.SKIPPED_TABLES) assert.equal(table in bundle.tables, false, table);
    const maps = bundle.tables.platform_settings.find((row) => row.key === 'maps');
    assert.equal(maps.value.enabled, true);
    assert.equal('apiKeyEnc' in maps.value, false, 'the sealed map key stays out of the file');
    assert.equal(bundle._hanPlatformBackup.rows.tenants, 3);

    // Office files hold that office's accounts only.
    assert.deepEqual(open(existing.data).users.map((u) => u.username), ['test']);
    assert.deepEqual(open(second.data).users.map((u) => u.username), ['ikinci']);

    const after = await platformBackup.status(pool);
    assert.ok(after.lastSuccessAt);
    assert.equal(after.lastObjectKey, consoleFile.key);
    assert.equal(after.lastSize, consoleFile.data.length);
    assert.equal(after.lastError, null);
    assert.deepEqual(
      { ...after.lastRun, at: null },
      { at: null, scheduled: false, platform: true, saved: 2, fresh: 0, failed: 0, waiting: 0, empty: 1 },
    );
    assert.deepEqual(
      after.offices.map((o) => [o.name, !!o.lastSuccessAt, o.lastSize > 0]),
      [
        ['Mevcut Büro', true, true],
        ['İkinci Büro', true, true],
        ['Boş Büro', false, false],
      ],
    );
    // The office sees the backup in its own Ayarlar → Yedekleme too.
    assert.equal((await createStore(pool, { tenantId: office.id }).readPolicy()).lastObjectKey, second.key);
    const { rows } = await pool.query("SELECT detail FROM han_saas.platform_audit WHERE action = 'backup.run'");
    assert.deepEqual(rows, [{ detail: '2 büro yedeklendi' }]);
  } finally {
    await pg.close();
  }
});

test('the nightly run is off until switched on, skips fresh offices and never overlaps', async () => {
  const { pg, pool, op, uploads, upload } = await world();
  try {
    assert.deepEqual(await platformBackup.runAll(pool, { scheduled: true, upload }), {
      skipped: 'Otomatik toplu yedekleme kapalı.',
    });
    assert.equal(uploads.length, 0);
    await assert.rejects(() => platformBackup.configure(pool, op, { enabled: 'yes' }), (e) => e.status === 400);
    assert.equal((await platformBackup.configure(pool, op, { enabled: true })).enabled, true);

    const first = await platformBackup.runAll(pool, { scheduled: true, upload });
    assert.deepEqual(first.results.map((r) => r.result), ['saved', 'saved']);
    assert.equal(uploads.length, 3);
    // An hour later nothing is repeated for the offices; the console's small file is.
    const hour = await platformBackup.runAll(pool, { scheduled: true, upload, now: () => Date.now() + 3600000 });
    assert.deepEqual(hour.results.map((r) => r.result), ['fresh', 'fresh']);
    assert.equal(uploads.length, 4);
    assert.ok(hour.lastSuccessAt, 'a run with nothing left to do still counts as complete');
    const nextNight = await platformBackup.runAll(pool, { scheduled: true, upload, now: () => Date.now() + 13 * 3600000 });
    assert.deepEqual(nextNight.results.map((r) => r.result), ['saved', 'saved']);
    // The button always backs every office up.
    const pressed = await platformBackup.runAll(pool, { adminId: op, upload });
    assert.deepEqual(pressed.results.map((r) => r.result), ['saved', 'saved']);

    // While a run holds the lease another one does not start.
    await pool.query(
      `UPDATE han_saas.platform_settings SET value = value || jsonb_build_object('leaseUntil', $1::text) WHERE key = 'backups'`,
      [new Date(Date.now() + 60000).toISOString()],
    );
    const count = uploads.length;
    assert.deepEqual(await platformBackup.runAll(pool, { scheduled: true, upload }), {
      skipped: 'Toplu yedekleme zaten çalışıyor.',
    });
    await assert.rejects(() => platformBackup.runAll(pool, { adminId: op, upload }), (e) => e.status === 409);
    assert.equal(uploads.length, count);
    assert.equal((await platformBackup.status(pool)).enabled, true, 'the lease never wipes the setting');
  } finally {
    await pg.close();
  }
});

test('one office failing or time running out is reported and does not stop the others', async () => {
  const { pg, pool, op, office, uploads, upload } = await world();
  try {
    const failing = async (key, data) => {
      if (key.includes(office.id)) throw new Error('synthetic storage failure');
      await upload(key, data);
    };
    const run = await platformBackup.runAll(pool, { adminId: op, upload: failing });
    assert.equal(run.ok, false);
    assert.deepEqual(run.results.map((r) => [r.name, r.result]).sort(), [
      ['Mevcut Büro', 'saved'],
      ['İkinci Büro', 'failed'],
    ]);
    assert.equal(run.lastError, '1 büronun yedeği alınamadı.');
    assert.equal(run.lastSuccessAt, null, 'an incomplete run is not a success');
    assert.equal(run.offices.find((o) => o.tenantId === office.id).lastSuccessAt, null);
    assert.ok(run.offices.find((o) => o.tenantId === LEGACY_TENANT_ID).lastSuccessAt);

    // No time left: the console is saved, the offices wait for the next run, oldest first.
    const before = uploads.length;
    const short = await platformBackup.runAll(pool, { adminId: op, upload, budgetMs: -1 });
    assert.deepEqual(short.results.map((r) => [r.name, r.result]), [
      ['İkinci Büro', 'waiting'],
      ['Mevcut Büro', 'waiting'],
    ]);
    assert.equal(uploads.length, before + 1);
    assert.equal(short.lastRun.waiting, 2);
    assert.equal(short.lastSuccessAt, null);

    // The console's own file failing is an error of the whole run.
    const noConsole = async (key, data) => {
      if (key.startsWith(platformBackup.PREFIX)) throw new Error('synthetic storage failure');
      await upload(key, data);
    };
    const partial = await platformBackup.runAll(pool, { adminId: op, upload: noConsole });
    assert.equal(partial.ok, false);
    assert.equal(partial.platform.ok, false);
    assert.match(partial.lastError, /Yönetim yedeği alınamadı/);
    assert.deepEqual(partial.results.map((r) => r.result), ['saved', 'saved']);

    // Without storage or the encryption key nothing is attempted.
    const key = process.env.BACKUP_ENCRYPTION_KEY;
    delete process.env.BACKUP_ENCRYPTION_KEY;
    try {
      await assert.rejects(() => platformBackup.runAll(pool, { adminId: op, upload }), (e) => e.status === 503);
      await assert.rejects(() => platformBackup.configure(pool, op, { enabled: true }), (e) => e.status === 503);
      assert.equal((await platformBackup.status(pool)).encryptionConfigured, false);
    } finally {
      process.env.BACKUP_ENCRYPTION_KEY = key;
    }
  } finally {
    await pg.close();
  }
});

test('console HTTP: status, run, the console’s files and download; office files are refused', async () => {
  const { pg, pool, office, uploads, upload } = await world();
  // Object storage stand-in holding what was uploaded.
  const asked = [];
  const r2 = () => ({
    async send(command) {
      const input = command.input;
      asked.push([command.constructor.name, input.Key || input.Prefix]);
      if (command.constructor.name === 'ListObjectsV2Command')
        return {
          Contents: uploads
            .filter((file) => file.key.startsWith(input.Prefix))
            .map((file) => ({ Key: file.key, Size: file.data.length })),
        };
      const file = uploads.find((item) => item.key === input.Key);
      if (!file) throw Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } });
      return { Metadata: { format }, Body: Readable.from([file.data]) };
    },
    destroy() {},
  });
  const server = await serve(createPlatformHandler({ pool, secureCookies: false, backupUpload: upload, backupR2Client: r2 }));
  try {
    const headers = { 'Content-Type': 'application/json', 'X-Han-Request': '1' };
    const login = await fetch(server.url + '/api/platform/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'root', password: opPassword }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const call = (path, method = 'GET', body) =>
      fetch(server.url + '/api/platform/' + path, {
        method,
        headers: { cookie, ...(method === 'POST' ? headers : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    for (const path of ['backups', 'backups/files', 'backups/download?key=x'])
      assert.equal((await fetch(server.url + '/api/platform/' + path)).status, 401, path);
    assert.equal((await fetch(server.url + '/api/platform/backups/run', { method: 'POST', headers })).status, 401);

    assert.equal((await (await call('backups')).json()).offices.length, 2);
    const run = await (await call('backups/run', 'POST', {})).json();
    assert.equal(run.ok, true);
    assert.equal(uploads.length, 3);
    assert.equal((await (await call('backups', 'POST', { enabled: true })).json()).enabled, true);

    const list = await (await call('backups/files')).json();
    assert.deepEqual(list.backups.map((row) => [row.key, row.size]), [[uploads[0].key, uploads[0].data.length]]);
    assert.ok(Number.isFinite(Date.parse(list.backups[0].createdAt)));

    const file = await call('backups/download?key=' + encodeURIComponent(uploads[0].key));
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-disposition'), /^attachment; filename="hukuktakip-yonetim-\d{4}-.*\.hnb"$/);
    assert.ok(open(Buffer.from(await file.arrayBuffer())).tables.tenants.length);

    // An office's file is never served by the console, and object storage is not even asked.
    const officeKey = uploads.find((item) => item.key.includes(office.id)).key;
    const before = asked.length;
    for (const key of [officeKey, uploads[1].key, 'hanhukuk/platform/production/../../x.hnb', ''])
      assert.equal((await call('backups/download?key=' + encodeURIComponent(key))).status, 404, key);
    assert.equal(asked.length, before);

    const { rows } = await pool.query("SELECT action FROM han_saas.platform_audit WHERE action LIKE 'backup.%' ORDER BY id");
    assert.deepEqual(rows.map((row) => row.action), ['backup.run', 'backup.schedule', 'backup.download']);
  } finally {
    await server.close();
    await pg.close();
  }
});

test('the nightly request starts the fleet backup after answering, even when this office’s backup fails', async () => {
  const { pg, pool } = await database();
  await importState(pool, fixture());
  const started = [];
  const waiting = [];
  const app = createApplication({
    cloud: true,
    store: createStore(pool),
    appOrigin: 'https://han.example.com',
    fleetBackup: async () => {
      started.push('fleet');
    },
    background: (promise) => waiting.push(promise),
  });
  const server = await serve(app);
  try {
    const cron = (secret) =>
      fetch(server.url + '/api/backups/cron', { headers: secret ? { Authorization: 'Bearer ' + secret } : {} });
    assert.equal((await cron()).status, 401);
    assert.equal((await cron('wrong-secret')).status, 401);
    await Promise.all(waiting);
    assert.deepEqual(started, [], 'an unauthenticated request starts nothing');

    const ok = await cron(process.env.CRON_SECRET);
    assert.equal(ok.status, 200);
    assert.match((await ok.json()).skipped, /Otomatik yedekleme kapalı/);
    await Promise.all(waiting);
    assert.deepEqual(started, ['fleet']);

    // This office's own backup cannot run (no encryption key): the fleet still starts.
    await createStore(pool).updatePolicy((policy) => {
      policy.enabled = true;
      return true;
    });
    const key = process.env.BACKUP_ENCRYPTION_KEY;
    delete process.env.BACKUP_ENCRYPTION_KEY;
    try {
      assert.equal((await cron(process.env.CRON_SECRET)).status, 503);
    } finally {
      process.env.BACKUP_ENCRYPTION_KEY = key;
    }
    await Promise.all(waiting);
    assert.deepEqual(started, ['fleet', 'fleet']);
  } finally {
    await server.close();
    await pg.close();
  }
});

test('backup computers report their last run through small files the console lists', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'han-local-backup-'));
  const { pg, pool } = await world();
  try {
    assert.equal(platformBackup.localBackups(''), null, 'not configured: no list');
    assert.equal((await platformBackup.status(pool)).localBackups, null);
    assert.deepEqual(platformBackup.localBackups(path.join(directory, 'missing')), []);
    const write = (name, body) => fs.writeFileSync(path.join(directory, name), body);
    write('OFIS-PC.json', '{"name":"ignored","at":"2026-11-14T04:00:05Z","ok":true,"files":43,"mb":60}\n');
    write('EV_PC.json', '{"at":"2026-11-13T04:00:00Z","ok":false,"files":-4,"mb":"<img>"}');
    write('bozuk.json', '{not json');
    write('tarihsiz.json', '{"ok":true}');
    write('notlar.txt', 'x');
    write('kötü ad.json', '{"at":"2026-11-14T04:00:05Z","ok":true}');
    assert.deepEqual(platformBackup.localBackups(directory), [
      { name: 'EV_PC', at: '2026-11-13T04:00:00.000Z', ok: false, files: null, sizeMb: null },
      { name: 'OFIS-PC', at: '2026-11-14T04:00:05.000Z', ok: true, files: 43, sizeMb: 60 },
    ]);
    process.env.HAN_LOCAL_BACKUP_DIR = directory;
    assert.equal((await platformBackup.status(pool)).localBackups.length, 2);
  } finally {
    delete process.env.HAN_LOCAL_BACKUP_DIR;
    fs.rmSync(directory, { recursive: true, force: true });
    await pg.close();
  }
});
