const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { PAGE_SIZE, page } = require('./audit.cjs');

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

function prune(entries) {
  return new Map(Object.entries(entries || {}).filter(([, value]) => value.until > Date.now()));
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

function createStore(pool) {
  return {
    async readSessionContext() {
      const { rows } = await pool.query('SELECT payload, sessions FROM han_private.han_state WHERE id = 1');
      if (!rows.length)
        throw Object.assign(new Error('Database must be imported before use'), { status: 503 });
      return { state: rows[0].payload, sessions: prune(rows[0].sessions) };
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
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        await db.query("SET LOCAL lock_timeout = '10s'");
        await db.query("SET LOCAL statement_timeout = '15s'");
        const { rows } = await db.query(
          'SELECT payload, sessions, attempts FROM han_private.han_state WHERE id = 1 FOR UPDATE',
        );
        if (!rows.length)
          throw Object.assign(new Error('Database must be imported before use'), { status: 503 });
        let state = rows[0].payload;
        const original = JSON.stringify(state);
        const sessions = prune(rows[0].sessions),
          attempts = prune(rows[0].attempts);
        const result = await work({
          state,
          sessions,
          attempts,
          saveState(next) {
            state = next;
          },
          appendAudit: (events) => appendAudit(db, events),
        });
        const serialized = JSON.stringify(state);
        await db.query(
          `UPDATE han_private.han_state SET payload = $1::jsonb, sessions = $2::jsonb,
          attempts = $3::jsonb, revision = revision + $4, updated_at = CURRENT_TIMESTAMP WHERE id = 1`,
          [
            serialized,
            JSON.stringify(Object.fromEntries(sessions)),
            JSON.stringify(Object.fromEntries(attempts)),
            serialized === original ? 0 : 1,
          ],
        );
        await db.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await db.query('ROLLBACK');
        } catch {}
        throw error;
      } finally {
        db.release();
      }
    },
  };
}
module.exports = { createPool, migrate, validateState, importState, createStore };
