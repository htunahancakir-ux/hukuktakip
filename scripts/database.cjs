const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const { createPool, migrate, importState, validateState } = require('../lib/postgres-store.cjs');
async function main() {
  const [command, input] = process.argv.slice(2);
  if (!['migrate','import','verify'].includes(command)) throw new Error('Use: database.cjs migrate|import|verify [backup.json]');
  const state = command !== 'migrate' ? JSON.parse(fs.readFileSync(input, 'utf8')) : null;
  if (state) validateState(state);
  const pool = createPool();
  try {
    if (command === 'migrate') await migrate(pool);
    else if (command === 'import') await importState(pool, state);
    else {
      const { rows } = await pool.query('SELECT payload FROM han_private.han_state WHERE id = 1');
      if (!rows.length || !isDeepStrictEqual(rows[0].payload, state)) throw new Error('Backup and database differ');
    }
    console.log(command + ' succeeded' + (state ? ' (users: ' + state.users.length + ', documents: ' + state.data['icrapro-v1'].docs.length + ')' : ''));
  } finally { await pool.end(); }
}
main().catch(error => {
  console.error(error.code === '23505' ? 'Import refused: database already contains records.' : 'Database operation failed. Check configuration, input and database availability.');
  process.exitCode = 1;
});
