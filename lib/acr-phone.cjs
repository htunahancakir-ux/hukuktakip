const crypto = require('node:crypto');
const LIMIT = 32 * 1024 * 1024;
const fail = (status, message) => Object.assign(Error(message), { status, publicMessage: true });
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

function configuredDevices(host, raw = process.env.HAN_ACR_DEVICES) {
  let devices;
  try {
    devices = JSON.parse(raw || '[]');
  } catch {
    throw fail(503, 'ACR yapılandırması geçersiz.');
  }
  const hostname = String(host || '')
    .toLowerCase()
    .replace(/:\d+$/, '');
  return Array.isArray(devices) ? devices.filter((d) => d.host === hostname) : [];
}

function parseForm(raw, contentType) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = require('busboy')({
        headers: { 'content-type': contentType },
        defParamCharset: 'utf8',
        limits: { files: 1, fileSize: LIMIT, fields: 24, fieldSize: 16384, parts: 25, headerPairs: 100 },
      });
    } catch {
      return reject(fail(400, 'ACR formu okunamadı.'));
    }
    const values = new Map();
    let error;
    const add = (key, value) => {
      const name = key.toLowerCase();
      if (values.has(name)) error ||= fail(400, 'Tekrarlanan ACR alanı.');
      else values.set(name, value);
    };
    parser.on('field', (key, value, info) => {
      if (info.valueTruncated || info.nameTruncated) error ||= fail(413, 'ACR alanı çok büyük.');
      add(key, value);
    });
    parser.on('file', (key, stream, info) => {
      // Android may omit filename on the binary part and send it separately as file_name.
      const file = { name: info.filename || '', bytes: null };
      add(key, file);
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('limit', () => {
        error ||= fail(413, 'ACR ses dosyası çok büyük.');
      });
      stream.on('error', () => {
        error ||= fail(400, 'ACR ses dosyası okunamadı.');
      });
      stream.on('end', () => {
        file.bytes = Buffer.concat(chunks);
      });
    });
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit'])
      parser.on(event, () => {
        error ||= fail(413, 'ACR form alanı sınırı aşıldı.');
      });
    parser.on('error', () => reject(fail(400, 'ACR formu okunamadı.')));
    parser.on('close', () => (error ? reject(error) : resolve(values)));
    parser.end(raw);
  });
}

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
function createReceiver({
  readBody,
  recordings,
  persist,
  onReport,
  devices = () => process.env.HAN_ACR_DEVICES,
}) {
  let active = 0;
  let windowStart = 0;
  let attempts = 0;
  return async (req, res) => {
    const host = String(req.headers.host || '')
      .toLowerCase()
      .replace(/:\d+$/, '');
    const candidates = configuredDevices(host, devices());
    if (!candidates.length) throw fail(404, 'ACR bağlantısı bu büroda etkin değil.');
    if (req.method !== 'POST') throw fail(405, 'Yalnızca POST desteklenir.');
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      attempts = 0;
    }
    if (++attempts > 60 || active >= 2) throw fail(429, 'ACR yükleme sınırı; daha sonra tekrar deneyin.');
    const limit = onReport ? 64 * 1024 : LIMIT;
    if (Number(req.headers['content-length'] || 0) > limit)
      throw fail(
        413,
        onReport ? 'ACR çağrı raporu en fazla 64 KiB olabilir.' : 'ACR yüklemesi en fazla 32 MiB olabilir.',
      );
    const contentType = String(req.headers['content-type'] || '');
    if (
      !/^multipart\/form-data\s*;/i.test(contentType) &&
      !(onReport && /^application\/x-www-form-urlencoded(?:;|$)/i.test(contentType))
    )
      throw fail(415, 'Form verisi gerekli.');
    active++;
    try {
      const raw = await readBody(req, limit);
      const values = await parseForm(raw, contentType);
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
      if (onReport) {
        // Reports contain call metadata only. Never retain credentials in the call body.
        const fields = Object.fromEntries(
          [...values].filter(
            ([key, value]) =>
              typeof value === 'string' && !/secret|password|token|authorization|api.?key/i.test(key),
          ),
        );
        const call = callFromReport(fields, device, host);
        if (!call) return send({ ready: true, accepted: false });
        await onReport(call);
        console.info('ACR call report received', {
          deviceId: device.id,
          id: call.id,
          fields: Object.keys(fields),
        });
        return send({ accepted: true, id: call.id, phoneReceived: !!call.phone });
      }
      const file = values.get('file');
      const declaredName = text('file_name') || text('filename');
      if (file === undefined && !declaredName) {
        console.info('ACR connection check', { deviceId: device.id });
        return send({ ready: true, accepted: false, recordingReceived: false });
      }
      if (!file || !Buffer.isBuffer(file.bytes) || !file.bytes.length)
        throw fail(400, 'Ses dosyası alınamadı. Kaydı ACR yükleme kuyruğundan yeniden gönderin.');
      if (!recordings?.available) throw fail(503, 'Kalıcı görüşme arşivi hazır değil.');
      const bytes = file.bytes;
      const format = audioType(bytes);
      const source = text('source', 256);
      const fileName = String(declaredName || file.name)
        .replace(/[\\/\u0000-\u001f]/g, '_')
        .slice(0, 240);
      const stamp = text('date', 24);
      const numericDate = Number(stamp);
      const dateMs = stamp ? (numericDate > 1e12 ? numericDate : numericDate * 1000) : Date.now();
      if (!Number.isFinite(dateMs) || dateMs < Date.UTC(2000, 0, 1) || dateMs > Date.now() + 86400000)
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
      // source is the Android package name (com.nll.cb), never a caller ID.
      // file_name can be an Android media-store ID and must not be guessed as a phone number.
      const phone = require('./voip.cjs').number(
        text('phonenumber') || text('phone_number') || text('number'),
      );
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
        callerNumber: phone,
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
        acrRecordingDateVerified: !!stamp,
        acrSource: source,
        acrFileName: fileName,
      };
      // Persist the encrypted object first. A failed database commit remains safe to retry.
      await recordings.save(id, bytes);
      await persist(call);
      console.info('ACR recording received', { deviceId: device.id, id, bytes: bytes.length });
      return send({ accepted: true, id });
    } finally {
      active--;
    }
  };
}

function callFromReport(fields, device, host) {
  const canonical = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key.replace(/[^a-z0-9]/gi, '').toLowerCase(), value]),
  );
  const pick = (...keys) =>
    keys.map((key) => canonical[key]).find((value) => value !== undefined && value !== '') || '';
  const phone = require('./voip.cjs').number(pick('phonenumber', 'number', 'remotenumber', 'callnumber'));
  const stamp = pick('date', 'calldate', 'timestamp', 'starttime', 'callstarttime');
  const clientId = pick('callid', 'recordingid');
  const type = String(pick('calltype', 'type', 'direction')).toLowerCase();
  // ACR checks the URL with no call. Do not invent a call for that request.
  if (!phone && !stamp && !clientId) return null;
  // The native connection test can send a date and literal placeholders (e.g. 1%7C2).
  if (
    !phone &&
    !clientId &&
    ![
      '1',
      '2',
      '3',
      '5',
      '6',
      'incoming',
      'inbound',
      'outgoing',
      'outbound',
      'missed',
      'rejected',
      'blocked',
    ].includes(type)
  )
    return null;
  const value = Number(stamp);
  const time = stamp && Number.isFinite(value) ? (value > 1e12 ? value : value * 1000) : NaN;
  const validTime = Number.isFinite(time) && time >= Date.UTC(2000, 0, 1) && time <= Date.now() + 86400000;
  const receivedAt = new Date().toISOString();
  const hash = digest(
    JSON.stringify([
      'acr-report',
      host,
      device.id,
      Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)),
    ]),
  );
  const id = [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
  const direction = ['2', 'outgoing', 'outbound'].includes(type)
    ? 'outbound'
    : ['1', '3', '5', '6', 'incoming', 'inbound', 'missed', 'rejected', 'blocked'].includes(type)
      ? 'inbound'
      : 'acr';
  const missed = ['3', '5', '6', 'missed', 'rejected', 'blocked'].includes(type);
  const milliseconds = Number(pick('durationms', 'durationmilliseconds'));
  // Verified on real ACR Phone reports: Date is milliseconds and Duration is seconds.
  const seconds = Number(pick('durationseconds', 'duration'));
  const rawDuration = milliseconds ? Math.floor(milliseconds / 1000) : seconds;
  const duration =
    Number.isFinite(rawDuration) && rawDuration >= 0 && rawDuration <= 7 * 86400 ? rawDuration : 0;
  return {
    id,
    provider: 'acr',
    providerId: 'acr-report:' + hash,
    requestId: 'acr-report:' + hash,
    direction,
    documentId: '',
    documentNumber: '',
    clientName: '',
    debtorName: '',
    phone,
    callerNumber: phone,
    userId: '',
    staffName: device.label || 'ACR Telefon',
    createdAt: validTime ? new Date(time).toISOString() : receivedAt,
    status: missed ? 'unanswered' : 'reported',
    duration,
    result: '',
    note: '',
    recordingPresent: false,
    recordingMissing: true,
    acrDeviceId: device.id,
    acrReport: fields,
    acrReportReceivedAt: receivedAt,
    acrReportClientId: clientId,
    acrReportDateVerified: validTime,
  };
}

// Keep the recording UUID and encrypted object intact. Match only one unique report/audio
// pair from the same device, exact start second and compatible duration; never use arrival
// order, a nearby time window, Android media IDs, or an unverified fallback timestamp.
function mergeReports(calls) {
  const reports = calls.filter(
    (c) =>
      c.provider === 'acr' &&
      c.acrReport &&
      !c.recordingPresent &&
      c.acrReportDateVerified &&
      c.phone &&
      c.duration > 0 &&
      c.status === 'reported' &&
      !c.documentId &&
      !c.note &&
      !c.result &&
      !c.draftNote,
  );
  const recordings = calls.filter(
    (c) => c.provider === 'acr' && c.recordingPresent && c.acrRecordingDateVerified && !c.acrReportId,
  );
  const matches = (audio, report) =>
    audio.acrDeviceId === report.acrDeviceId &&
    Math.floor(Date.parse(audio.createdAt) / 1000) === Math.floor(Date.parse(report.createdAt) / 1000) &&
    Number.isFinite(audio.duration) &&
    Math.abs(audio.duration - report.duration) <= 1 &&
    (!audio.phone || audio.phone === report.phone);
  const merged = new Set();
  for (const report of reports) {
    const candidates = recordings.filter((audio) => matches(audio, report));
    if (candidates.length !== 1 || reports.filter((r) => matches(candidates[0], r)).length !== 1) continue;
    const audio = candidates[0];
    Object.assign(audio, {
      phone: report.phone,
      callerNumber: report.phone,
      direction: report.direction,
      acrReportId: report.id,
      acrReport: report.acrReport,
      acrReportReceivedAt: report.acrReportReceivedAt,
      acrReportClientId: report.acrReportClientId,
      acrReportDateVerified: true,
    });
    merged.add(report.id);
  }
  if (!merged.size) return false;
  for (let i = calls.length - 1; i >= 0; i--) if (merged.has(calls[i].id)) calls.splice(i, 1);
  return true;
}
module.exports = { createReceiver, audioType, configuredDevices, callFromReport, mergeReports };
