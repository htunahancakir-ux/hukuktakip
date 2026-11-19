const crypto = require('node:crypto');
const LIMIT = 32 * 1024 * 1024;
const fail = (status, message) => Object.assign(Error(message), { status, publicMessage: true });
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

function audioType(bytes) {
  if (bytes.length < 12) throw fail(400, 'Ses dosyası geçersiz.');
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE')
    return { contentType: 'audio/wav', extension: 'wav' };
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return { contentType: 'audio/mp4', extension: 'm4a' };
  if (bytes.toString('ascii', 0, 4) === 'OggS') return { contentType: 'audio/ogg', extension: 'ogg' };
  if (bytes[0] === 255 && (bytes[1] & 246) === 240) return { contentType: 'audio/aac', extension: 'aac' };
  if (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224))
    return { contentType: 'audio/mpeg', extension: 'mp3' };
  throw fail(415, 'Desteklenen ses biçimleri: WAV, M4A, OGG, AAC ve MP3.');
}

// ACR's Secret is a form field, not a URL query parameter. Only hashes are configured.
// Each device is restricted to one office host and cannot read or delete any recording.
function createReceiver({ readBody, recordings, persist, devices = () => process.env.HAN_ACR_DEVICES }) {
  let active = 0;
  let windowStart = 0;
  let attempts = 0;
  return async (req, res) => {
    let configured;
    try {
      configured = JSON.parse(devices() || '[]');
    } catch {
      throw fail(503, 'ACR yapılandırması geçersiz.');
    }
    const host = String(req.headers.host || '')
      .toLowerCase()
      .replace(/:\d+$/, '');
    const candidates = Array.isArray(configured) ? configured.filter((d) => d.host === host) : [];
    if (!candidates.length) throw fail(404, 'ACR bağlantısı bu büroda etkin değil.');
    if (req.method !== 'POST') throw fail(405, 'Yalnızca POST desteklenir.');
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      attempts = 0;
    }
    if (++attempts > 60 || active >= 2) throw fail(429, 'ACR yükleme sınırı; daha sonra tekrar deneyin.');
    if (Number(req.headers['content-length'] || 0) > LIMIT)
      throw fail(413, 'ACR yüklemesi en fazla 32 MiB olabilir.');
    const contentType = String(req.headers['content-type'] || '');
    if (!/^multipart\/form-data\s*;/i.test(contentType)) throw fail(415, 'Multipart form verisi gerekli.');
    active++;
    try {
      const raw = await readBody(req, LIMIT);
      let form;
      try {
        form = await new Response(raw, { headers: { 'Content-Type': contentType } }).formData();
      } catch {
        throw fail(400, 'ACR formu okunamadı.');
      }
      const values = new Map();
      for (const [key, value] of form) {
        const lower = key.toLowerCase();
        if (values.has(lower)) throw fail(400, 'Tekrarlanan ACR alanı.');
        values.set(lower, value);
      }
      const text = (key, max = 256) => {
        const value = values.get(key);
        if (value === undefined) return '';
        if (typeof value !== 'string' || value.length > max) throw fail(400, 'Geçersiz ACR alanı.');
        return value;
      };
      const secret = text('secret');
      const actual = Buffer.from(digest(secret), 'hex');
      const device =
        secret.length >= 32 &&
        candidates.find(
          (d) =>
            /^[a-f0-9]{64}$/.test(d.secretHash || '') &&
            crypto.timingSafeEqual(actual, Buffer.from(d.secretHash, 'hex')),
        );
      if (!device) throw fail(401, 'ACR gizli kodu geçersiz.');
      const send = (data) => {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(data));
      };
      // A credential check does not create a synthetic call in the office's history.
      if (text('test') === '1') return send({ ready: true });
      if (!recordings?.available) throw fail(503, 'Kalıcı görüşme arşivi hazır değil.');
      const file = values.get('file');
      if (!file || typeof file.arrayBuffer !== 'function' || !file.size)
        throw fail(400, 'Ses dosyası gerekli. Arama geçmişi aktarımı ayrıca yapılandırılır.');
      const bytes = Buffer.from(await file.arrayBuffer());
      const format = audioType(bytes);
      const source = text('source', 256);
      const fileName = String(file.name || text('filename'))
        .replace(/[\\/\u0000-\u001f]/g, '_')
        .slice(0, 240);
      const stamp = text('date', 24);
      const numericDate = Number(stamp);
      const dateMs = numericDate > 1e12 ? numericDate : numericDate * 1000;
      if (
        !stamp ||
        !Number.isFinite(dateMs) ||
        dateMs < Date.UTC(2000, 0, 1) ||
        dateMs > Date.now() + 86400000
      )
        throw fail(400, 'ACR kayıt tarihi geçersiz.');
      const duration = Number(text('duration', 24) || 0);
      if (!Number.isFinite(duration) || duration < 0 || duration > 7 * 86400000)
        throw fail(400, 'ACR kayıt süresi geçersiz.');
      const sha256 = digest(bytes);
      const hash = digest(JSON.stringify([host, device.id, source, fileName, stamp, sha256]));
      const id = [
        hash.slice(0, 8),
        hash.slice(8, 12),
        hash.slice(12, 16),
        hash.slice(16, 20),
        hash.slice(20, 32),
      ].join('-');
      const phone = require('./voip.cjs').number(text('phonenumber') || text('number') || source);
      const createdAt = new Date(dateMs).toISOString();
      const retainUntil = new Date(dateMs);
      retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + 5);
      const call = {
        id,
        provider: 'acr',
        providerId: 'acr:' + hash,
        requestId: 'acr:' + hash,
        direction: 'acr',
        documentId: '',
        documentNumber: '',
        clientName: '',
        debtorName: '',
        phone,
        callerNumber: phone || source.slice(0, 80),
        userId: '',
        staffName: device.label || 'ACR Telefon',
        createdAt,
        endedAt: new Date(dateMs + duration).toISOString(),
        status: 'completed',
        duration: Math.floor(duration / 1000),
        result: '',
        note: text('note', 4000),
        recordingPresent: true,
        archivedAt: new Date().toISOString(),
        retainUntil: retainUntil.toISOString(),
        recordingBytes: bytes.length,
        recordingSha256: sha256,
        recordingContentType: format.contentType,
        recordingExtension: format.extension,
        acrDeviceId: device.id,
        acrSource: source,
        acrFileName: fileName,
      };
      // Persist the encrypted object first. A failed database commit remains safe to retry.
      await recordings.save(id, bytes);
      await persist(call);
      return send({ accepted: true, id });
    } finally {
      active--;
    }
  };
}
module.exports = { createReceiver, audioType };
