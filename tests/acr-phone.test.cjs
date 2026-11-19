const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { createApplication } = require('../lib/application.cjs');
const { createVoipHandler } = require('../lib/voip.cjs');
const { createRecordingStore } = require('../lib/voip-recordings.cjs');
const { database, fixture } = require('./support/postgres.cjs');
const { importState } = require('../lib/postgres-store.cjs');
const { transaction } = require('../lib/voip-store.cjs');
const secret = 'synthetic-acr-secret-for-tests-only-123456';
const host = 'office.example.test';
const device = {
  id: 'phone-1',
  label: 'ACR Telefon 1',
  host,
  secretHash: crypto.createHash('sha256').update(secret).digest('hex'),
};

function response() {
  const chunks = [];
  const res = new Writable({
    write(chunk, encoding, next) {
      chunks.push(Buffer.from(chunk));
      next();
    },
  });
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (key, value) => {
    res.headers[key.toLowerCase()] = value;
  };
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  };
  res.bytes = () => Buffer.concat(chunks);
  return res;
}
function wav() {
  const b = Buffer.alloc(2044);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(2000, 40);
  return b;
}
async function request({
  code = secret,
  hostname = host,
  bytes = wav(),
  date = '1795089600',
  probe = false,
  metadataOnly = false,
  declaredName,
  withoutBinaryFilename = false,
} = {}) {
  const form = new FormData();
  form.set('Secret', code);
  form.set('Source', 'ACR Phone');
  if (date !== null) form.set('Date', date);
  form.set('Duration', '1000');
  if (declaredName !== undefined) form.set('file_name', declaredName);
  if (probe) form.set('Test', '1');
  else if (!metadataOnly)
    form.set('File', new Blob([bytes], { type: 'application/octet-stream' }), 'recording.wav');
  const upload = new Request('https://' + hostname + '/api/voip/acr-upload', { method: 'POST', body: form });
  let raw = Buffer.from(await upload.arrayBuffer());
  if (withoutBinaryFilename) {
    const header = Buffer.from('; filename="recording.wav"');
    const position = raw.indexOf(header);
    assert.ok(position > 0);
    raw = Buffer.concat([raw.subarray(0, position), raw.subarray(position + header.length)]);
  }
  return {
    method: 'POST',
    url: '/api/voip/acr-upload',
    headers: {
      host: hostname,
      'content-type': upload.headers.get('content-type'),
      'content-length': String(raw.length),
    },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield raw;
    },
  };
}

test('ACR upload uses the body secret, office restriction, private encrypted archive and authenticated media', async (t) => {
  const old = { devices: process.env.HAN_ACR_DEVICES, key: process.env.VOIP_ENCRYPTION_KEY };
  process.env.HAN_ACR_DEVICES = JSON.stringify([device]);
  process.env.VOIP_ENCRYPTION_KEY = 'ab'.repeat(32);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'han-acr-'));
  t.after(async () => {
    for (const [key, value] of [
      ['HAN_ACR_DEVICES', old.devices],
      ['VOIP_ENCRYPTION_KEY', old.key],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const recordings = createRecordingStore({ cloud: false, directory: dir });
  const state = {
    voipCalls: [],
    voipConfig: {},
    voipGrants: [],
    data: { 'icrapro-v1': { docs: [], clients: [] } },
  };
  let signedIn = false;
  const handle = createVoipHandler({
    transaction: (work) => work({ state, saveState() {} }),
    recordings,
    authenticatedUser: async () => {
      if (!signedIn) throw Object.assign(Error('Sign in'), { status: 401 });
      return { id: 'ceo', role: 'ceo' };
    },
    readBody: async (req, max) => {
      const chunks = [];
      let total = 0;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > max) throw Object.assign(Error('Large'), { status: 413 });
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
  });
  const run = async (options) => {
    const req = await request(options);
    const res = response();
    await handle(req, res, new URL(req.url, 'https://' + host));
    return res;
  };
  await assert.rejects(run({ code: '' }), { status: 401 });
  await assert.rejects(run({ code: 'x'.repeat(40) }), { status: 401 });
  await assert.rejects(run({ hostname: 'other.example.test' }), { status: 404 });
  await assert.rejects(run({ bytes: Buffer.from('<html>not audio</html>') }), { status: 415 });
  await assert.rejects(run({ date: 'bad' }), { status: 400 });
  const probe = await run({ probe: true });
  assert.equal(probe.statusCode, 200);
  const nativeCheck = await run({ metadataOnly: true });
  assert.equal(nativeCheck.statusCode, 200, 'ACR connection check need not contain the custom Test flag');
  assert.deepEqual(JSON.parse(nativeCheck.bytes()), {
    ready: true,
    accepted: false,
    recordingReceived: false,
  });
  await assert.rejects(run({ metadataOnly: true, code: 'wrong-native-check-code-0000000000000' }), {
    status: 401,
  });
  await assert.rejects(run({ metadataOnly: true, declaredName: 'missing.wav' }), { status: 400 });
  await assert.rejects(run({ bytes: Buffer.alloc(0) }), { status: 400 });
  assert.equal(state.voipCalls.length, 0);
  const uploaded = await run();
  const { id } = JSON.parse(uploaded.bytes());
  assert.equal(state.voipCalls.length, 1);
  assert.equal(state.voipCalls[0].provider, 'acr');
  assert.equal(state.voipCalls[0].duration, 1);
  assert.deepEqual(await recordings.read(id), wav());
  const encrypted = await fs.readFile(path.join(dir, 'gorusme-kayitlari', id + '.enc'));
  assert.notDeepEqual(encrypted, wav());
  await run();
  assert.equal(state.voipCalls.length, 1, 'retries must not duplicate the call');
  const media = { method: 'GET', headers: {}, url: '/api/voip/media?id=' + id };
  await assert.rejects(handle(media, response(), new URL(media.url, 'https://' + host)), { status: 401 });
  signedIn = true;
  const playback = response();
  await handle(media, playback, new URL(media.url, 'https://' + host));
  assert.equal(playback.headers['content-type'], 'audio/wav');
  assert.match(playback.headers['content-disposition'], /\.wav/);
  assert.deepEqual(playback.bytes(), wav());
  const nativeUpload = await run({
    withoutBinaryFilename: true,
    declaredName: 'native-recording.wav',
    date: null,
  });
  const nativeId = JSON.parse(nativeUpload.bytes()).id;
  assert.equal(state.voipCalls.length, 2);
  assert.equal(state.voipCalls[1].acrFileName, 'native-recording.wav');
  assert.deepEqual(
    await recordings.read(nativeId),
    wav(),
    'octet-stream bytes survive even without a filename on the file part',
  );
  await run({ withoutBinaryFilename: true, declaredName: 'native-recording.wav', date: null });
  assert.equal(state.voipCalls.length, 2, 'omitting optional Date does not duplicate retries');
  const { pg, pool } = await database();
  try {
    await importState(pool, fixture());
    await transaction(
      pool,
      false,
      (tx) => {
        tx.state.voipCalls.push(state.voipCalls[0]);
        tx.saveState(tx.state);
      },
      { id },
    );
    const stored = await transaction(pool, false, (tx) => tx.state.voipCalls[0], { id });
    assert.equal(stored.recordingContentType, 'audio/wav');
    assert.equal(stored.provider, 'acr');
  } finally {
    await pg.close();
  }
});

test('ACR can authenticate before browser CSRF checks, while ordinary mutations still require their source', async () => {
  const previous = process.env.HAN_ACR_DEVICES;
  process.env.HAN_ACR_DEVICES = JSON.stringify([device]);
  try {
    const app = createApplication({ cloud: true, appOrigin: 'https://' + host });
    const res = response();
    await app(await request({ probe: true }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.bytes()), { ready: true });
    const denied = response();
    await app({ method: 'POST', url: '/api/voip/config', headers: { host }, socket: {} }, denied);
    assert.equal(denied.statusCode, 403);
  } finally {
    if (previous === undefined) delete process.env.HAN_ACR_DEVICES;
    else process.env.HAN_ACR_DEVICES = previous;
  }
});
