const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { inTransaction } = require('./db-transaction.cjs');
const { event } = require('./audit.cjs');

// What an office puts on its login screen, set in Ayarlar → Firma Bilgileri:
//   login-art    the picture on the left (JPEG, PNG or WebP). The browser shrinks a photo before
//                sending it (longest side 1800 px), so a real upload is a few hundred kilobytes.
//   login-texts  the texts placed on that picture: where, how large, in which style (JSON).
// Without a saved value the built-in picture and texts are shown.
const MAX_BYTES = 1536 * 1024;
const AUDIT = {
  'login-art': ['Giriş ekranı görseli değiştirildi', 'Giriş ekranı görseli varsayılana döndü'],
  'login-texts': ['Giriş ekranı yazıları değiştirildi', 'Giriş ekranı yazıları varsayılana döndü'],
};
// The texts' look comes from these named styles (login-layout.css), never from free CSS.
const TEXT_STYLES = new Set(['brand', 'heading', 'text', 'label']);
const TEXT_COLORS = new Set(['white', 'gold', 'soft']);
const MAX_TEXTS = 12;
// Font size in percent of the picture panel's width (CSS cqw), so it scales with the screen.
const TEXT_SIZE = { min: 0.8, max: 14 };

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const digest = (body) => crypto.createHash('sha256').update(body).digest('hex');

// The type is read from the file itself, never from the name or the browser's claim. SVG and
// other formats that can carry script are not accepted.
function imageType(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length > 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (
    bytes.length > 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  return null;
}

// { data: base64 } → { contentType, body, digest }
function parseImage(input) {
  const data = input?.data;
  if (typeof data !== 'string' || !data || data.length > Math.ceil(MAX_BYTES / 3) * 4 + 4)
    throw bad('Görsel en fazla 1,5 MB olabilir. Daha küçük bir görsel seçin.');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw bad('Görsel okunamadı. Başka bir dosya deneyin.');
  const body = Buffer.from(data, 'base64');
  if (!body.length || body.length > MAX_BYTES)
    throw bad('Görsel en fazla 1,5 MB olabilir. Daha küçük bir görsel seçin.');
  const contentType = imageType(body);
  if (!contentType) throw bad('Yalnızca JPG, PNG veya WebP görsel yüklenebilir.');
  return { contentType, body, digest: digest(body) };
}

// { texts: [{ id, text, style, color, bold, x, y, size }] } → { contentType, body, digest, texts }
// x and y are the text's top left corner in percent of the panel. The text is plain text: the
// screen writes it with textContent, never as HTML.
function parseTexts(input) {
  const list = input?.texts;
  if (!Array.isArray(list)) throw bad('Geçersiz yazı listesi.');
  if (list.length > MAX_TEXTS) throw bad(`Giriş ekranına en fazla ${MAX_TEXTS} yazı eklenebilir.`);
  const ids = new Set();
  const number = (value, min, max) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
      throw bad('Yazının yeri veya boyutu geçersiz.');
    return Math.round(value * 100) / 100;
  };
  const texts = list.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw bad('Geçersiz yazı.');
    const { id, text, style, color, bold = false } = item;
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(id) || ids.has(id)) throw bad('Geçersiz yazı.');
    ids.add(id);
    if (!TEXT_STYLES.has(style) || !TEXT_COLORS.has(color) || typeof bold !== 'boolean')
      throw bad('Geçersiz yazı biçimi.');
    const clean =
      typeof text === 'string'
        ? text
            .replace(/\r\n?/g, '\n')
            .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
            .trim()
        : '';
    if (!clean) throw bad('Boş yazı kaydedilemez. Metin girin ya da yazıyı silin.');
    if (clean.length > 300 || clean.split('\n').length > 6)
      throw bad('Bir yazı en fazla 300 karakter ve 6 satır olabilir.');
    return {
      id,
      text: clean,
      style,
      color,
      bold,
      x: number(item.x, 0, 100),
      y: number(item.y, 0, 100),
      size: number(item.size, TEXT_SIZE.min, TEXT_SIZE.max),
    };
  });
  const body = Buffer.from(JSON.stringify(texts));
  return { contentType: 'application/json', body, digest: digest(body), texts };
}

function checkKey(key) {
  if (!AUDIT[key]) throw bad('Bilinmeyen ayar.', 404);
}

const auditFor = (key, user, removed) =>
  event(user, 'changes', 'update', 'Firma Ayarları', null, [AUDIT[key][removed ? 1 : 0]]);
const author = (user) => user.name || user.username || user.id;

// PostgreSQL: one row per office and key, behind the tenant RLS policy. The audit entry is
// written in the same transaction as the change.
function postgresBranding(pool, appendAudit) {
  return {
    async get(key) {
      checkKey(key);
      return inTransaction(
        pool,
        async (db) => {
          const { rows } = await db.query(
            `SELECT content_type AS "contentType", body, digest, updated_at AS "updatedAt", updated_by AS "updatedBy"
             FROM han_private.office_branding WHERE key=$1`,
            [key],
          );
          if (!rows[0]) return null;
          return {
            ...rows[0],
            body: Buffer.from(rows[0].body),
            updatedAt: new Date(rows[0].updatedAt).toISOString(),
          };
        },
        { readOnly: true },
      );
    },
    async set(key, value, user) {
      checkKey(key);
      await inTransaction(pool, async (db) => {
        await db.query(
          `INSERT INTO han_private.office_branding(key, content_type, body, digest, updated_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, key) DO UPDATE SET content_type=excluded.content_type, body=excluded.body,
             digest=excluded.digest, updated_by=excluded.updated_by, updated_at=clock_timestamp()`,
          [key, value.contentType, value.body, value.digest, author(user)],
        );
        await appendAudit(db, [auditFor(key, user, false)]);
      });
    },
    async remove(key, user) {
      checkKey(key);
      await inTransaction(pool, async (db) => {
        const { rowCount } = await db.query('DELETE FROM han_private.office_branding WHERE key=$1', [key]);
        if (rowCount) await appendAudit(db, [auditFor(key, user, true)]);
      });
    },
  };
}

// Single state file (desktop/local use): one JSON file per key next to the state file.
function localBranding(stateFile, audit) {
  const file = (key) => path.join(path.dirname(stateFile), `office-branding-${key}.json`);
  return {
    async get(key) {
      checkKey(key);
      let saved;
      try {
        saved = JSON.parse(await fs.readFile(file(key), 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      return { ...saved, body: Buffer.from(saved.body, 'base64') };
    },
    async set(key, value, user) {
      checkKey(key);
      await fs.mkdir(path.dirname(file(key)), { recursive: true });
      const saved = {
        contentType: value.contentType,
        body: value.body.toString('base64'),
        digest: value.digest,
        updatedAt: new Date().toISOString(),
        updatedBy: author(user),
      };
      await fs.writeFile(file(key) + '.tmp', JSON.stringify(saved), { mode: 0o600 });
      await fs.rename(file(key) + '.tmp', file(key));
      await audit.appendAudit([auditFor(key, user, false)]);
    },
    async remove(key, user) {
      checkKey(key);
      try {
        await fs.unlink(file(key));
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      await audit.appendAudit([auditFor(key, user, true)]);
    },
  };
}

module.exports = {
  MAX_BYTES,
  MAX_TEXTS,
  TEXT_SIZE,
  imageType,
  parseImage,
  parseTexts,
  postgresBranding,
  localBranding,
};
