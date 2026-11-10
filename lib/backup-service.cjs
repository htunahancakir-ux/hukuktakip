const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');

const intervals = new Set([1, 7, 30]);
const defaultPolicy = Object.freeze({ enabled: false, intervalDays: 1 });

function publicPolicy(value, local, cloud = false) {
  const policy = { ...defaultPolicy, ...(value || {}) };
  const last = Date.parse(policy.lastSuccessAt || '');
  return {
    enabled: !!policy.enabled,
    intervalDays: intervals.has(policy.intervalDays) ? policy.intervalDays : 1,
    lastSuccessAt: policy.lastSuccessAt || null,
    lastAttemptAt: policy.lastAttemptAt || null,
    lastLocalAt: policy.lastLocalAt || null,
    lastR2At: policy.lastR2At || null,
    lastError: policy.lastError || null,
    nextDueAt:
      policy.enabled && Number.isFinite(last)
        ? new Date(last + policy.intervalDays * 86400000).toISOString()
        : null,
    lastSize: policy.lastSize || null,
    localAvailable: !!local,
    r2Configured: r2Configured(),
    encryptionConfigured: !!encryptionKey(),
    scheduleConfigured: !cloud || !!process.env.CRON_SECRET,
    lastObjectKey: policy.lastObjectKey || null,
    lastDownload: policy.lastDownload || null,
    bucket: process.env.R2_BUCKET_NAME || 'hanhukuktakip',
  };
}

function encryptionKey() {
  const raw = process.env.BACKUP_ENCRYPTION_KEY || '';
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  return null;
}

function r2Configured() {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME
  );
}

function encryptState(state, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(state)));
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return Buffer.concat([Buffer.from('HNB1'), iv, cipher.getAuthTag(), encrypted]);
}

function decryptState(data, key) {
  if (!Buffer.isBuffer(data) || data.length < 33 || data.subarray(0, 4).toString() !== 'HNB1')
    throw new Error('Geçersiz yedek dosyası.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(4, 16));
  decipher.setAuthTag(data.subarray(16, 32));
  return JSON.parse(
    zlib.gunzipSync(Buffer.concat([decipher.update(data.subarray(32)), decipher.final()])).toString('utf8'),
  );
}

const backupFilename =
  /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.hnb$/;
const format = 'hanhukuk-backup-v1';

function createR2Client() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
    maxAttempts: 2,
  });
}

function backupEntry(key, prefix, size) {
  if (typeof key !== 'string' || !key.startsWith(prefix)) return null;
  const file = key.slice(prefix.length);
  const match = backupFilename.exec(file);
  if (!match) return null;
  const [, day, hour, minute, second, ms] = match;
  const createdAt = `${day}T${hour}:${minute}:${second}.${ms}Z`;
  if (!Number.isFinite(Date.parse(createdAt))) return null;
  return { key, createdAt, size };
}

function notFound(error) {
  return error?.$metadata?.httpStatusCode === 404;
}

async function uploadR2(objectKey, data) {
  const client = createR2Client();
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: objectKey,
        Body: data,
        ContentType: 'application/octet-stream',
        Metadata: { format },
      }),
    );
  } finally {
    client.destroy();
  }
}

function createBackupService({
  store,
  localDirectory,
  cloud = false,
  upload = uploadR2,
  r2Client = createR2Client,
}) {
  let running = false;
  const { LEGACY_TENANT_ID } = require('./saas/tenant-pool.cjs');
  const tenantId = store.tenantId && store.tenantId !== LEGACY_TENANT_ID ? store.tenantId : null;
  const legacyPrefix = 'hanhukuk/';
  const prefix = legacyPrefix + (tenantId ? `tenants/${tenantId}/` : '') + (cloud ? 'production/' : 'local/');
  const attachmentPrefix = cloud ? 'hanhukuk-canli-' : 'hanhukuk-yerel-';
  const legacyKey = (policy) =>
    tenantId
      ? null
      : policy.legacyObjectKey ||
        (backupEntry(policy.lastObjectKey, legacyPrefix) ? policy.lastObjectKey : null);

  function openR2() {
    if (!r2Configured())
      throw Object.assign(new Error('R2 bağlantısı henüz yapılandırılmadı.'), { status: 503 });
    return r2Client();
  }

  async function list(month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || ''))
      throw Object.assign(new Error('Geçerli bir ay seçin.'), { status: 400 });
    const previous = legacyKey(await store.readPolicy());
    const client = openR2();
    const bucket = process.env.R2_BUCKET_NAME;
    const rows = [];
    try {
      let continuation;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix + month + '-',
            ContinuationToken: continuation,
          }),
        );
        for (const object of page.Contents || []) {
          const row = backupEntry(object.Key, prefix, object.Size);
          if (row && row.createdAt.startsWith(month + '-')) rows.push(row);
        }
        continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuation);
      const legacy = backupEntry(previous, legacyPrefix);
      if (legacy?.createdAt.startsWith(month + '-')) {
        try {
          const object = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: previous }));
          if (object.Metadata?.format === format) rows.push({ ...legacy, size: object.ContentLength });
        } catch (error) {
          if (!notFound(error)) throw error;
        }
      }
      return { backups: rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
    } finally {
      client.destroy();
    }
  }

  async function download(key, user, consume) {
    const scoped = backupEntry(key, prefix);
    const legacy = !tenantId && !scoped && backupEntry(key, legacyPrefix);
    const missing = () => Object.assign(new Error('Yedek dosyası bulunamadı.'), { status: 404 });
    if (!scoped && (!legacy || legacyKey(await store.readPolicy()) !== key)) throw missing();
    const client = openR2();
    try {
      const object = await client.send(
        new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }),
      );
      if (object.Metadata?.format !== format || !object.Body) {
        object.Body?.destroy();
        throw missing();
      }
      const filename = attachmentPrefix + path.posix.basename(key);
      await consume(object.Body, filename);
      const downloadedAt = new Date().toISOString();
      await store.updatePolicy((policy) => {
        if (policy.lastDownload?.downloadedAt > downloadedAt) return null;
        policy.lastDownload = {
          filename,
          backupAt: (scoped || legacy).createdAt,
          downloadedAt,
          name: user.name,
          username: user.username,
        };
        return true;
      });
    } catch (error) {
      if (notFound(error)) throw missing();
      throw error;
    } finally {
      client.destroy();
    }
  }

  async function status() {
    return publicPolicy(await store.readPolicy(), localDirectory, cloud);
  }
  async function configure({ enabled, intervalDays }) {
    if (typeof enabled !== 'boolean' || !intervals.has(intervalDays))
      throw Object.assign(new Error('Geçerli yedekleme aralığı seçin.'), { status: 400 });
    if (enabled && (!r2Configured() || !encryptionKey() || (cloud && !process.env.CRON_SECRET)))
      throw Object.assign(new Error('R2 erişimi, şifreleme veya zamanlayıcı anahtarı henüz ayarlanmadı.'), {
        status: 503,
      });
    await store.updatePolicy((policy) => {
      policy.enabled = enabled;
      policy.intervalDays = intervalDays;
      return true;
    });
    return status();
  }
  async function run({ force = false } = {}) {
    if (running) return { skipped: 'Yedekleme zaten çalışıyor.' };
    if (!force && !(await store.readPolicy()).enabled) return { skipped: 'Otomatik yedekleme kapalı.' };
    if (!r2Configured() || !encryptionKey())
      throw Object.assign(new Error('R2 erişim anahtarları ve şifreleme anahtarı henüz ayarlanmadı.'), {
        status: 503,
      });
    const now = Date.now();
    const claimed = await store.updatePolicy((policy) => {
      if (Date.parse(policy.leaseUntil || '') > now) return null;
      if (!force) {
        if (!policy.enabled) return null;
        if (now - Date.parse(policy.lastAttemptAt || 0) < 3600000) return null;
        if (now - Date.parse(policy.lastSuccessAt || 0) < policy.intervalDays * 86400000) return null;
      }
      policy.leaseUntil = new Date(now + 180000).toISOString();
      policy.lastAttemptAt = new Date(now).toISOString();
      policy.lastError = null;
      return true;
    });
    if (!claimed) return { skipped: 'Yedekleme zamanı henüz gelmedi veya başka bir işlem sürüyor.' };
    running = true;
    let localSaved = false;
    try {
      const snapshot = await (store.exportBackup ? store.exportBackup() : store.readState());
      if (!snapshot?.users?.length) throw new Error('Aktarılmış uygulama verisi bulunamadı.');
      const { whatsappConfig, mapsConfig, passwordRecovery, reminderScheduler, ...recoverable } = snapshot;
      const data = encryptState(recoverable, encryptionKey());
      const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
      const objectKey = `${prefix}${stamp}-${crypto.randomUUID()}.hnb`;
      if (localDirectory) {
        fs.mkdirSync(localDirectory, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(localDirectory, path.basename(objectKey)), data, {
          flag: 'wx',
          mode: 0o600,
        });
        localSaved = true;
      }
      await upload(objectKey, data);
      const completedAt = new Date().toISOString();
      await store.updatePolicy((policy) => {
        policy.lastSuccessAt = completedAt;
        policy.lastR2At = completedAt;
        if (localSaved) policy.lastLocalAt = completedAt;
        const previous = legacyKey(policy);
        if (previous) policy.legacyObjectKey = previous;
        policy.lastObjectKey = objectKey;
        policy.lastSize = data.length;
        policy.lastError = null;
        policy.leaseUntil = null;
        return true;
      });
      return { ok: true, completedAt, localSaved, r2Saved: true, bytes: data.length };
    } catch (error) {
      await store.updatePolicy((policy) => {
        if (localSaved) policy.lastLocalAt = new Date().toISOString();
        policy.lastError = 'Yedek alınamadı. R2 bağlantısını ve sunucu kayıtlarını kontrol edin.';
        policy.leaseUntil = null;
        return true;
      });
      throw Object.assign(new Error('Yedek alınamadı. R2 bağlantısını kontrol edin.'), {
        status: 503,
        cause: error,
      });
    } finally {
      running = false;
    }
  }
  return { status, configure, run, list, download };
}

module.exports = { createBackupService, encryptState, decryptState, publicPolicy };
