// Creates a platform (super admin) operator. Run from a trusted shell only:
//   PLATFORM_ADMIN_PASSWORD='...' npm run platform:admin -- create <username> "<Full Name>"
// The password comes from the environment so it never lands in shell history or the
// process list. There is deliberately no public setup endpoint.
const { createPool } = require('../lib/postgres-store.cjs');
const { createPlatformAdmin } = require('../lib/saas/platform-auth.cjs');

async function main() {
  const [command, username, name] = process.argv.slice(2);
  if (command !== 'create' || !username || !name)
    throw new Error('Use: PLATFORM_ADMIN_PASSWORD=... platform-admin.cjs create <username> "<Full Name>"');
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!password) throw new Error('Set PLATFORM_ADMIN_PASSWORD (at least 12 characters).');
  const pool = createPool();
  try {
    const admin = await createPlatformAdmin(pool, { username, name, password });
    console.log('Platform operator created: ' + admin.username);
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  console.error(error.status ? error.message : 'Operation failed. Check configuration and database availability.');
  process.exitCode = 1;
});
