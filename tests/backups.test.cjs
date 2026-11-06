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
  let remote;
  const backups = createBackupService({ store, localDirectory: directory,
    upload: async (name, bytes) => { remote = { name, bytes }; } });
  await backups.configure({ enabled: true, intervalDays: 7 });
  const first = await backups.run();
  assert.equal(first.ok, true);
  assert.equal(first.localSaved, true);
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
