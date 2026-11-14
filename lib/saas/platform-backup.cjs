const crypto = require('node:crypto');
const path = require('node:path');
const { ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const backup = require('../backup-service.cjs');
const { inTransaction } = require('../db-transaction.cjs');
const { record } = require('./platform-account.cjs');

// Fleet backup, run from the operator console (Yönetim → Yedekleme) and by the nightly job:
//   every office   the same encrypted file the office takes itself in Ayarlar → Yedekleme,
//                  written under the office's own folder, so the office sees it in its list too
//   the console    every han_saas table (offices, subscriptions, sales, expenses, support,
//                  operators, settings …) as one encrypted file under hanhukuk/platform/
// Operators see when each office was last backed up and may download the console's own file.
// Office files are never handed to the console: they hold the office's records.

const PREFIX = 'hanhukuk/platform/production/';
const ATTACHMENT_PREFIX = 'hukuktakip-yonetim-';
const FORMAT_VERSION = 1;
// Signed-in sessions, sign-in counters and one-time support codes are not worth restoring.
const SKIPPED_TABLES = new Set(['platform_sessions', 'platform_login_attempts', 'support_access_codes']);
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
// A scheduled run leaves alone an office that was backed up within this time (its own
// schedule, or the nightly job of the existing office, already covered it).
const FRESH_MS = 12 * 3600000;
const LEASE_MS = 150000;
const MAX_FILES = 30;
const fail = (status, message) => Object.assign(new Error(message), { status });

async function readSettings(db) {
  const { rows } = await db.query("SELECT value FROM han_saas.platform_settings WHERE key = 'backups'");
  return rows[0]?.value || {};
}
async function patchSettings(db, patch, adminId = null) {
  await db.query(
    `INSERT INTO han_saas.platform_settings(key, value, updated_by, updated_at) VALUES ('backups', $1::jsonb, $2, clock_timestamp())
     ON CONFLICT (key) DO UPDATE SET value = han_saas.platform_settings.value || EXCLUDED.value,
       updated_by = coalesce(EXCLUDED.updated_by, han_saas.platform_settings.updated_by), updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(patch), adminId],
  );
}
// One run at a time, across server instances: the lease is taken in a single statement.
async function claim(db, now) {
  const { rows } = await db.query(
    `INSERT INTO han_saas.platform_settings(key, value, updated_at) VALUES ('backups', $1::jsonb, clock_timestamp())
     ON CONFLICT (key) DO UPDATE SET value = han_saas.platform_settings.value || EXCLUDED.value, updated_at = EXCLUDED.updated_at
       WHERE coalesce(han_saas.platform_settings.value->>'leaseUntil', '') < $2
     RETURNING key`,
    [JSON.stringify({ leaseUntil: new Date(now + LEASE_MS).toISOString(), lastAttemptAt: new Date(now).toISOString() }), new Date(now).toISOString()],
  );
  return rows.length === 1;
}

// Every office with the backup state its own application keeps (lib/backup-service.cjs).
async function offices(pool, { records = process.env.HAN_RECORD_STORE === '1' } = {}) {
  const { rows } = await pool.query(
    records
      ? `SELECT t.id, t.name, t.slug, t.status, m.body->'backupPolicy' AS policy, (m.tenant_id IS NOT NULL) AS "hasData"
         FROM han_saas.tenants t LEFT JOIN han_data.metadata m ON m.tenant_id = t.id AND m.id = 1
         ORDER BY t.created_at, t.id`
      : `SELECT t.id, t.name, t.slug, t.status, s.payload->'backupPolicy' AS policy, (s.tenant_id IS NOT NULL) AS "hasData"
         FROM han_saas.tenants t LEFT JOIN han_private.han_state s ON s.tenant_id = t.id AND s.id = 1
         ORDER BY t.created_at, t.id`,
  );
  return rows.map((row) => ({
    tenantId: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    hasData: row.hasData,
    automatic: row.policy?.enabled === true,
    lastSuccessAt: row.policy?.lastSuccessAt || null,
    lastSize: row.policy?.lastSize || null,
    lastError: row.policy?.lastError || null,
  }));
}

function publicSettings(settings) {
  return {
    enabled: settings.enabled === true,
    lastAttemptAt: settings.lastAttemptAt || null,
    lastSuccessAt: settings.lastSuccessAt || null,
    lastSize: settings.lastSize || null,
    lastObjectKey: settings.lastObjectKey || null,
    lastError: settings.lastError || null,
    lastRun: settings.lastRun || null,
    r2Configured: backup.r2Configured(),
    encryptionConfigured: !!backup.encryptionKey(),
    scheduleConfigured: !!process.env.CRON_SECRET,
  };
}

async function status(pool) {
  return { ...publicSettings(await readSettings(pool)), offices: await offices(pool) };
}

function ready() {
  if (!backup.r2Configured() || !backup.encryptionKey())
    throw fail(503, 'R2 erişim anahtarları ve şifreleme anahtarı henüz ayarlanmadı.');
}

async function configure(pool, adminId, input) {
  if (typeof input?.enabled !== 'boolean') throw fail(400, 'Geçersiz istek.');
  if (input.enabled) {
    ready();
    if (!process.env.CRON_SECRET) throw fail(503, 'Zamanlayıcı anahtarı (CRON_SECRET) henüz ayarlanmadı.');
  }
  await patchSettings(pool, { enabled: input.enabled }, adminId);
  await record(pool, adminId, 'backup.schedule', null, input.enabled ? 'açık' : 'kapalı');
  return status(pool);
}

// The console's own data: every table of the control plane as its rows, in one consistent
// read. Provider credentials (sealed SMS password, map key) stay out, as in office backups.
async function exportPlatform(pool) {
  return inTransaction(
    pool,
    async (db) => {
      const { rows } = await db.query(
        `SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = 'han_saas' AND table_type = 'BASE TABLE' ORDER BY table_name`,
      );
      const tables = {};
      for (const { name } of rows) {
        if (SKIPPED_TABLES.has(name)) continue;
        if (!IDENTIFIER.test(name)) throw Error('Unexpected control-plane table name');
        const result = await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows FROM han_saas."${name}" t`);
        tables[name] = result.rows[0].rows;
      }
      for (const setting of tables.platform_settings || []) {
        if (!setting.value || typeof setting.value !== 'object') continue;
        for (const key of Object.keys(setting.value)) if (/Enc$/.test(key)) delete setting.value[key];
        if (setting.key === 'backups') delete setting.value.leaseUntil;
      }
      return {
        _hanPlatformBackup: {
          version: FORMAT_VERSION,
          createdAt: new Date().toISOString(),
          rows: Object.fromEntries(Object.entries(tables).map(([name, list]) => [name, list.length])),
        },
        tables,
      };
    },
    { readOnly: true },
  );
}

async function savePlatform(pool, { upload, now }) {
  const data = backup.encryptState(await exportPlatform(pool), backup.encryptionKey());
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const objectKey = `${PREFIX}${stamp}-${crypto.randomUUID()}.hnb`;
  await upload(objectKey, data);
  return { objectKey, size: data.length };
}

// Backs up the console and then every office, oldest backup first, until `budgetMs` runs out
// (offices left over are reported as waiting and come first on the next run).
// `scheduled`: the nightly job. It does nothing unless switched on in the console and skips
// offices backed up in the last 12 hours. Without it (the "Şimdi yedekle" button) every
// office is backed up.
async function runAll(
  pool,
  {
    adminId = null,
    scheduled = false,
    budgetMs = 90000,
    now = Date.now,
    upload = backup.uploadR2,
    r2Client,
    // The office's store, bound to its tenant (row-level security applies to every read).
    storeFor = (tenantId) => require('../postgres-store.cjs').createStore(pool, { tenantId }),
  } = {},
) {
  if (scheduled && (await readSettings(pool)).enabled !== true) return { skipped: 'Otomatik toplu yedekleme kapalı.' };
  ready();
  const started = now();
  if (!(await claim(pool, started))) {
    if (scheduled) return { skipped: 'Toplu yedekleme zaten çalışıyor.' };
    throw fail(409, 'Toplu yedekleme zaten çalışıyor. Birkaç dakika sonra yeniden deneyin.');
  }
  const results = [];
  let platform;
  let summary;
  try {
    try {
      platform = { ok: true, ...(await savePlatform(pool, { upload, now: started })) };
    } catch {
      console.error('Platform backup failed');
      platform = { ok: false, error: 'Yönetim yedeği alınamadı. R2 bağlantısını kontrol edin.' };
    }
    const list = await offices(pool);
    const order = [...list].sort((a, b) => (a.lastSuccessAt || '').localeCompare(b.lastSuccessAt || ''));
    for (const office of order) {
      const base = { tenantId: office.tenantId, name: office.name };
      if (!office.hasData) results.push({ ...base, result: 'empty' });
      else if (scheduled && started - Date.parse(office.lastSuccessAt || '') < FRESH_MS) results.push({ ...base, result: 'fresh' });
      else if (now() - started > budgetMs) results.push({ ...base, result: 'waiting' });
      else {
        try {
          const done = await backup
            .createBackupService({ store: storeFor(office.tenantId), cloud: true, upload, r2Client })
            .run({ force: true });
          results.push(done.ok ? { ...base, result: 'saved', size: done.bytes } : { ...base, result: 'waiting' });
        } catch {
          console.error('Office backup failed');
          results.push({ ...base, result: 'failed' });
        }
      }
    }
  } finally {
    const count = (result) => results.filter((item) => item.result === result).length;
    const failed = count('failed');
    const completedAt = new Date().toISOString();
    const whole = platform?.ok && !failed && !count('waiting');
    await patchSettings(pool, {
      leaseUntil: '',
      ...(platform?.ok
        ? { lastObjectKey: platform.objectKey, lastSize: platform.size, lastPlatformAt: completedAt }
        : {}),
      ...(whole ? { lastSuccessAt: completedAt } : {}),
      lastError: !platform?.ok
        ? platform?.error || 'Toplu yedekleme tamamlanamadı.'
        : failed
          ? `${failed} büronun yedeği alınamadı.`
          : null,
      lastRun: (summary = {
        at: completedAt,
        scheduled,
        platform: platform?.ok === true,
        saved: count('saved'),
        fresh: count('fresh'),
        failed,
        waiting: count('waiting'),
        empty: count('empty'),
      }),
    }).catch(() => console.error('Fleet backup state could not be saved'));
  }
  if (adminId)
    await record(
      pool,
      adminId,
      'backup.run',
      null,
      `${summary.saved} büro yedeklendi${summary.failed ? `, ${summary.failed} başarısız` : ''}${summary.waiting ? `, ${summary.waiting} sırada` : ''}`,
    );
  return { ok: platform.ok && !summary.failed, platform: { ok: platform.ok, size: platform.size || null }, results, ...(await status(pool)) };
}

function openR2(r2Client = backup.createR2Client) {
  if (!backup.r2Configured()) throw fail(503, 'R2 bağlantısı henüz yapılandırılmadı.');
  return r2Client();
}

// The console's own backup files, newest first.
async function files(pool, { r2Client } = {}) {
  const client = openR2(r2Client);
  const rows = [];
  try {
    let continuation;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME, Prefix: PREFIX, ContinuationToken: continuation }),
      );
      for (const object of page.Contents || []) {
        const row = backup.backupEntry(object.Key, PREFIX, object.Size);
        if (row) rows.push(row);
      }
      continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuation);
  } finally {
    client.destroy();
  }
  return { backups: rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_FILES) };
}

// Streams one of the console's own backup files. Any other key (an office's file included)
// is refused before object storage is asked.
async function download(pool, adminId, key, consume, { r2Client } = {}) {
  const missing = () => fail(404, 'Yedek dosyası bulunamadı.');
  if (!backup.backupEntry(key, PREFIX)) throw missing();
  const client = openR2(r2Client);
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
    if (object.Metadata?.format !== backup.format || !object.Body) {
      object.Body?.destroy();
      throw missing();
    }
    const filename = ATTACHMENT_PREFIX + path.posix.basename(key);
    await consume(object.Body, filename);
    await record(pool, adminId, 'backup.download', filename.slice(0, 120));
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404) throw missing();
    throw error;
  } finally {
    client.destroy();
  }
}

module.exports = { status, configure, runAll, files, download, exportPlatform, PREFIX, SKIPPED_TABLES };
