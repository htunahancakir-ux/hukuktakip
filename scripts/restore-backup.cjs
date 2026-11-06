const fs = require('node:fs');
const path = require('node:path');
const { decryptState } = require('../lib/backup-service.cjs');
const { createPool, importState, validateState } = require('../lib/postgres-store.cjs');

async function main() {
  const file = process.argv[2];
  const rawKey = process.env.BACKUP_ENCRYPTION_KEY || '';
  if (!file || !/^[a-f0-9]{64}$/i.test(rawKey))
    throw new Error('Kullanım: npm run backup:restore -- YEDEK.hnb (BACKUP_ENCRYPTION_KEY gerekli)');
  const state = decryptState(fs.readFileSync(file), Buffer.from(rawKey, 'hex'));
  validateState(state);
  delete state.backupPolicy;
  if (process.env.DATABASE_URL) {
    const pool = createPool();
    try { await importState(pool, state); }
    finally { await pool.end(); }
    console.log('Yedek boş PostgreSQL veritabanına aktarıldı.');
    return;
  }
  const target = process.env.HANHUKUK_STATE_FILE || path.resolve(__dirname, '../work/hanhukuk-state.json');
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
  console.log('Yedek boş yerel veri konumuna aktarıldı.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
