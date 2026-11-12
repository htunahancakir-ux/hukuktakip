const { randomBytes, randomUUID } = require('node:crypto');
const { hashPassword, passwordValid } = require('../password-policy.cjs');

const fail = (status, message) => Object.assign(new Error(message), { status });

// Same account shape and rules as the in-app account creation (access-server newUser),
// computed before any transaction so scrypt never runs while locks are held.
async function buildUser({ name, username, password, role }) {
  const login = String(username || '')
    .trim()
    .toLocaleLowerCase('tr');
  const display = String(name || '').trim();
  if (!display || display.length > 160 || !login || login.length > 60 || !passwordValid(password))
    throw fail(400, 'Ad, kullanıcı adı ve en az 10 karakterli şifre girin.');
  const salt = randomBytes(16).toString('hex');
  return {
    id: randomUUID(),
    username: login,
    name: display,
    salt,
    hash: await hashPassword(password, salt),
    role: ['ceo', 'admin'].includes(role) ? role : 'staff',
    staffId: '',
    permissions: [],
    active: true,
    readOnly: false,
  };
}

// Adds an account to an office's legacy workspace state under the same row lock the
// application uses. Offices whose record store is active keep accounts elsewhere;
// that path is not supported here and fails closed instead of writing a frozen source.
async function addUser(db, tenantId, user) {
  const { rows } = await db.query(
    'SELECT payload FROM han_private.han_state WHERE tenant_id = $1 AND id = 1 FOR UPDATE',
    [tenantId],
  );
  if (!rows.length) throw fail(503, 'Büro çalışma alanı hazır değil.');
  const active = await db.query(
    "SELECT 1 FROM han_data.control WHERE tenant_id = $1 AND id = 1 AND mode = 'active'",
    [tenantId],
  );
  if (active.rows.length) throw fail(409, 'Kayıt deposu etkin bürolarda kullanıcı ekleme henüz desteklenmiyor.');
  const payload = rows[0].payload;
  if (payload.users.some((existing) => existing.username === user.username))
    throw fail(409, 'Kullanıcı adı kullanılıyor.');
  payload.users.push(user);
  await db.query(
    `UPDATE han_private.han_state SET payload = $2::jsonb, revision = revision + 1,
     updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $1 AND id = 1`,
    [tenantId, JSON.stringify(payload)],
  );
}

module.exports = { buildUser, addUser };
