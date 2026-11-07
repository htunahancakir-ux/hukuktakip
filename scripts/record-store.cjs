const { createPool } = require('../lib/postgres-store.cjs');
const {
  importRecords,
  exportRecords,
  syncShadow,
  activateRecords,
  returnToLegacy,
} = require('../lib/record-store/storage.cjs');
const { digest } = require('../lib/record-store/codec.cjs');
async function main() {
  const [command] = process.argv.slice(2);
  if (!['prepare', 'verify', 'sync', 'activate', 'rollback'].includes(command))
    throw Error('Kullanım: record-store.cjs prepare|verify|sync|activate|rollback');
  const pool = createPool();
  try {
    let result;
    if (command === 'prepare') result = await importRecords(pool);
    if (command === 'sync') result = await syncShadow(pool);
    if (command === 'verify') {
      const snapshot = await exportRecords(pool);
      const source = (await pool.query('SELECT payload FROM han_private.han_state WHERE id=1')).rows[0]
        ?.payload;
      if (digest(snapshot) !== digest(source)) throw Error('Kaynak ve hazırlık deposu farklı.');
      result = { verified: true, digest: digest(snapshot) };
    }
    if (command === 'activate') result = await activateRecords(pool);
    if (command === 'rollback') result = await returnToLegacy(pool);
    console.log(JSON.stringify({ command, ...result }));
  } finally {
    await pool.end();
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
