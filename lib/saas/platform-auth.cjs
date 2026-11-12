const crypto = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');
const { hashPassword, verifyPassword, passwordValid } = require('../password-policy.cjs');
const totp = require('./totp.cjs');

const COOKIE = 'han_platform';
const SESSION_MS = 8 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const normalize = (value) =>
  String(value || '')
    .trim()
    .toLocaleLowerCase('tr');

// Unknown usernames still pay for one scrypt so response time does not reveal them.
const decoy = (() => {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(crypto.randomBytes(16), salt, 64).toString('hex') };
})();

function tokenFromRequest(req) {
  const matches = String(req.headers.cookie || '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith(COOKIE + '='));
  if (matches.length !== 1) return '';
  const token = matches[0].slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : '';
}

function sessionCookie(token, { secure = true, maxAge } = {}) {
  const attributes = [`${COOKIE}=${token}`, 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/'];
  if (!secure) attributes.splice(2, 1); // plain-HTTP localhost only
  if (maxAge !== undefined) {
    attributes.push('Max-Age=' + maxAge);
    if (maxAge === 0) attributes.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  return attributes.join('; '); // host-only: never shared with office subdomains
}

// Operator accounts are created from a trusted shell (scripts/platform-admin.cjs),
// never through a public endpoint.
async function createPlatformAdmin(pool, { username, name, password }) {
  const login = normalize(username);
  if (!login || login.length > 60 || !String(name || '').trim() || String(name).length > 160)
    throw fail(400, 'Kullanıcı adı ve ad gerekli.');
  if (!passwordValid(password) || password.length < 12) throw fail(400, 'Şifre en az 12 karakter olmalıdır.');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPassword(password, salt);
  try {
    const { rows } = await pool.query(
      `INSERT INTO han_saas.platform_admins(id, username, name, salt, hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, username, name`,
      [crypto.randomUUID(), login, String(name).trim(), salt, hash],
    );
    return rows[0];
  } catch (error) {
    if (error.code === '23505') throw fail(409, 'Bu kullanıcı adı kullanılıyor.');
    throw error;
  }
}

async function consume(db, key, now) {
  await db.query(
    `INSERT INTO han_saas.platform_login_attempts(key, count, expires_at) VALUES ($1, 0, $2)
     ON CONFLICT (key) DO NOTHING`,
    [key, now + WINDOW_MS],
  );
  const { rows } = await db.query(
    'SELECT count, expires_at FROM han_saas.platform_login_attempts WHERE key = $1 FOR UPDATE',
    [key],
  );
  const live = Number(rows[0].expires_at) > now;
  const count = live ? rows[0].count : 0;
  if (count >= MAX_ATTEMPTS) return false;
  await db.query('UPDATE han_saas.platform_login_attempts SET count = $2, expires_at = $3 WHERE key = $1', [
    key,
    count + 1,
    live ? rows[0].expires_at : now + WINDOW_MS,
  ]);
  return true;
}

// Checks a second-factor code for an operator who has two-factor sign-in enabled. A
// six-digit authenticator code is accepted once per 30 s step (the step is stored and never
// reused); a recovery code is accepted once and then removed. Both are applied atomically.
async function verifySecondFactor(db, admin, code, now = Date.now()) {
  const supplied = String(code ?? '').trim();
  if (!supplied) return false;
  if (/^\d{6}$/.test(supplied)) {
    const step = totp.matchStep(totp.open(admin.totp_secret_enc), supplied, now);
    if (step === null) return false;
    const { rows } = await db.query(
      'UPDATE han_saas.platform_admins SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2 RETURNING id',
      [admin.id, step],
    );
    return rows.length === 1;
  }
  if (!totp.looksLikeRecovery(supplied)) return false;
  const { rows } = await db.query(
    `UPDATE han_saas.platform_admins SET recovery_hashes = array_remove(recovery_hashes, $2)
     WHERE id = $1 AND $2 = ANY(recovery_hashes) RETURNING id`,
    [admin.id, totp.recoveryHash(supplied)],
  );
  return rows.length === 1;
}

// `clientKey` is a hash of the caller's address. Both the address and the account are
// rate limited, so distributed guessing against one account is slowed too.
async function login(pool, { username, password, code, clientKey }) {
  const name = normalize(username);
  const now = Date.now();
  const allowed = await inTransaction(pool, async (db) => {
    const a = await consume(db, 'ip:' + clientKey, now);
    const b = await consume(db, 'user:' + digest(name), now);
    return a && b;
  });
  if (!allowed) throw fail(429, 'Çok fazla deneme yapıldı. 15 dakika sonra tekrar deneyin.');
  const { rows } = await pool.query(
    `SELECT id, username, name, salt, hash, totp_secret_enc FROM han_saas.platform_admins
     WHERE username = $1 AND active`,
    [name],
  );
  const admin = rows[0];
  const ok = await verifyPassword(password, admin || decoy);
  if (!admin || !ok) throw fail(401, 'Kullanıcı adı veya şifre yanlış.');
  if (admin.totp_secret_enc) {
    if (!String(code ?? '').trim())
      throw Object.assign(fail(401, 'Doğrulama kodunu girin.'), { totpRequired: true });
    if (!(await verifySecondFactor(pool, admin, code, now)))
      throw Object.assign(fail(401, 'Doğrulama kodu yanlış veya daha önce kullanılmış.'), { totpRequired: true });
  }
  const token = crypto.randomBytes(32).toString('hex');
  await inTransaction(pool, async (db) => {
    await db.query('DELETE FROM han_saas.platform_sessions WHERE expires_at <= $1', [now]);
    await db.query(
      'INSERT INTO han_saas.platform_sessions(token_hash, admin_id, expires_at) VALUES ($1, $2, $3)',
      [digest(token), admin.id, now + SESSION_MS],
    );
    await db.query('DELETE FROM han_saas.platform_login_attempts WHERE key = $1', ['user:' + digest(name)]);
  });
  return { token, maxAge: SESSION_MS / 1000, admin: { id: admin.id, username: admin.username, name: admin.name } };
}

async function authenticate(pool, req) {
  const token = tokenFromRequest(req);
  if (!token) throw fail(401, 'Oturum açmanız gerekiyor.');
  const { rows } = await pool.query(
    `SELECT a.id, a.username, a.name, a.totp_enabled_at IS NOT NULL AS "totpEnabled"
     FROM han_saas.platform_sessions s
     JOIN han_saas.platform_admins a ON a.id = s.admin_id
     WHERE s.token_hash = $1 AND s.expires_at > $2 AND a.active`,
    [digest(token), Date.now()],
  );
  if (!rows.length) throw fail(401, 'Oturum açmanız gerekiyor.');
  return rows[0];
}

async function logout(pool, req) {
  const token = tokenFromRequest(req);
  if (token) await pool.query('DELETE FROM han_saas.platform_sessions WHERE token_hash = $1', [digest(token)]);
}

const sessionTokenHash = (req) => {
  const token = tokenFromRequest(req);
  return token ? digest(token) : '';
};

module.exports = {
  createPlatformAdmin,
  login,
  authenticate,
  logout,
  sessionCookie,
  verifySecondFactor,
  sessionTokenHash,
  COOKIE,
};
