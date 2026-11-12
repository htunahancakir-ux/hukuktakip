const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// Screenshots attached to feedback (hata / öneri / soru). They can show client and debtor
// data, so they are stored encrypted: in Cloudflare R2 when it is configured (the same bucket as
// backups, folder geri-bildirim/), otherwise in a local folder (desktop/local use only).
const PREFIX = 'geri-bildirim/';
const ID = /^[0-9a-f-]{36}$/;

function key() {
  const raw =
    process.env.FEEDBACK_ENCRYPTION_KEY ||
    process.env.BACKUP_ENCRYPTION_KEY ||
    process.env.VOIP_ENCRYPTION_KEY ||
    process.env.AI_ENCRYPTION_KEY ||
    '';
  if (!/^[a-f0-9]{64}$/i.test(raw)) return null;
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(raw, 'hex'), Buffer.alloc(0), 'hanhukuk-feedback-v1', 32),
  );
}

function createFeedbackFiles({ directory = process.env.HANHUKUK_FEEDBACK_DIR, client } = {}) {
  const r2Ready = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'].every(
    (k) => process.env[k],
  );
  let s3 = client || null;
  const sdk = () => require('@aws-sdk/client-s3');
  if (!s3 && r2Ready) {
    const { S3Client } = sdk();
    s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  // On Vercel only R2 is durable; a local folder there would vanish with the instance.
  const folder = s3
    ? null
    : directory || (process.env.VERCEL ? null : path.join(os.tmpdir(), 'hanhukuk-feedback'));
  const objectKey = (id) => {
    if (!ID.test(id)) throw new Error('Invalid feedback id');
    return PREFIX + id + '.enc';
  };
  return {
    get available() {
      return !!key() && (!!s3 || !!folder);
    },
    async save(id, bytes) {
      const k = key();
      if (!k || (!s3 && !folder)) return false;
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', k, nonce);
      const sealed = Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
      if (s3) {
        const { PutObjectCommand } = sdk();
        await s3.send(
          new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: objectKey(id),
            Body: sealed,
            ContentType: 'application/octet-stream',
          }),
        );
      } else {
        await fs.mkdir(path.join(folder, PREFIX), { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(folder, objectKey(id)), sealed, { mode: 0o600 });
      }
      return true;
    },
    async read(id) {
      const k = key();
      if (!k) return null;
      let sealed;
      try {
        if (s3) {
          const { GetObjectCommand } = sdk();
          const object = await s3.send(
            new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: objectKey(id) }),
          );
          sealed = Buffer.from(await object.Body.transformToByteArray());
        } else if (folder) sealed = await fs.readFile(path.join(folder, objectKey(id)));
        else return null;
      } catch {
        return null;
      }
      if (sealed.length < 29) return null;
      const decipher = crypto.createDecipheriv('aes-256-gcm', k, sealed.subarray(0, 12));
      decipher.setAuthTag(sealed.subarray(-16));
      try {
        return Buffer.concat([decipher.update(sealed.subarray(12, -16)), decipher.final()]);
      } catch {
        return null;
      }
    },
  };
}

module.exports = { createFeedbackFiles };
