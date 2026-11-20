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
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
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
  duration = '3000',
  probe = false,
  metadataOnly = false,
  declaredName,
  withoutBinaryFilename = false,
} = {}) {
  const form = new FormData();
  form.set('Secret', code);
  form.set('Source', 'com.nll.cb');
  if (date !== null) form.set('Date', date);
  if (duration !== null) form.set('Duration', duration);
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

async function reportRequest(fields = {}, { hostname = host, multipart = false } = {}) {
  const form = multipart ? new FormData() : new URLSearchParams();
  for (const [key, value] of Object.entries({ secret, source: 'com.nll.cb', ...fields }))
    form.set(key, value);
  const upload = new Request('https://' + hostname + '/api/voip/acr-report', { method: 'POST', body: form });
  const raw = Buffer.from(await upload.arrayBuffer());
  return {
    method: 'POST',
    url: '/api/voip/acr-report',
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

test('ACR call reports persist the dialed number, reject wrong credentials and do not pretend to contain audio', async (t) => {
  const previous = process.env.HAN_ACR_DEVICES;
  process.env.HAN_ACR_DEVICES = JSON.stringify([device]);
  t.after(() => {
    if (previous === undefined) delete process.env.HAN_ACR_DEVICES;
    else process.env.HAN_ACR_DEVICES = previous;
  });
  const { pg, pool } = await database();
  t.after(() => pg.close());
  await importState(pool, fixture());
  await transaction(
    pool,
    false,
    (tx) => {
      tx.state.voipConfig.acrDevices = {
        [device.id]: { label: 'Ofis telefonu', userId: 'test-ceo', userName: 'Test' },
      };
      tx.saveState(tx.state);
    },
    { configWrite: true },
  );
  let signedIn = false;
  const handle = createVoipHandler({
    transaction: (work, scope) => transaction(pool, false, work, scope),
    recordings: { available: true, save: async () => {}, read: async () => wav() },
    authenticatedUser: async () => {
      if (!signedIn) throw Object.assign(Error('Sign in'), { status: 401 });
      return { id: 'test-ceo', role: 'ceo' };
    },
    readBody: async (req, max) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      assert.ok(raw.length <= max);
      return raw;
    },
  });
  const run = async (fields, options) => {
    const req = await reportRequest(fields, options);
    const res = response();
    await handle(req, res, new URL(req.url, 'https://' + host));
    return JSON.parse(res.bytes());
  };
  await assert.rejects(run({ secret: 'incorrect-reporting-secret-0000000000' }), { status: 401 });
  await assert.rejects(run({}, { hostname: 'other.example.test' }), { status: 404 });
  assert.deepEqual(await run(), { ready: true, accepted: false });
  assert.deepEqual(await run({ test: '1', number: '05320000001' }), { ready: true });
  const fields = {
    phone_number: '+90 (532) 000 00 01',
    call_date: '1795089600000',
    call_type: '2',
    duration_seconds: '43',
    password: 'never-store',
    api_key: 'never-store',
  };
  const result = await run(fields);
  assert.equal(result.phoneReceived, true);
  const stored = await transaction(pool, false, (tx) => tx.state.voipCalls[0], { id: result.id });
  assert.equal(stored.phone, '905320000001');
  assert.equal(stored.callerNumber, stored.phone);
  assert.equal(stored.direction, 'outbound');
  assert.equal(stored.duration, 43);
  assert.equal(stored.createdAt, new Date(1795089600000).toISOString());
  assert.equal(stored.status, 'reported');
  assert.equal(stored.recordingPresent, false);
  assert.equal(stored.recordingMissing, true);
  assert.equal(stored.staffName, 'Test');
  assert.equal(stored.userId, 'test-ceo');
  assert.ok(!JSON.stringify(stored).includes('never-store'));
  assert.ok(!JSON.stringify(stored).includes(secret));
  assert.equal((await run(fields, { multipart: true })).id, result.id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM han_private.voip_calls')).rows[0].n, 1);
  assert.equal(
    (await transaction(pool, false, (tx) => tx.state.voipCalls, { jobs: true })).length,
    0,
    'metadata reports do not become archive jobs',
  );
  const missed = await run({ number: '05320000002', date: '1795089700', type: '3', duration_ms: 'invalid' });
  const incoming = await transaction(pool, false, (tx) => tx.state.voipCalls[0], { id: missed.id });
  assert.equal(incoming.status, 'unanswered');
  assert.equal(incoming.direction, 'inbound');
  assert.equal(incoming.duration, 0);
  await transaction(
    pool,
    false,
    (tx) => {
      const legacy = tx.state.voipCalls[0];
      legacy.phone = '';
      legacy.callerNumber = '';
      legacy.duration = 0;
      tx.saveState(tx.state);
    },
    { id: result.id, acr: { deviceId: device.id, createdAt: stored.createdAt } },
  );
  await run(fields);
  const reparsed = await transaction(pool, false, (tx) => tx.state.voipCalls[0], { id: result.id });
  assert.equal(reparsed.phone, stored.phone, 'replaying the existing receipt repairs legacy normalization');
  assert.equal(reparsed.duration, 43);
  assert.deepEqual(
    await run({ number: 'number', direction: '1%7C2', date: '1795086960283', duration: '0' }),
    { ready: true, accepted: false },
  );
  const upload = async (options) => {
    const req = await request(options);
    const res = response();
    await handle(req, res, new URL(req.url, 'https://' + host));
    return JSON.parse(res.bytes());
  };
  const audio = await upload({ duration: '3000' });
  const merged = await transaction(pool, false, (tx) => tx.state.voipCalls[0], { id: audio.id });
  assert.equal(merged.phone, stored.phone);
  assert.equal(merged.acrReportId, result.id);
  assert.equal(merged.status, 'completed');
  assert.equal(merged.duration, 43);
  assert.equal(merged.recordingDuration, 3);
  assert.equal(merged.recordingPresent, true);
  assert.equal(merged.recordingMissing, undefined);
  assert.equal(merged.userId, 'test-ceo');
  assert.equal(
    (await pool.query('SELECT phone FROM han_private.voip_calls WHERE id=$1', [audio.id])).rows[0].phone,
    stored.phone,
    'indexed phone follows the merged call body',
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM han_private.voip_calls WHERE id=$1', [result.id]))
      .rows[0].n,
    0,
    'the report is retained inside the audio row',
  );
  await run(fields);
  await upload({ duration: '3000' });
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM han_private.voip_calls')).rows[0].n,
    2,
    'retries must not recreate the merged report',
  );
  const audioFirst = await upload({ date: '1795089800', duration: '3500' });
  const later = await run({
    number: '%2B90+532+000+00+03',
    date: '1795089800699',
    direction: '1',
    duration: '120',
  });
  const matched = await transaction(pool, false, (tx) => tx.state.voipCalls[0], { id: audioFirst.id });
  assert.equal(matched.phone, '905320000003');
  assert.equal(matched.direction, 'inbound');
  assert.equal(matched.acrReportId, later.id);
  assert.equal(matched.duration, 120);
  assert.equal(matched.recordingDuration, 3.5);
  signedIn = true;
  const playback = response();
  const media = { method: 'GET', headers: {}, url: '/api/voip/media?id=' + audioFirst.id };
  await handle(media, playback, new URL(media.url, 'https://' + host));
  assert.equal(playback.headers['content-type'], 'audio/wav');
  assert.deepEqual(
    playback.bytes(),
    wav(),
    'the retained recording UUID still plays through authenticated media',
  );
});

test('ACR pairing rejects ambiguous, unverified, edited and different-device calls', () => {
  const { mergeReports, callFromReport } = require('../lib/acr-phone.cjs');
  assert.equal(callFromReport({ number: '%GG', direction: '1', date: '1795089800' }, device, host).phone, '');
  const audio = {
    id: 'audio',
    provider: 'acr',
    acrDeviceId: 'one',
    createdAt: '2026-11-19T12:55:32.000Z',
    duration: 9,
    recordingPresent: true,
    acrRecordingDateVerified: true,
    phone: '',
    recordingSha256: 'keep-audio-hash',
    archivedAt: 'keep-archive',
  };
  const report = {
    id: 'report',
    provider: 'acr',
    acrDeviceId: 'one',
    createdAt: '2026-11-19T12:55:32.699Z',
    duration: 10,
    recordingPresent: false,
    acrReportDateVerified: true,
    phone: '905320000001',
    status: 'reported',
    direction: 'outbound',
    acrReport: { number: '05320000001' },
  };
  for (const change of [
    { acrDeviceId: 'two' },
    { createdAt: '2026-11-19T12:55:33.000Z' },
    { phone: '' },
    { acrReportDateVerified: false },
    { note: 'User wrote this' },
    { documentId: 'assigned-file' },
  ]) {
    const calls = [structuredClone(audio), { ...structuredClone(report), ...change }];
    assert.equal(mergeReports(calls), false);
    assert.equal(calls.length, 2);
  }
  const fallback = [{ ...audio, acrRecordingDateVerified: false }, report];
  assert.equal(mergeReports(fallback), false);
  for (const extra of [
    { ...report, id: 'report-two', phone: '905320000002' },
    { ...audio, id: 'audio-two' },
  ]) {
    const calls = structuredClone([audio, report, extra]);
    assert.equal(mergeReports(calls), false);
    assert.equal(calls.length, 3);
  }
  const calls = structuredClone([audio, report]);
  assert.equal(mergeReports(calls), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'audio');
  assert.equal(calls[0].recordingSha256, audio.recordingSha256);
  assert.equal(calls[0].archivedAt, audio.archivedAt);
  assert.equal(calls[0].phone, report.phone);
  assert.equal(calls[0].duration, 10);
  assert.equal(calls[0].recordingDuration, 9);
  const conflict = [{ ...audio, phone: '905320000002' }, report];
  assert.equal(mergeReports(conflict), false);
  const short = structuredClone([
    { ...audio, duration: 1, endedAt: '2026-11-19T12:55:33.695Z' },
    { ...report, duration: 347 },
  ]);
  assert.equal(mergeReports(short), true);
  assert.equal(short.length, 1);
  assert.equal(short[0].duration, 347);
  assert.equal(short[0].recordingDuration, 1.695);
  assert.equal(short[0].recordingPresent, false);
  assert.equal(short[0].recordingSuppressed, 'too_short');
});

test('ACR dials match outgoing reports to the chosen card and keep the link when audio arrives', async (t) => {
  const oldDevices = process.env.HAN_ACR_DEVICES;
  process.env.HAN_ACR_DEVICES = JSON.stringify([device]);
  const { pg, pool } = await database();
  t.after(async () => {
    if (oldDevices === undefined) delete process.env.HAN_ACR_DEVICES;
    else process.env.HAN_ACR_DEVICES = oldDevices;
    await pg.close();
  });
  const state = fixture();
  state.voipConfig = { acrDevices: { [device.id]: { userId: 'test-ceo', label: 'Telefon' } } };
  state.data['icrapro-v1'].clients = [
    { id: 'first', name: 'Birinci', phone: '05320000001' },
    { id: 'second', name: 'İkinci', phone: '05320000001' },
  ];
  state.data['icrapro-v1'].docs = [
    {
      id: 'folio',
      client: 'first',
      number: 'D-1',
      debtor: 'Borçlu',
      phone1: '05320000002',
      phone2: '05320000005',
      inactivePhones: ['5320000005'],
    },
  ];
  state.data['icrapro-personnel-v1'] = [
    { id: 'staff-card', name: 'Personel', phone: '02120000001', mobilePhone: '05320000006' },
  ];
  await importState(pool, state);
  await importRecords(pool);
  await activateRecords(pool);
  let actor = { id: 'test-ceo', name: 'Test', role: 'ceo' };
  const handle = createVoipHandler({
    transaction: (work, scope) => transaction(pool, true, work, scope),
    recordings: { available: true, save: async () => {} },
    authenticatedUser: async () => ({ ...actor }),
    readBody: async (req) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return Buffer.concat(chunks);
    },
  });
  const run = async (req) => {
    const res = response();
    await handle(req, res, new URL(req.url, 'https://' + host));
    return JSON.parse(res.bytes());
  };
  const api = (route, input, headers = {}) =>
    run({
      url: '/api/voip/' + route,
      method: input ? 'POST' : 'GET',
      headers: { host, 'content-type': 'application/json', ...headers },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(input));
      },
    });
  const destination = { deviceId: device.id, cardType: 'client', cardId: 'second', phone: '05320000001' };
  assert.deepEqual(
    (await api('calls?cardType=personnel&cardId=staff-card')).phones.map((p) => p.phone),
    ['905320000006', '902120000001'],
  );
  await assert.rejects(api('acr-dials', { ...destination, phone: '05320000003' }), { status: 400 });
  const { dial } = await api('acr-dials', destination);
  assert.equal(
    (await api('acr-dials', destination)).dial.id,
    dial.id,
    'queue retries reuse the existing request',
  );
  assert.deepEqual(
    (await api('acr-dials')).dials.map((row) => row.id),
    [dial.id],
  );
  actor = { id: 'another-user', role: 'staff' };
  assert.deepEqual((await api('acr-dials')).dials, []);
  await assert.rejects(api('acr-dials', { dialId: dial.id }), { status: 409 });
  await assert.rejects(api('calls?cardType=client&cardId=second'), { status: 403 });
  actor = { id: 'test-ceo', role: 'ceo' };
  const { dial: ready } = await api('acr-dials', { dialId: dial.id });
  assert.ok(ready.readyUntil);
  const { dial: competing } = await api('acr-dials', { ...destination, cardId: 'first' });
  await assert.rejects(api('acr-dials', { dialId: competing.id }), { status: 409 });
  const date = Math.floor(Date.now() / 1000) + 2;
  const report = { number: destination.phone, date: String(date * 1000), direction: '2', duration: '9' };
  await run(await reportRequest({ ...report, direction: '1', date: String((date - 1) * 1000) }));
  assert.equal((await api('calls?cardType=client&cardId=second')).calls.length, 0);
  const { id: reportId } = await run(await reportRequest(report));
  const history = () => api('calls?cardType=client&cardId=second');
  assert.equal((await history()).calls[0].id, reportId);
  const { id: audioId } = await run(await request({ date: String(date), duration: '9000' }));
  await run(await reportRequest(report));
  const { calls } = await history();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, audioId);
  assert.equal(calls[0].cardId, 'second');
  assert.equal(calls[0].cardName, 'İkinci');
  assert.equal(calls[0].provider, 'acr');
  assert.equal(calls[0].recordingPresent, true);
  assert.equal((await api('calls?cardType=client&cardId=first')).calls.length, 0);
  assert.deepEqual(
    (await api('acr-dials')).dials.map((row) => row.id),
    [competing.id],
  );

  await assert.rejects(
    api('acr-dials', {
      deviceId: device.id,
      documentId: 'folio',
      phone: '05320000005',
    }),
    { status: 400 },
  );
  const { dial: docDial } = await api('acr-dials', {
    deviceId: device.id,
    documentId: 'folio',
    phone: '05320000002',
  });
  await api('acr-dials', { dialId: docDial.id });
  const docDate = date + 2;
  const { id: docAudio } = await run(await request({ date: String(docDate), duration: '6000' }));
  await run(
    await reportRequest({
      number: '05320000002',
      date: String(docDate * 1000),
      direction: '2',
      duration: '6',
    }),
  );
  const docHistory = await api('history?documentId=folio');
  assert.equal(docHistory.rows.length, 1);
  assert.equal(docHistory.rows[0].call.id, docAudio);
  assert.equal(docHistory.rows[0].call.documentId, 'folio');

  const android = (input, token) =>
    api('acr-agent', input, token ? { authorization: 'Bearer ' + token } : {});
  const link = () => api('acr-agent-link', { deviceId: device.id });
  actor = { id: 'another-user', role: 'staff' };
  await assert.rejects(link(), { status: 403 });
  actor = { id: 'test-ceo', role: 'ceo' };
  const { pairingCode } = await link();
  assert.match(pairingCode, /\.[\w-]{16}$/);
  const { token, ...agent } = await android({ pairingCode });
  await assert.rejects(android({ pairingCode }), { status: 401 });
  await assert.rejects(android({ ...agent, accountId: 'another-user' }, token), { status: 401 });
  assert.equal(Object.hasOwn(await api('config'), 'acrAgents'), false);
  assert.equal((await api('acr-devices')).devices[0].automatic, true);
  assert.deepEqual(await android(agent, token), { dial: null });

  const { dial: automatic } = await api('acr-dials', destination);
  const automaticStatus = () => api('acr-dials?dialId=' + automatic.id);
  assert.equal(automatic.automatic, true);
  assert.equal((await automaticStatus()).status, 'waiting');
  assert.equal(
    (await api('acr-dials')).dials.some((row) => row.id === automatic.id),
    false,
  );
  await assert.rejects(api('acr-dials', { dialId: automatic.id }), { status: 404 });
  const commands = await Promise.all([android(agent, token), android(agent, token)]);
  const delivered = commands.flatMap(({ dial }) => (dial ? [dial] : []));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, automatic.id);
  assert.equal(delivered[0].phone, '905320000001');
  assert.ok(delivered[0].launchWithinMs > 0 && delivered[0].launchWithinMs <= 12000);
  assert.equal((await automaticStatus()).status, 'delivered');
  assert.deepEqual(await android(agent, token), { dial: null });

  const autoReport = await run(await reportRequest({ ...report, date: String((docDate + 1) * 1000) }));
  assert.ok((await history()).calls.some((call) => call.id === autoReport.id && call.cardId === 'second'));
  await api('acr-agent-link', { deviceId: device.id, revoke: true });
  await assert.rejects(android(agent, token), { status: 401 });
  assert.equal((await api('acr-devices')).devices[0].automatic, false);
});

test('ACR skips audio shorter than two seconds before saving; two seconds and unknown durations remain accepted', async () => {
  const { createReceiver } = require('../lib/acr-phone.cjs');
  const saved = [],
    calls = [];
  const receiver = createReceiver({
    devices: () => JSON.stringify([device]),
    readBody: async (req) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return Buffer.concat(chunks);
    },
    recordings: { available: true, save: async (id) => saved.push(id) },
    persist: async (call) => calls.push(call),
  });
  const run = async (duration, date) => {
    const res = response();
    await receiver(await request({ duration, date }), res);
    return JSON.parse(res.bytes());
  };
  for (const duration of ['0', '1999', '1999']) {
    const result = await run(duration, '1795089600');
    assert.equal(result.ignored, true);
    assert.equal(result.reason, 'recording_too_short');
  }
  assert.equal(saved.length, 0);
  assert.equal(calls.length, 0);
  assert.equal((await run('2000', '1795089601')).accepted, true);
  assert.equal(calls[0].recordingDuration, 2);
  assert.equal(
    (await run(null, '1795089602')).accepted,
    true,
    'missing duration must not drop a real recording',
  );
  assert.equal(saved.length, 2);
});

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
    users: [{ id: 'worker-1', name: 'Test Personel', active: true }],
    voipCalls: [],
    voipConfig: {},
    voipGrants: [],
    data: { 'icrapro-v1': { docs: [], clients: [] } },
  };
  let signedIn = false;
  let role = 'ceo';
  const handle = createVoipHandler({
    transaction: (work) => work({ state, saveState() {} }),
    recordings,
    authenticatedUser: async () => {
      if (!signedIn) throw Object.assign(Error('Sign in'), { status: 401 });
      return { id: 'ceo', role };
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
  assert.equal(state.voipCalls[0].phone, '');
  assert.equal(state.voipCalls[0].callerNumber, '');
  assert.equal(state.voipCalls[0].duration, 3);
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
  state.voipCalls[0].recordingSuppressed = 'too_short';
  await assert.rejects(handle(media, response(), new URL(media.url, 'https://' + host)), { status: 404 });
  delete state.voipCalls[0].recordingSuppressed;
  // Old imported rows may contain the package name in callerNumber; hide it there too.
  state.voipCalls[0].callerNumber = 'com.nll.cb';
  const list = response();
  await handle({ method: 'GET', headers: {} }, list, new URL('https://' + host + '/api/voip/recordings'));
  assert.equal(JSON.parse(list.bytes()).calls[0].callerNumber, 'Numara aktarılmadı');
  const nativeUpload = await run({
    withoutBinaryFilename: true,
    declaredName: '1000461046',
    date: null,
  });
  const nativeId = JSON.parse(nativeUpload.bytes()).id;
  assert.equal(state.voipCalls.length, 2);
  assert.equal(state.voipCalls[1].acrFileName, '1000461046');
  assert.equal(state.voipCalls[1].phone, '', 'a numeric Android recording ID is not a telephone number');
  assert.deepEqual(
    await recordings.read(nativeId),
    wav(),
    'octet-stream bytes survive even without a filename on the file part',
  );
  await run({ withoutBinaryFilename: true, declaredName: '1000461046', date: null });
  assert.equal(state.voipCalls.length, 2, 'omitting optional Date does not duplicate retries');
  const deviceApi = async (method = 'GET', value) => {
    const raw = Buffer.from(JSON.stringify(value || {}));
    const req = {
      method,
      headers: { host, 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() {
        yield raw;
      },
    };
    const res = response();
    await handle(req, res, new URL('https://' + host + '/api/voip/acr-devices'));
    return JSON.parse(res.bytes());
  };
  const deviceList = await deviceApi();
  assert.equal(deviceList.devices[0].label, 'ACR Telefon 1');
  assert.ok(!JSON.stringify(deviceList).includes('secretHash'));
  role = 'admin';
  await assert.rejects(deviceApi(), { status: 403 });
  role = 'ceo';
  await assert.rejects(deviceApi('PUT', { devices: [{ id: 'unknown-device', label: 'Other' }] }), {
    status: 400,
  });
  await assert.rejects(
    deviceApi('PUT', { devices: [{ id: device.id, label: 'Office', userId: 'other-user' }] }),
    { status: 400 },
  );
  const settings = await deviceApi('PUT', {
    devices: [{ id: device.id, label: 'Ofis telefonu', userId: 'worker-1' }],
  });
  assert.equal(settings.devices[0].label, 'Ofis telefonu');
  assert.equal(state.voipCalls[0].staffName, 'Test Personel');
  assert.equal(state.voipCalls[0].userId, 'worker-1');
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
    await transaction(
      pool,
      false,
      (tx) => {
        tx.state.voipConfig = {
          ...tx.state.voipConfig,
          acrDevices: { [device.id]: { label: 'Yeni cihaz adı', userId: 'test-ceo', userName: 'Test' } },
        };
        tx.saveState(tx.state);
      },
      { configWrite: true, acrProfilesWrite: true },
    );
    const renamed = await transaction(pool, false, (tx) => tx.state.voipCalls[0], { id });
    assert.equal(renamed.staffName, 'Test');
    assert.equal(renamed.acrDeviceLabel, 'Yeni cihaz adı');
    assert.equal(renamed.userId, 'test-ceo');
    assert.equal(
      (await pool.query('SELECT user_id FROM han_private.voip_calls WHERE id=$1', [id])).rows[0].user_id,
      'test-ceo',
    );
  } finally {
    await pg.close();
  }
});

test('ACR settings save device assignments and copy a complete Android pairing code', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(
    '<div id="host"><form id="other"><input name="unchanged" value="keep"></form></div>',
    { runScripts: 'outside-only', url: 'https://www.hanhukuktakip.com' },
  );
  const w = dom.window;
  w.esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s],
    );
  w.eval(await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8'));
  const calls = [];
  let added = 0;
  const pairingCode = 'phone-1.AbCdEf1234_xyZ-0';
  w.voipApi = async (route, method, value) => {
    calls.push({ route, method, value });
    if (route === 'acr-devices' && method === 'POST') {
      assert.match(value.requestId, /^[a-f0-9-]{36}$/i);
      const id = 'new-phone-' + ++added;
      return {
        device: { id, label: value.label, userId: value.userId },
        setup: {
          deviceId: id,
          uploadUrl: 'https://example.test/api/voip/acr-upload',
          reportUrl: 'https://example.test/api/voip/acr-report',
          secret: 'synthetic-device-only-code-' + added,
        },
      };
    }
    if (route === 'acr-agent-link') return value.revoke ? { paired: false } : { pairingCode };
    return {
      devices: value?.devices || [{ id: 'phone-1', label: '<img src=x onerror=alert(1)>', userId: '' }],
      users: [{ id: 'worker-1', name: 'Test Personel' }],
    };
  };
  try {
    await w.voipAcrDeviceSettings(w.document.querySelector('#host'));
    const form = w.document.querySelector('form[aria-labelledby="acrDevicesHeading"]');
    assert.ok(form);
    const links = w.document.querySelector('nav[aria-label="Android uygulamaları"]');
    assert.deepEqual(
      [...links.querySelectorAll('a')].map((link) => link.getAttribute('href')),
      [
        '/api/voip/acr-download?file=han-gsm-baglantisi.apk',
        '/api/voip/acr-download?file=aph.apk',
        'https://play.google.com/store/apps/details?id=com.nll.cb&pcampaignid=web_share',
        'https://acr.app/',
        'https://nllapps.com/store/',
      ],
    );
    assert.equal(links.querySelectorAll('a[download]').length, 2);
    assert.equal(w.document.querySelectorAll('form form').length, 0);
    assert.equal(form.querySelectorAll('img').length, 0);
    form.querySelector('input').value = 'Telefonum';
    form.querySelector('select').value = 'worker-1';
    assert.equal(calls.length, 1, 'select changes do not submit');
    await form.onsubmit({ preventDefault() {} });
    assert.equal(calls[1].route, 'acr-devices');
    assert.equal(calls[1].method, 'PUT');
    assert.equal(calls[1].value.devices[0].label, 'Telefonum');
    assert.equal(calls[1].value.devices[0].userId, 'worker-1');
    assert.match(form.querySelector('[data-acr-status]').textContent, /kaydedildi/);
    assert.equal(w.document.querySelector('#other input').value, 'keep');

    const pair = form.querySelector('[data-acr-agent-pair]');
    const panel = form.querySelector('[data-acr-agent-code-panel]');
    const code = panel.querySelector('textarea');
    const copy = panel.querySelector('button');
    assert.equal(panel.hidden, true);
    await pair.onclick();
    assert.equal(panel.hidden, false);
    assert.equal(code.readOnly, true);
    assert.equal(code.value, 'www.hanhukuktakip.com/' + pairingCode);
    assert.equal(copy.type, 'button');

    const status = form.querySelector('[data-acr-agent-status]');
    const writes = [];
    Object.defineProperty(w.navigator, 'clipboard', {
      value: { writeText: async (text) => writes.push(text) },
      configurable: true,
    });
    copy.click();
    await new Promise(setImmediate);
    assert.deepEqual(writes, [code.value]);
    assert.match(status.textContent, /kopyalandı/);
    assert.equal(calls.length, 3, 'copying does not resubmit or replace the code');

    Object.defineProperty(w.navigator, 'clipboard', { value: undefined });
    copy.click();
    await new Promise(setImmediate);
    assert.equal(code.selectionStart, 0);
    assert.equal(code.selectionEnd, code.value.length);
    assert.match(status.textContent, /Panoya erişilemedi/);

    await form.querySelector('[data-acr-agent-revoke]').onclick();
    assert.equal(panel.hidden, true);
    assert.equal(code.value, '');
    const addForm = w.document.querySelector('form[aria-labelledby="acrAddHeading"]');
    form.querySelector('input').value = 'Unsaved device label';
    addForm.elements.label.value = 'İkinci telefon';
    addForm.elements.userId.value = 'worker-1';
    await addForm.onsubmit({ preventDefault() {} });
    assert.equal(form.querySelectorAll('[data-acr-device]').length, 2);
    assert.equal(
      form.querySelector('input').value,
      'Unsaved device label',
      'adding a phone preserves unsaved edits',
    );
    const second = form.querySelector('[data-acr-device="new-phone-1"]');
    assert.equal(second.querySelector('select').value, 'worker-1');
    assert.equal(second.querySelector('[data-acr-upload-secret]').value, 'synthetic-device-only-code-1');
    assert.equal(second.querySelector('[data-acr-setup]').open, true);
    assert.equal(second.querySelector('[data-acr-agent-pair]').disabled, false);
    addForm.elements.label.value = 'Üçüncü telefon';
    await addForm.onsubmit({ preventDefault() {} });
    assert.equal(form.querySelectorAll('[data-acr-device]').length, 3);
    assert.equal(w.document.querySelectorAll('form form').length, 0);
  } finally {
    w.close();
  }
});

test('new ACR phones persist per office, receive unique encrypted credentials and support uploads, reports and Android pairing', async (t) => {
  const oldDevices = process.env.HAN_ACR_DEVICES,
    oldKey = process.env.VOIP_ENCRYPTION_KEY;
  process.env.HAN_ACR_DEVICES = JSON.stringify([device]);
  process.env.VOIP_ENCRYPTION_KEY = 'ab'.repeat(32);
  const { pg, pool } = await database();
  t.after(async () => {
    if (oldDevices === undefined) delete process.env.HAN_ACR_DEVICES;
    else process.env.HAN_ACR_DEVICES = oldDevices;
    if (oldKey === undefined) delete process.env.VOIP_ENCRYPTION_KEY;
    else process.env.VOIP_ENCRYPTION_KEY = oldKey;
    await pg.close();
  });
  await importState(pool, fixture());
  let actor = { id: 'test-ceo', role: 'ceo' };
  const handle = createVoipHandler({
    transaction: (work, scope) => transaction(pool, false, work, scope),
    authenticatedUser: async () => actor,
    recordings: { available: true, save: async () => {} },
    readBody: async (req) => {
      const parts = [];
      for await (const part of req) parts.push(part);
      return Buffer.concat(parts);
    },
  });
  const api = async (route, method = 'GET', input = {}, hostname = host) => {
    const raw = Buffer.from(JSON.stringify(input)),
      res = response();
    const req = {
      method,
      headers: { host: hostname, 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() {
        yield raw;
      },
    };
    await handle(req, res, new URL('/api/voip/' + route, 'https://' + hostname));
    return JSON.parse(res.bytes());
  };
  const firstInput = { requestId: crypto.randomUUID(), label: 'GSM telefonu 2', userId: 'test-ceo' };
  const first = await api('acr-devices', 'POST', firstInput);
  const retry = await api('acr-devices', 'POST', firstInput);
  assert.equal(retry.device.id, first.device.id);
  assert.equal(retry.setup.secret, first.setup.secret, 'retry returns the same phone credentials');
  const second = await api('acr-devices', 'POST', {
    requestId: crypto.randomUUID(),
    label: 'GSM telefonu 3',
    userId: 'test-ceo',
  });
  assert.notEqual(second.device.id, first.device.id);
  assert.notEqual(second.setup.secret, first.setup.secret);
  assert.match(first.setup.secret, /^[a-f0-9]{64}$/);
  const stored = (await pool.query('SELECT body FROM han_private.voip_config WHERE id=1')).rows[0].body;
  assert(!JSON.stringify(stored).includes(first.setup.secret));
  assert(!JSON.stringify(stored).includes(second.setup.secret));
  assert.equal(
    stored.acrCredentials[first.device.id].secretHash,
    crypto.createHash('sha256').update(first.setup.secret).digest('hex'),
  );
  assert.equal(
    (await api('acr-devices')).devices.length,
    3,
    'the existing environment device remains registered',
  );
  assert(!JSON.stringify(await api('acr-devices')).includes('sealedSecret'));
  assert(!JSON.stringify(await api('config')).includes('acrCredentials'));
  assert.equal(
    (await api('acr-device-setup', 'POST', { deviceId: first.device.id })).secret,
    first.setup.secret,
  );
  await assert.rejects(api('acr-device-setup', 'POST', { deviceId: first.device.id }, 'other.example.test'), {
    status: 404,
  });
  const run = async (req) => {
    const res = response();
    await handle(req, res, new URL(req.url, 'https://' + req.headers.host));
    return JSON.parse(res.bytes());
  };
  assert.equal((await run(await request({ code: first.setup.secret, probe: true }))).ready, true);
  assert.equal((await run(await request({ code: second.setup.secret, probe: true }))).ready, true);
  assert.equal((await run(await request({ probe: true }))).ready, true, 'legacy credentials still work');
  await assert.rejects(
    run(await request({ code: first.setup.secret, probe: true, hostname: 'other.example.test' })),
    { status: 404 },
  );
  await run(await request({ code: first.setup.secret }));
  await run(
    await reportRequest({
      secret: second.setup.secret,
      number: '05320000000',
      date: '1795089600000',
      direction: '2',
      duration: '15',
    }),
  );
  const calls = (await pool.query('SELECT body FROM han_private.voip_calls')).rows.map((r) => r.body);
  assert.equal(calls.length, 2);
  assert(calls.some((c) => c.acrDeviceId === first.device.id && c.recordingPresent));
  assert(calls.some((c) => c.acrDeviceId === second.device.id && c.acrReport));
  assert(calls.every((c) => c.userId === 'test-ceo'));
  const { pairingCode } = await api('acr-agent-link', 'POST', { deviceId: first.device.id });
  const paired = await api('acr-agent', 'POST', { pairingCode });
  assert.equal(paired.deviceId, first.device.id);
  assert.equal(paired.accountId, 'test-ceo');
  assert.match(paired.token, /^[\w-]{43}$/);
  const changed = await api('acr-devices', 'PUT', {
    devices: [{ id: first.device.id, label: 'Yeni ad', userId: 'test-ceo' }],
  });
  assert(changed.devices.some((d) => d.id === first.device.id && d.label === 'Yeni ad'));
  assert.equal(
    (await api('acr-device-setup', 'POST', { deviceId: first.device.id })).secret,
    first.setup.secret,
  );
  assert.equal((await api('acr-dials')).devices.length, 2);
  await assert.rejects(
    api('acr-devices', 'POST', { requestId: crypto.randomUUID(), label: '', userId: 'test-ceo' }),
    { status: 400 },
  );
  await assert.rejects(
    api('acr-devices', 'POST', { requestId: crypto.randomUUID(), label: 'Other', userId: 'missing' }),
    { status: 400 },
  );
  actor = { id: 'staff', role: 'admin' };
  await assert.rejects(api('acr-devices', 'POST', firstInput), { status: 403 });
  await assert.rejects(api('acr-device-setup', 'POST', { deviceId: first.device.id }), { status: 403 });
  actor = { id: 'support', role: 'ceo', platformSupport: true };
  await assert.rejects(api('acr-devices', 'POST', firstInput), { status: 403 });
});

test('ACR phone provisioning opens in its own settings section, separate from switchboard configuration', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<main id="content"></main>', {
    runScripts: 'outside-only',
    url: 'https://example.test',
  });
  const w = dom.window,
    requests = [];
  Object.assign(w, {
    hanAuth: { role: 'ceo' },
    $: (s) => w.document.querySelector(s),
    esc: (v) => String(v ?? ''),
    settingsSectionTabs: (active) => `<nav data-active="${active}">ACR telefonları</nav>`,
    bindSettingsSectionTabs: () => {},
  });
  try {
    w.eval(await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8'));
    w.voipApi = async (route) => {
      requests.push(route);
      return route === 'acr-devices'
        ? { devices: [], users: [] }
        : { providers: [], users: [], extensions: {}, inboundUsers: [] };
    };
    await w.voipAcrSettingsPage();
    assert.equal(w.document.querySelector('nav').dataset.active, 'acr');
    assert.equal(w.document.querySelector('#acrDevicesHeading').textContent, 'ACR telefonları');
    assert(w.document.querySelector('form[aria-labelledby="acrAddHeading"]'));
    assert.equal(w.document.querySelector('#voipConfigForm'), null);
    assert.deepEqual(requests, ['acr-devices']);
    requests.length = 0;
    w.voipSettingsPage();
    await new Promise(setImmediate);
    assert(w.document.querySelector('#voipConfigForm'));
    assert.equal(w.document.querySelector('form[aria-labelledby="acrAddHeading"]'), null);
    assert.deepEqual(requests, ['config']);
    w.hanAuth.role = 'admin';
    requests.length = 0;
    await w.voipAcrSettingsPage();
    assert.equal(requests.length, 0, 'the dedicated device-management page stays CEO-only');
  } finally {
    w.close();
  }
});

test('ACR APK downloads send the attachment bytes only to the configured office CEO', async (t) => {
  const oldDevices = process.env.HAN_ACR_DEVICES;
  process.env.HAN_ACR_DEVICES = JSON.stringify([device]);
  const files = await fs.mkdtemp(path.join(os.tmpdir(), 'han-apk-test-'));
  t.after(async () => {
    if (oldDevices === undefined) delete process.env.HAN_ACR_DEVICES;
    else process.env.HAN_ACR_DEVICES = oldDevices;
    await Promise.all([
      fs.rm(path.join(files, 'aph.apk'), { force: true }),
      fs.rm(path.join(files, 'han-gsm-baglantisi.apk'), { force: true }),
    ]);
    await fs.rmdir(files);
  });
  const aph = Buffer.from([0x50, 0x4b, 0, 0xff, 0x03]);
  const han = Buffer.from([0x50, 0x4b, 0xff, 0x04]);
  await Promise.all([
    fs.writeFile(path.join(files, 'aph.apk'), aph),
    fs.writeFile(path.join(files, 'han-gsm-baglantisi.apk'), han),
  ]);
  let user = { role: 'ceo' };
  const handle = createVoipHandler({
    androidDownloadsDir: files,
    authenticatedUser: async () => {
      if (!user) throw Object.assign(Error('Oturum açmanız gerekiyor.'), { status: 401 });
      return user;
    },
  });
  const download = async (filename, method = 'GET', hostname = host) => {
    const url = new URL('/api/voip/acr-download?file=' + encodeURIComponent(filename), 'https://' + hostname);
    const res = response();
    await handle({ method, headers: { host: hostname } }, res, url);
    return res;
  };
  const file = await download('aph.apk');
  assert.equal(file.statusCode, 200);
  assert.equal(file.headers['content-type'], 'application/vnd.android.package-archive');
  assert.equal(file.headers['content-disposition'], 'attachment; filename="aph.apk"');
  assert.equal(file.headers['content-length'], aph.length);
  assert.equal(file.headers['cache-control'], 'private, no-store');
  assert.deepEqual(file.bytes(), aph);
  assert.deepEqual((await download('han-gsm-baglantisi.apk')).bytes(), han);
  assert.equal((await download('aph.apk', 'HEAD')).bytes().length, 0);
  await assert.rejects(download('aph.apk', 'GET', 'other.example.test'), { status: 404 });
  await assert.rejects(download('../aph.apk'), { status: 404 });
  user = { role: 'ceo', platformSupport: true };
  await assert.rejects(download('aph.apk'), { status: 403 });
  user = { role: 'staff' };
  await assert.rejects(download('aph.apk'), { status: 403 });
  user = null;
  await assert.rejects(download('aph.apk'), { status: 401 });
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
    const report = response();
    await app(await reportRequest({ test: '1' }), report);
    assert.equal(report.statusCode, 200);
    assert.deepEqual(JSON.parse(report.bytes()), { ready: true });
    const agent = response();
    await app(
      {
        method: 'POST',
        url: '/api/voip/acr-agent',
        headers: { host, 'content-type': 'application/json' },
        socket: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify({ deviceId: device.id }));
        },
      },
      agent,
    );
    assert.equal(agent.statusCode, 401);
    const denied = response();
    await app({ method: 'POST', url: '/api/voip/config', headers: { host }, socket: {} }, denied);
    assert.equal(denied.statusCode, 403);
  } finally {
    if (previous === undefined) delete process.env.HAN_ACR_DEVICES;
    else process.env.HAN_ACR_DEVICES = previous;
  }
});
