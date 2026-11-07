const crypto = require('node:crypto');
const http = require('node:http');
const { PGlite } = require('@electric-sql/pglite');
const { migrate } = require('../../lib/postgres-store.cjs');
const password = 'Synthetic-Postgres-Test-Only';
function fixture() {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    users: [
      {
        id: 'test-ceo',
        name: 'Test',
        username: 'test',
        role: 'ceo',
        active: true,
        permissions: [],
        salt,
        hash: crypto.scryptSync(password, salt, 64).toString('hex'),
      },
    ],
    data: {
      'icrapro-v1': { clients: [], docs: [] },
      'icrapro-personnel-v1': [],
      'icrapro-settings-v1': {},
      'hanhukuk-finance-v1': [],
      'hanhukuk-accounting-v1': { accounts: [], entries: [] },
      'icrapro-cases-v1': [],
    },
  };
}

// PGlite executes actual PostgreSQL SQL; one local connection is queued here.
// A separate integration test against Supabase is still required before deployment.
async function database(migrateSchema = true) {
  const pg = new PGlite();
  let queue = Promise.resolve();
  const query = async (sql, params) => {
    if (!params && /CREATE (SCHEMA|TABLE)/.test(sql)) {
      await pg.exec(sql);
      return { rows: [] };
    }
    return pg.query(sql, params);
  };
  const pool = {
    async query(sql, params) {
      const connection = await pool.connect();
      try {
        return await connection.query(sql, params);
      } finally {
        connection.release();
      }
    },
    async connect() {
      const previous = queue;
      let release;
      queue = new Promise((r) => (release = r));
      await previous;
      return { query, release };
    },
  };
  if (migrateSchema) await migrate(pool);
  return { pg, pool };
}

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

module.exports = { password, fixture, database, serve };
