const { isDeepStrictEqual } = require('node:util');
const { inTransaction } = require('./db-transaction.cjs');
const { sessionKey, attemptKey } = require('./session-policy.cjs');
const { limits } = require('./rate-policy.cjs');

function sessionsMap(rows) {
  return new Map(
    rows.map((row) => [
      row.token_hash,
      {
        id: row.account_id,
        deviceType: row.device_type,
        until: Number(row.expires_at),
        seenAt: row.seen_at === null ? undefined : Number(row.seen_at),
      },
    ]),
  );
}
async function readSessions(db, accountId) {
  const { rows } = await db.query(
    'SELECT * FROM han_private.han_sessions WHERE expires_at > $1' +
      (accountId === undefined ? '' : ' AND account_id = $2'),
    accountId === undefined ? [Date.now()] : [Date.now(), accountId],
  );
  return sessionsMap(rows);
}
async function flushSessions(db, before, after) {
  for (const [key] of before) {
    if (!after.has(key)) await db.query('DELETE FROM han_private.han_sessions WHERE token_hash = $1', [key]);
  }
  for (const [key, session] of after) {
    if (isDeepStrictEqual(session, before.get(key))) continue;
    if (!Number.isSafeInteger(session.until)) continue;
    await db.query(
      `INSERT INTO han_private.han_sessions(token_hash, account_id, device_type, expires_at, seen_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (token_hash) DO UPDATE
       SET expires_at = EXCLUDED.expires_at, seen_at = EXCLUDED.seen_at`,
      [
        key,
        session.id,
        ['desktop', 'mobile'].includes(session.deviceType) ? session.deviceType : null,
        session.until,
        Number.isSafeInteger(session.seenAt) ? session.seenAt : null,
      ],
    );
  }
}
function identityContext(accounts, sessions) {
  const byId = new Map(accounts.map((row) => [row.id, row]));
  return {
    state: { users: accounts.map((row) => row.body), data: { 'icrapro-personnel-v1': [] } },
    sessions,
    userEnabled: (user) => !!byId.get(user?.id)?.enabled,
    employeeTermsRequired: (user) => !!byId.get(user?.id)?.terms_required,
  };
}

function createSecurityStore(pool, appendAudit) {
  return {
    async consumeAttempt(req, pathname, secureCookies) {
      if (req.method !== 'POST' || !limits[pathname]) return false;
      const [bucket, maximum] = limits[pathname];
      const key = bucket + ':' + attemptKey(req, secureCookies),
        now = Date.now();
      const allowed = await inTransaction(pool, async (db) => {
        await db.query(
          `INSERT INTO han_private.han_login_attempts(key, count, expires_at)
          VALUES ($1, 0, $2) ON CONFLICT (key) DO NOTHING`,
          [key, now + 900000],
        );
        const { rows } = await db.query(
          'SELECT * FROM han_private.han_login_attempts WHERE key = $1 FOR UPDATE',
          [key],
        );
        const row = rows[0],
          count = Number(row.expires_at) > now ? row.count : 0;
        if (count >= maximum) return false;
        await db.query(
          'UPDATE han_private.han_login_attempts SET count = $2, expires_at = $3 WHERE key = $1',
          [key, count + 1, Number(row.expires_at) > now ? row.expires_at : now + 900000],
        );
        return true;
      });
      if (!allowed)
        throw Object.assign(new Error('Çok fazla deneme yapıldı. 15 dakika sonra tekrar deneyin.'), {
          status: 429,
        });
      return true;
    },
    async readIdentity(req, { presence = false, activity = false } = {}) {
      // One statement gives a coherent auth/session snapshot without locking business data.
      const { rows } = await pool.query(
        `SELECT coalesce((SELECT jsonb_agg(a) FROM han_private.han_account_index a
          WHERE $2::boolean OR a.id = (SELECT account_id FROM han_private.han_sessions
          WHERE token_hash = $1 AND expires_at > $3)), '[]') AS accounts,
          coalesce((SELECT jsonb_agg(s) FROM han_private.han_sessions s
          WHERE expires_at > $3 AND ($2::boolean OR token_hash = $1)), '[]') AS sessions,
          CASE WHEN $4::boolean THEN (SELECT body FROM han_private.han_activity WHERE id = 1) END AS activity`,
        [sessionKey(req), presence, Date.now(), activity],
      );
      const row = rows[0];
      const ctx = identityContext(row.accounts, sessionsMap(row.sessions));
      Object.assign(ctx.state, row.activity || {});
      return ctx;
    },
    async touch(req) {
      const now = Date.now();
      // UPDATE only. Never recreate a session revoked by another request.
      await pool.query(
        `UPDATE han_private.han_sessions SET seen_at = $2
        WHERE token_hash = $1 AND expires_at > $2
        AND (seen_at IS NULL OR seen_at < $2 - 30000)`,
        [sessionKey(req), now],
      );
    },
    async transaction(req, raw, secureCookies, work) {
      return inTransaction(pool, async (db) => {
        const isLogin = req.url?.split('?')[0] === '/api/login';
        let username = '';
        if (isLogin) {
          try {
            username = String(JSON.parse(raw).username || '')
              .trim()
              .toLocaleLowerCase('tr');
          } catch {}
        }
        const rateKey = attemptKey(req, secureCookies);
        const attempts = new Map();
        if (isLogin) {
          await db.query(
            `INSERT INTO han_private.han_login_attempts(key, count, expires_at)
            VALUES ($1, 0, $2) ON CONFLICT (key) DO NOTHING`,
            [rateKey, Date.now() + 900000],
          );
          const { rows } = await db.query(
            'SELECT * FROM han_private.han_login_attempts WHERE key = $1 FOR UPDATE',
            [rateKey],
          );
          const row = rows[0];
          attempts.set(rateKey, { count: row.count, until: Number(row.expires_at) });
        }
        // Serializes takeovers for this account, including attempts from different IPs.
        const { rows: accounts } = await db.query(
          `SELECT * FROM han_private.han_account_index WHERE ${
            isLogin
              ? 'username = $1'
              : 'id = (SELECT account_id FROM han_private.han_sessions WHERE token_hash = $1 AND expires_at > $2)'
          }
           FOR UPDATE`,
          isLogin ? [username] : [sessionKey(req), Date.now()],
        );
        const id = accounts[0]?.id || '';
        await db.query('DELETE FROM han_private.han_sessions WHERE account_id = $1 AND expires_at <= $2', [
          id,
          Date.now(),
        ]);
        const sessions = await readSessions(db, id);
        const original = structuredClone(sessions);
        const ctx = identityContext(accounts, sessions);
        const result = await work({
          ...ctx,
          attempts,
          saveState() {
            throw new Error('Identity routes cannot write business state');
          },
          appendAudit: (events) => appendAudit(db, events),
        });
        await flushSessions(db, original, sessions);
        if (isLogin) {
          const rate = attempts.get(rateKey);
          if (rate)
            await db.query(
              'UPDATE han_private.han_login_attempts SET count = $2, expires_at = $3 WHERE key = $1',
              [rateKey, rate.count, rate.until],
            );
          else await db.query('DELETE FROM han_private.han_login_attempts WHERE key = $1', [rateKey]);
        }
        return result;
      });
    },
  };
}
module.exports = { createSecurityStore, readSessions, flushSessions, sessionsMap };
