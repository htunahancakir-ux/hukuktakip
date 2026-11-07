const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { PAGE_SIZE, page } = require('./audit.cjs');
const crypto = require('node:crypto');
const { inTransaction } = require('./db-transaction.cjs');
const { createSecurityStore, readSessions, flushSessions, sessionsMap } = require('./security-store.cjs');
const { sessionKey } = require('./session-policy.cjs');

function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const url = new URL(connectionString);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  const pool = new Pool({
    connectionString: url.toString(),
    max: 3,
    ssl: local
      ? false
      : {
          rejectUnauthorized: true,
          ...(process.env.DATABASE_CA_CERT ? { ca: process.env.DATABASE_CA_CERT } : {}),
        },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
    allowExitOnIdle: true,
  });
  pool.on('error', () => console.error('PostgreSQL idle connection failed'));
  return pool;
}

async function migrate(db) {
  for (const file of ['001-state.sql', '002-audit.sql'])
    await db.query(fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
  await db.query(`CREATE TABLE IF NOT EXISTS han_private.han_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
  ); ALTER TABLE han_private.han_migrations ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON han_private.han_migrations FROM PUBLIC;`);
  const directory = path.join(__dirname, '../supabase/migrations');
  for (const file of fs
    .readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    const sql = fs.readFileSync(path.join(directory, file), 'utf8').replace(/\r\n/g, '\n');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    await inTransaction(db, async (tx) => {
      await tx.query('LOCK TABLE han_private.han_migrations IN EXCLUSIVE MODE');
      const { rows } = await tx.query('SELECT checksum FROM han_private.han_migrations WHERE name = $1', [
        file,
      ]);
      if (rows.length) {
        if (rows[0].checksum !== checksum) throw new Error('Applied migration checksum differs: ' + file);
        return;
      }
      await tx.query(sql);
      await tx.query('INSERT INTO han_private.han_migrations(name, checksum) VALUES ($1, $2)', [
        file,
        checksum,
      ]);
    });
  }
}

function validateState(state) {
  if (!state || !Array.isArray(state.users) || !state.users.length || !state.data)
    throw new Error('A populated Han Hukuk backup is required');
  const d = state.data;
  if (
    !Array.isArray(d['icrapro-v1']?.clients) ||
    !Array.isArray(d['icrapro-v1']?.docs) ||
    !Array.isArray(d['icrapro-personnel-v1']) ||
    !Array.isArray(d['hanhukuk-finance-v1']) ||
    !Array.isArray(d['hanhukuk-accounting-v1']?.accounts) ||
    !Array.isArray(d['hanhukuk-accounting-v1']?.entries)
  )
    throw new Error('Invalid backup collections');
  if (!state.users.some((u) => u.active && u.role === 'ceo'))
    throw new Error('Active CEO account is required');
  for (const u of state.users) {
    if (!u.id || !u.username || !/^[a-f0-9]{128}$/i.test(u.hash || '') || !/^[a-f0-9]+$/i.test(u.salt || ''))
      throw new Error('Invalid user credential record');
  }
}

async function importState(db, state) {
  validateState(state);
  // Deliberately no UPSERT: importing over a live database must never be implicit.
  await db.query('INSERT INTO han_private.han_state (id, payload) VALUES (1, $1::jsonb)', [
    JSON.stringify(state),
  ]);
}

async function appendAudit(db, events) {
  if (!events.length) return;
  await db.query(
    `INSERT INTO han_private.han_audit
    (category, action, area, actor_id, actor_name, actor_username, record_ref, fields)
    SELECT category, action, area, actor_id, actor_name, actor_username, record_ref, fields
    FROM jsonb_to_recordset($1::jsonb) AS e(category text, action text, area text, actor_id text,
      actor_name text, actor_username text, record_ref text, fields text[])`,
    [JSON.stringify(events)],
  );
}

async function mutateSnapshot(db, work) {
  const started = performance.now();
  const { rows } = await db.query('SELECT payload FROM han_private.han_state WHERE id = 1 FOR UPDATE');
  const lockedMs = performance.now() - started;
  if (!rows.length) throw Object.assign(new Error('Database must be imported before use'), { status: 503 });
  let state = rows[0].payload;
  const original = JSON.stringify(state);
  await db.query('SELECT id FROM han_private.han_account_index ORDER BY id FOR UPDATE');
  await db.query('DELETE FROM han_private.han_sessions WHERE expires_at <= $1', [Date.now()]);
  const sessions = await readSessions(db),
    originalSessions = structuredClone(sessions);
  const result = await work({
    state,
    sessions,
    attempts: new Map(),
    saveState(next) {
      state = next;
    },
    appendAudit: (events) => appendAudit(db, events),
  });
  const serialized = JSON.stringify(state);
  if (serialized !== original)
    await db.query(
      `UPDATE han_private.han_state SET payload = $1::jsonb,
      revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1`,
      [serialized],
    );
  await flushSessions(db, originalSessions, sessions);
  if (process.env.HAN_METRICS === '1')
    console.log(
      JSON.stringify({
        metric: 'state_transaction',
        readLockMs: Math.round(lockedMs),
        durationMs: Math.round(performance.now() - started),
        stateBytes: Buffer.byteLength(serialized),
        stateWritten: serialized !== original,
      }),
    );
  return result;
}

function createStore(pool) {
  const security = createSecurityStore(pool, appendAudit);
  return {
    security,
    async readSessionContext(req) {
      const { rows } = await pool.query(
        `SELECT payload,
        coalesce((SELECT jsonb_agg(s) FROM han_private.han_sessions s WHERE expires_at > $2
          AND ($1::text IS NULL OR token_hash = $1)), '[]') AS sessions
        FROM han_private.han_state WHERE id = 1`,
        [req ? sessionKey(req) : null, Date.now()],
      );
      if (!rows.length)
        throw Object.assign(new Error('Database must be imported before use'), { status: 503 });
      return { state: rows[0].payload, sessions: sessionsMap(rows[0].sessions) };
    },
    appendAudit(events) {
      return appendAudit(pool, events);
    },
    async listAudit({ category, action, actor, from, until, cursor }) {
      const values = [category];
      const conditions = ['category = $1'];
      const add = (sql, value) => {
        if (value) conditions.push(sql.replaceAll('?', '$' + values.push(value)));
      };
      add('action = ?', action);
      add('occurred_at >= ?::timestamptz', from);
      add('occurred_at < ?::timestamptz', until);
      add('id < ?::bigint', cursor);
      add(
        "(strpos(lower(coalesce(actor_name, '')), lower(?)) > 0 OR strpos(lower(coalesce(actor_username, '')), lower(?)) > 0)",
        actor,
      );
      const { rows } = await pool.query(
        `SELECT id::text, occurred_at AS at, category, action, area,
        actor_name, actor_username, record_ref, fields FROM han_private.han_audit
        WHERE ${conditions.join(' AND ')} ORDER BY han_audit.id DESC LIMIT ${PAGE_SIZE + 1}`,
        values,
      );
      return page(rows);
    },
    async readState() {
      const { rows } = await pool.query('SELECT payload FROM han_private.han_state WHERE id = 1');
      if (!rows.length)
        throw Object.assign(new Error('Database must be imported before use'), { status: 503 });
      return rows[0].payload;
    },
    async readPolicy() {
      const { rows } = await pool.query(
        "SELECT payload->'backupPolicy' AS policy FROM han_private.han_state WHERE id = 1",
      );
      if (!rows.length)
        throw Object.assign(new Error('Database must be imported before use'), { status: 503 });
      return rows[0].policy || {};
    },
    async updatePolicy(change) {
      return this.transaction(({ state, saveState }) => {
        const next = structuredClone(state);
        next.backupPolicy ||= {};
        const result = change(next.backupPolicy);
        if (result !== null) saveState(next);
        return result;
      });
    },
    async transaction(work) {
      return inTransaction(pool, (db) => mutateSnapshot(db, work));
    },
    async maintenance(work) {
      return inTransaction(pool, async (db) => {
        const { rows } = await db.query(`SELECT name FROM han_private.han_jobs
          WHERE name = 'workspace-maintenance' AND next_at <= clock_timestamp() FOR UPDATE SKIP LOCKED`);
        if (!rows.length) return false;
        // Login locks a rate counter before its account. Keep the same lock order
        // so maintenance cannot hold accounts while waiting for that login.
        await db.query('DELETE FROM han_private.han_login_attempts WHERE expires_at <= $1', [Date.now()]);
        await mutateSnapshot(db, work);
        await db.query(`UPDATE han_private.han_jobs SET next_at = clock_timestamp() + interval '60 seconds',
          last_success_at = clock_timestamp() WHERE name = 'workspace-maintenance'`);
        return true;
      });
    },
  };
}
module.exports = { createPool, migrate, validateState, importState, createStore };
