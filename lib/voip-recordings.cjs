const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
function key() {
  const raw =
    process.env.VOIP_ENCRYPTION_KEY ||
    process.env.AI_ENCRYPTION_KEY ||
    process.env.BACKUP_ENCRYPTION_KEY ||
    '';
  if (!/^[a-f0-9]{64}$/i.test(raw)) throw Error('Kayıt şifreleme anahtarı hazır değil.');
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(raw, 'hex'), Buffer.alloc(0), 'hanhukuk-voip-recordings-v1', 32),
  );
}
function createRecordingStore({ cloud, directory }) {
  const ready = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'].every(
    (k) => process.env[k],
  );
  const client = ready
    ? new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
      })
    : null;
  const cache = client
    ? require('./voip-hot-cache.cjs').createHotCache(
        path.join(require('node:os').tmpdir(), 'hanhukuk-voip-cache'),
      )
    : null;
  const objectKey = (id) => {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw Error('Geçersiz kayıt kimliği.');
    return 'gorusme-kayitlari/' + id + '.enc';
  };
  return {
    available: !!client || !cloud,
    async save(id, audio, { cache: hot = true } = {}) {
      const iv = crypto.randomBytes(12),
        c = crypto.createCipheriv('aes-256-gcm', key(), iv);
      const bytes = Buffer.concat([c.update(audio), c.final()]);
      const encrypted = Buffer.concat([iv, c.getAuthTag(), bytes]);
      const name = objectKey(id);
      if (client)
        await client.send(
          new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: name,
            Body: encrypted,
            ContentType: 'application/octet-stream',
          }),
        );
      else {
        if (cloud) throw Error('Kalıcı ses arşivi için R2 bağlantısı gerekli.');
        await fs.mkdir(path.join(directory, 'gorusme-kayitlari'), { recursive: true });
        await fs.writeFile(path.join(directory, name), encrypted, { mode: 0o600 });
      }
      if (cache && hot) await cache.put(id, encrypted).catch(() => {});
      else if (cache) await cache.drop(id).catch(() => {});
    },
    async read(id, { cache: hot = true } = {}) {
      const name = objectKey(id);
      if (cache && !hot) await cache.drop(id).catch(() => {});
      const cached = cache && hot ? await cache.get(id) : null;
      const bytes =
        cached ||
        (client
          ? Buffer.from(
              await (
                await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: name }))
              ).Body.transformToByteArray(),
            )
          : await fs.readFile(path.join(directory, name)));
      if (cache && hot && !cached) await cache.put(id, bytes).catch(() => {});
      const d = crypto.createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
      d.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([d.update(bytes.subarray(28)), d.final()]);
    },
  };
}
function filename(call) {
  const clean = (v) =>
    String(v || '')
      .normalize('NFKC')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .replace(/\s+/g, '_')
      .slice(0, 42);
  const stamp = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(new Date(call.createdAt))
    .replace(/[ :]/g, '-');
  return (
    [call.clientName, call.documentNumber, stamp, call.phone, call.staffName, call.id.slice(0, 8)]
      .map(clean)
      .join('_') + '.mp3'
  );
}
module.exports = { createRecordingStore, filename };
