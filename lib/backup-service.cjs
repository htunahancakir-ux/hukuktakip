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

// Backup schedule, in Istanbul time (UTC+3 all year since 2016):
//   { type: 'daily', times: ['09:00', '13:00', '18:00'] }  — 1 to 6 times, at least an hour apart
//   { type: 'weekly', weekday: 1..7 }                      — Monday = 1; that day, no time asked
//   { type: 'interval', days: 1 | 7 | 30 }                 — the older "every N days" setting
const ISTANBUL_MS = 3 * 3600000;
const DAY_MS = 86400000;
const minutesOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
function cleanSchedule(input) {
  if (!input || typeof input !== 'object') return null;
  if (input.type === 'daily') {
    if (!Array.isArray(input.times)) return null;
    const raw = input.times.map((t) => String(t).trim());
    const times = [...new Set(raw)].sort();
    // The same hour twice is a mistake the person should see, not something to merge quietly.
    if (times.length !== raw.length) return null;
    if (!times.length || times.length > 6 || times.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)))
      return null;
    for (let i = 1; i < times.length; i++)
      if (minutesOf(times[i]) - minutesOf(times[i - 1]) < 60) return null;
    // Across midnight too (23:45 and 00:30 are 45 minutes apart).
    if (times.length > 1 && 1440 - minutesOf(times.at(-1)) + minutesOf(times[0]) < 60) return null;
    return { type: 'daily', times };
  }
  if (input.type === 'weekly') {
    const weekday = Number(input.weekday);
    return Number.isInteger(weekday) && weekday >= 1 && weekday <= 7 ? { type: 'weekly', weekday } : null;
  }
  if (input.type === 'interval')
    return intervals.has(input.days) ? { type: 'interval', days: input.days } : null;
  return null;
}
function scheduleOf(policy) {
  return (
    cleanSchedule(policy.schedule) || {
      type: 'interval',
      days: intervals.has(policy.intervalDays) ? policy.intervalDays : 1,
    }
  );
}
// Slot instants (ms) of a fixed schedule around `now`: the latest one at or before now, and the next.
function slots(schedule, now) {
  const local = now + ISTANBUL_MS;
  const dayStart = Math.floor(local / DAY_MS) * DAY_MS; // Istanbul midnight, shifted
  const candidates = [];
  for (let d = -8; d <= 8; d++) {
    const start = dayStart + d * DAY_MS;
    if (schedule.type === 'daily')
      for (const time of schedule.times) candidates.push(start + minutesOf(time) * 60000);
    else {
      const weekday = ((new Date(start).getUTCDay() + 6) % 7) + 1; // Monday = 1
      if (weekday === schedule.weekday) candidates.push(start);
    }
  }
  const instants = candidates.map((t) => t - ISTANBUL_MS).sort((a, b) => a - b);
  return {
    latest: instants.filter((t) => t <= now).at(-1) ?? null,
    next: instants.find((t) => t > now) ?? null,
  };
}
// Whether a scheduled (not forced) backup should run now, and when the next one is.
function plan(policy, now = Date.now()) {
  const schedule = scheduleOf(policy);
  const last = Date.parse(policy.lastSuccessAt || '');
  if (schedule.type === 'interval') {
    const due = !Number.isFinite(last) || now - last >= schedule.days * DAY_MS;
    return { schedule, due, nextDueAt: Number.isFinite(last) ? last + schedule.days * DAY_MS : null };
  }
  const { latest, next } = slots(schedule, now);
  const due = latest !== null && (!Number.isFinite(last) || last < latest);
  return { schedule, due, slot: latest, nextDueAt: due ? latest : next };
}

function publicPolicy(value, local, cloud = false) {
  const policy = { ...defaultPolicy, ...(value || {}) };
  const scheduled = plan(policy);
  return {
    enabled: !!policy.enabled,
    intervalDays: intervals.has(policy.intervalDays) ? policy.intervalDays : 1,
    schedule: scheduled.schedule,
    lastSuccessAt: policy.lastSuccessAt || null,
    lastAttemptAt: policy.lastAttemptAt || null,
    lastLocalAt: policy.lastLocalAt || null,
    lastR2At: policy.lastR2At || null,
    lastError: policy.lastError || null,
    nextDueAt:
      policy.enabled && scheduled.nextDueAt !== null ? new Date(scheduled.nextDueAt).toISOString() : null,
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
  const legacyPrefix = 'hanhukuk/';
  const prefix = legacyPrefix + (cloud ? 'production/' : 'local/');
  const attachmentPrefix = cloud ? 'hanhukuk-canli-' : 'hanhukuk-yerel-';
  const legacyKey = (policy) =>
    policy.legacyObjectKey || (backupEntry(policy.lastObjectKey, legacyPrefix) ? policy.lastObjectKey : null);

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
    const legacy = !scoped && backupEntry(key, legacyPrefix);
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
  async function configure({ enabled, intervalDays, schedule }) {
    const chosen = schedule === undefined ? null : cleanSchedule(schedule);
    if (schedule !== undefined && !chosen)
      throw Object.assign(
        new Error(
          'Geçerli bir yedekleme zamanı seçin: günlük için 1–6 farklı saat (gece yarısı dahil aralarında en az 1 saat), haftalık için bir gün.',
        ),
        { status: 400 },
      );
    if (typeof enabled !== 'boolean' || (!chosen && !intervals.has(intervalDays)))
      throw Object.assign(new Error('Geçerli yedekleme aralığı seçin.'), { status: 400 });
    if (enabled && (!r2Configured() || !encryptionKey() || (cloud && !process.env.CRON_SECRET)))
      throw Object.assign(new Error('R2 erişimi, şifreleme veya zamanlayıcı anahtarı henüz ayarlanmadı.'), {
        status: 503,
      });
    await store.updatePolicy((policy) => {
      policy.enabled = enabled;
      if (chosen) {
        policy.schedule = chosen;
        if (chosen.type === 'interval') policy.intervalDays = chosen.days;
      } else {
        policy.intervalDays = intervalDays;
        delete policy.schedule;
      }
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
        const scheduled = plan(policy, now);
        if (!scheduled.due) return null;
        // A failed attempt for this slot is retried after an hour, not on every check.
        const attempted = Date.parse(policy.lastAttemptAt || 0);
        if (now - attempted < 3600000 && (scheduled.slot === undefined || attempted >= scheduled.slot))
          return null;
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
      // Provider credentials and one-time recovery codes never enter a backup file.
      const { whatsappConfig, smsConfig, passwordRecovery, smsRecovery, reminderScheduler, ...recoverable } =
        snapshot;
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
