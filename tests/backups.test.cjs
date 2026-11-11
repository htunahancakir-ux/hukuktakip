const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackupService, decryptState, encryptState } = require('../lib/backup-service.cjs');

function memoryStore(state) {
  let policy = {};
  return {
    async readState() { return structuredClone(state); },
    async readPolicy() { return structuredClone(policy); },
    async updatePolicy(change) {
      const copy = structuredClone(policy);
      const result = change(copy);
      if (result !== null) policy = copy;
      return result;
    }
  };
}

test('encrypted backup round-trips and rejects altered ciphertext', () => {
  const key = crypto.randomBytes(32);
  const original = { users: [{ id: 'one' }], data: { docs: ['özel bilgi'] } };
  const encrypted = encryptState(original, key);
  assert.deepEqual(decryptState(encrypted, key), original);
  assert.equal(encrypted.includes(Buffer.from('özel bilgi')), false);
  encrypted[encrypted.length - 1] ^= 1;
  assert.throws(() => decryptState(encrypted, key));
});

test('scheduled backup writes the same encrypted copy locally and to R2, then observes interval', async t => {
  const keys = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'BACKUP_ENCRYPTION_KEY'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    R2_ACCOUNT_ID: 'example', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test',
    R2_BUCKET_NAME: 'hanhukuktakip', BACKUP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex')
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'han-backup-test-'));
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    for (const key of keys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
  });
  const original = { users: [{ id: 'ceo' }], data: { 'icrapro-v1': { docs: [{ debtor: 'Örnek' }] } } };
  const store = memoryStore(original);
  const legacyKey = 'hanhukuk/2026-11-06T20-00-00-000Z-00000000-0000-4000-8000-000000000001.hnb';
  await store.updatePolicy(policy => { policy.lastObjectKey = legacyKey; return true; });
  let remote;
  const backups = createBackupService({ store, localDirectory: directory,
    upload: async (name, bytes) => { remote = { name, bytes }; } });
  await backups.configure({ enabled: true, intervalDays: 7 });
  const first = await backups.run();
  assert.equal(first.ok, true);
  assert.equal(first.localSaved, true);
  assert.match(remote.name, /^hanhukuk\/local\//);
  assert.equal((await store.readPolicy()).legacyObjectKey, legacyKey);
  const file = fs.readFileSync(path.join(directory, path.basename(remote.name)));
  assert.deepEqual(file, remote.bytes);
  assert.deepEqual(decryptState(file, Buffer.from(process.env.BACKUP_ENCRYPTION_KEY, 'hex')), original);
  assert.match((await backups.run()).skipped, /henüz gelmedi/);
  const status = await backups.status();
  assert.equal(status.intervalDays, 7);
  assert.equal(status.r2Configured, true);
  assert.ok(status.lastR2At && status.lastLocalAt && status.nextDueAt);
});

test('R2 upload failure is visible and does not mark the backup successful', async t => {
  const keys = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'BACKUP_ENCRYPTION_KEY'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    R2_ACCOUNT_ID: 'example', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test',
    R2_BUCKET_NAME: 'hanhukuktakip', BACKUP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex')
  });
  t.after(() => { for (const key of keys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; });
  const backups = createBackupService({ store: memoryStore({ users: [{ id: 'ceo' }], data: {} }),
    upload: async () => { throw new Error('remote unavailable'); } });
  await backups.configure({ enabled: true, intervalDays: 1 });
  await assert.rejects(backups.run({ force: true }), /Yedek alınamadı/);
  const status = await backups.status();
  assert.equal(status.lastSuccessAt, null);
  assert.ok(status.lastError);
});

// --- Backup schedules (daily times / weekly day / interval), Istanbul = UTC+3 ---
function scheduleEnv(t) {
  const keys = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'BACKUP_ENCRYPTION_KEY'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    R2_ACCOUNT_ID: 'example', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test',
    R2_BUCKET_NAME: 'hanhukuktakip', BACKUP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex')
  });
  t.after(() => { for (const key of keys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; });
}
// Clock fixed at `iso` (mocks both Date.now() and new Date()).
function fixClock(t, iso) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) });
  return next => t.mock.timers.setTime(Date.parse(next));
}
async function scheduledService(t, schedule, policyPatch = {}, upload) {
  scheduleEnv(t);
  const store = memoryStore({ users: [{ id: 'ceo' }], data: {} });
  const uploads = [];
  const backups = createBackupService({ store, upload: upload || (async name => { uploads.push(name); }) });
  await backups.configure({ enabled: true, schedule });
  await store.updatePolicy(policy => { Object.assign(policy, policyPatch); return true; });
  return { store, backups, uploads };
}

test('schedule validation: daily times, weekly day, interval and the legacy intervalDays form', async t => {
  scheduleEnv(t);
  const store = memoryStore({ users: [{ id: 'ceo' }], data: {} });
  const backups = createBackupService({ store, upload: async () => {} });
  const ok = await backups.configure({ enabled: true, schedule: { type: 'daily', times: ['18:00', '09:00', '13:00'] } });
  assert.deepEqual(ok.schedule, { type: 'daily', times: ['09:00', '13:00', '18:00'] });
  const rejects = async (schedule) => assert.rejects(backups.configure({ enabled: true, schedule }), e => e.status === 400,
    JSON.stringify(schedule));
  await rejects({ type: 'daily', times: ['01:00', '03:00', '05:00', '07:00', '09:00', '11:00', '13:00'] });
  await rejects({ type: 'daily', times: ['09:00', '09:30'] });
  await rejects({ type: 'daily', times: ['25:00'] });
  await rejects({ type: 'daily', times: ['9:00'] });
  await rejects({ type: 'daily', times: [] });
  await rejects({ type: 'weekly', weekday: 0 });
  await rejects({ type: 'weekly', weekday: 8 });
  await rejects({ type: 'interval', days: 2 });
  await rejects({ type: 'monthly' });
  // A rejected schedule leaves the saved one untouched.
  assert.deepEqual((await backups.status()).schedule, { type: 'daily', times: ['09:00', '13:00', '18:00'] });
  const six = await backups.configure({ enabled: true, schedule: { type: 'daily', times: ['01:00', '03:00', '05:00', '07:00', '09:00', '11:00'] } });
  assert.equal(six.schedule.times.length, 6);
  const weekly = await backups.configure({ enabled: true, schedule: { type: 'weekly', weekday: 7 } });
  assert.deepEqual(weekly.schedule, { type: 'weekly', weekday: 7 });
  const monthly = await backups.configure({ enabled: true, schedule: { type: 'interval', days: 30 } });
  assert.deepEqual(monthly.schedule, { type: 'interval', days: 30 });
  assert.equal(monthly.intervalDays, 30);
  await backups.configure({ enabled: true, schedule: { type: 'daily', times: ['09:00'] } });
  const legacy = await backups.configure({ enabled: true, intervalDays: 7 });
  assert.deepEqual(legacy.schedule, { type: 'interval', days: 7 });
  assert.equal(legacy.intervalDays, 7);
  assert.equal((await store.readPolicy()).schedule, undefined);
  await assert.rejects(backups.configure({ enabled: true, intervalDays: 3 }), e => e.status === 400);
});

test('daily schedule runs once per slot and reports the next slot', async t => {
  fixClock(t, '2026-11-12T10:30:00Z'); // 13:30 Istanbul
  const { backups, uploads } = await scheduledService(t, { type: 'daily', times: ['09:00', '13:00', '18:00'] },
    { lastSuccessAt: '2026-11-12T08:00:00.000Z' }); // 11:00 Istanbul
  assert.equal((await backups.status()).nextDueAt, '2026-11-12T10:00:00.000Z'); // due 13:00 slot
  assert.equal((await backups.run()).ok, true);
  assert.equal(uploads.length, 1);
  assert.match((await backups.run()).skipped, /henüz gelmedi/);
  assert.equal(uploads.length, 1);
  assert.equal((await backups.status()).nextDueAt, '2026-11-12T15:00:00.000Z'); // 18:00 Istanbul
});

test('daily schedule is not due when the latest slot already succeeded', async t => {
  fixClock(t, '2026-11-12T10:30:00Z');
  const { backups, uploads } = await scheduledService(t, { type: 'daily', times: ['09:00', '13:00', '18:00'] },
    { lastSuccessAt: '2026-11-12T10:05:00.000Z' }); // 13:05 Istanbul
  assert.match((await backups.run()).skipped, /henüz gelmedi/);
  assert.equal(uploads.length, 0);
  assert.equal((await backups.status()).nextDueAt, '2026-11-12T15:00:00.000Z');
});

test('daily schedule across the day boundary uses the previous day last slot', async t => {
  fixClock(t, '2026-11-12T03:00:00Z'); // 06:00 Istanbul
  const { backups, uploads } = await scheduledService(t, { type: 'daily', times: ['09:00', '18:00'] },
    { lastSuccessAt: '2026-11-11T16:00:00.000Z' }); // 19:00 Istanbul the day before
  assert.match((await backups.run()).skipped, /henüz gelmedi/);
  assert.equal(uploads.length, 0);
  assert.equal((await backups.status()).nextDueAt, '2026-11-12T06:00:00.000Z'); // 09:00 Istanbul
});

test('daily schedule across the day boundary is due when the previous day last slot was missed', async t => {
  fixClock(t, '2026-11-12T03:00:00Z');
  const { backups, uploads } = await scheduledService(t, { type: 'daily', times: ['09:00', '18:00'] },
    { lastSuccessAt: '2026-11-11T14:00:00.000Z' }); // 17:00 Istanbul, before the 18:00 slot
  assert.equal((await backups.status()).nextDueAt, '2026-11-11T15:00:00.000Z');
  assert.equal((await backups.run()).ok, true);
  assert.equal(uploads.length, 1);
});

test('weekly schedule is due from that weekday 00:00 Istanbul', async t => {
  const advance = fixClock(t, '2026-11-11T05:00:00Z'); // Wednesday 08:00 Istanbul
  const due = await scheduledService(t, { type: 'weekly', weekday: 3 }, { lastSuccessAt: '2026-11-10T20:59:00.000Z' });
  assert.equal((await due.backups.status()).nextDueAt, '2026-11-10T21:00:00.000Z');
  assert.equal((await due.backups.run()).ok, true);
  assert.equal(due.uploads.length, 1);
  const done = await scheduledService(t, { type: 'weekly', weekday: 3 }, { lastSuccessAt: '2026-11-10T21:30:00.000Z' });
  assert.match((await done.backups.run()).skipped, /henüz gelmedi/);
  assert.equal(done.uploads.length, 0);
  assert.equal((await done.backups.status()).nextDueAt, '2026-11-17T21:00:00.000Z');
  // Tuesday 23:59 Istanbul: the latest slot is still the previous Wednesday.
  advance('2026-11-17T20:59:00Z');
  assert.match((await done.backups.run()).skipped, /henüz gelmedi/);
  advance('2026-11-17T21:00:00Z');
  assert.equal((await done.backups.run()).ok, true);
  assert.equal(done.uploads.length, 1);
});

test('a failed scheduled backup is retried for the same slot only after an hour', async t => {
  const advance = fixClock(t, '2026-11-12T10:30:00Z');
  let fail = true;
  const attempts = [];
  const { backups, store } = await scheduledService(t, { type: 'daily', times: ['09:00', '13:00', '18:00'] },
    { lastSuccessAt: '2026-11-12T08:00:00.000Z' },
    async name => { attempts.push(name); if (fail) throw new Error('remote unavailable'); });
  await assert.rejects(backups.run(), /Yedek alınamadı/);
  assert.equal(attempts.length, 1);
  assert.equal((await store.readPolicy()).lastAttemptAt, '2026-11-12T10:30:00.000Z');
  assert.ok((await backups.status()).lastError);
  advance('2026-11-12T10:40:00Z');
  assert.match((await backups.run()).skipped, /henüz gelmedi/);
  assert.equal(attempts.length, 1);
  advance('2026-11-12T11:31:00Z');
  fail = false;
  assert.equal((await backups.run()).ok, true);
  assert.equal(attempts.length, 2);
  assert.equal((await backups.status()).lastSuccessAt, '2026-11-12T11:31:00.000Z');
});

test('a failure shortly before a new slot does not delay that slot', async t => {
  const advance = fixClock(t, '2026-11-12T09:50:00Z'); // 12:50 Istanbul, 09:00 slot missed
  let fail = true;
  const { backups } = await scheduledService(t, { type: 'daily', times: ['09:00', '13:00'] },
    { lastSuccessAt: '2026-11-11T12:00:00.000Z' },
    async () => { if (fail) throw new Error('remote unavailable'); });
  await assert.rejects(backups.run(), /Yedek alınamadı/);
  fail = false;
  advance('2026-11-12T10:00:00Z'); // 13:00 Istanbul: new slot, 10 minutes after the failure
  assert.equal((await backups.run()).ok, true);
});

test('daily times must differ and stay an hour apart across midnight too', async () => {
  const { createBackupService } = require('../lib/backup-service.cjs');
  let policy = {};
  const backups = createBackupService({
    store: {
      readPolicy: async () => policy,
      updatePolicy: async (change) => {
        const next = structuredClone(policy);
        if (!change(next)) return null;
        policy = next;
        return policy;
      },
    },
  });
  for (const times of [
    ['12:00', '12:00', '09:00'],
    ['00:30', '23:45'],
  ])
    await assert.rejects(backups.configure({ enabled: false, schedule: { type: 'daily', times } }), (e) => e.status === 400, times.join(','));
  await backups.configure({ enabled: false, schedule: { type: 'daily', times: ['00:30', '23:00'] } });
  assert.deepEqual(policy.schedule, { type: 'daily', times: ['00:30', '23:00'] }, '90 minutes across midnight is fine');
});
