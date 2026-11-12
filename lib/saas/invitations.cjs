const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');
const { buildUser, addUser } = require('./office-users.cjs');

const ROLES = { admin: 'admin', staff: 'member' }; // app role -> membership role
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (status, message) => Object.assign(new Error(message), { status });
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
// One message for every unusable invite: no oracle for guessing valid tokens.
const unusable = () => fail(404, 'Davet geçersiz veya süresi dolmuş.');

// A tenant is usable only while enabled and under a current subscription.
const USABLE = `t.status = 'enabled' AND s.status IN ('trialing', 'active') AND s.access_until > CURRENT_TIMESTAMP`;

async function requireManager(db, tenantId, userId) {
  if (typeof tenantId !== 'string' || !UUID.test(tenantId) || typeof userId !== 'string' || !userId)
    throw fail(403, 'Bu işlem için yetkiniz yok.');
  const { rows } = await db.query(
    `SELECT 1 FROM han_saas.memberships m
     JOIN han_saas.tenants t ON t.id = m.tenant_id
     JOIN han_saas.subscriptions s ON s.tenant_id = t.id
     WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'active'
       AND m.role IN ('owner', 'admin') AND ${USABLE}`,
    [tenantId, userId],
  );
  if (!rows.length) throw fail(403, 'Bu işlem için yetkiniz yok.');
}

// `invitedBy` must be the server-authenticated account id, never a browser value.
// The raw token is returned once and never stored; deliver it to the invitee yourself.
async function createInvitation(pool, { tenantId, invitedBy, role, note = null, ttlHours = 72 }) {
  if (!Object.hasOwn(ROLES, role)) throw fail(400, 'Geçersiz rol.');
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 720)
    throw fail(400, 'Davet süresi 1–720 saat olmalıdır.');
  if (note !== null && (typeof note !== 'string' || note.length > 160)) throw fail(400, 'Not çok uzun.');
  return inTransaction(pool, async (db) => {
    await requireManager(db, tenantId, invitedBy);
    const token = randomBytes(32).toString('base64url');
    const { rows } = await db.query(
      `INSERT INTO han_saas.invitations(id, tenant_id, token_hash, role, invited_by, note, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP + make_interval(hours => $7))
       RETURNING id, expires_at`,
      [randomUUID(), tenantId, hashToken(token), role, invitedBy, note, ttlHours],
    );
    return { id: rows[0].id, token, expiresAt: rows[0].expires_at };
  });
}

async function revokeInvitation(pool, { tenantId, invitationId, revokedBy }) {
  if (typeof invitationId !== 'string' || !UUID.test(invitationId)) throw fail(404, 'Davet bulunamadı.');
  return inTransaction(pool, async (db) => {
    await requireManager(db, tenantId, revokedBy);
    const { rows } = await db.query(
      `UPDATE han_saas.invitations SET revoked_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`,
      [invitationId, tenantId],
    );
    if (!rows.length) throw fail(404, 'Davet bulunamadı.');
  });
}

async function listInvitations(pool, { tenantId, requestedBy }) {
  return inTransaction(pool, async (db) => {
    await requireManager(db, tenantId, requestedBy);
    const { rows } = await db.query(
      `SELECT id, role, note, invited_by, expires_at, accepted_at, revoked_at, created_at
       FROM han_saas.invitations WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [tenantId],
    );
    return rows;
  });
}

// Public by nature (the invitee has no account yet): the token is the only credential.
// Creates the account, membership and consumes the invite in one transaction, and
// enforces the office's purchased user count while holding the subscription row lock,
// so two simultaneous acceptances cannot exceed it.
async function acceptInvitation(pool, { token, name, username, password }) {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw unusable();
  const user = await buildUser({ name, username, password, role: 'staff' });
  return inTransaction(pool, async (db) => {
    const { rows } = await db.query(
      `SELECT id, tenant_id, role FROM han_saas.invitations
       WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL
         AND expires_at > CURRENT_TIMESTAMP FOR UPDATE`,
      [hashToken(token)],
    );
    if (!rows.length) throw unusable();
    const invite = rows[0];
    const { rows: office } = await db.query(
      `SELECT t.slug, s.seat_limit FROM han_saas.subscriptions s
       JOIN han_saas.tenants t ON t.id = s.tenant_id
       WHERE s.tenant_id = $1 AND ${USABLE} FOR UPDATE OF s`,
      [invite.tenant_id],
    );
    if (!office.length) throw unusable();
    const { rows: used } = await db.query(
      `SELECT count(*)::int AS n FROM han_saas.memberships WHERE tenant_id = $1 AND status = 'active'`,
      [invite.tenant_id],
    );
    if (used[0].n >= office[0].seat_limit)
      throw fail(409, 'Büronun kullanıcı sayısı sınırına ulaşıldı. Büro yöneticisi kullanıcı sayısını artırmalıdır.');
    user.role = invite.role;
    await addUser(db, invite.tenant_id, user);
    await db.query(`INSERT INTO han_saas.memberships(tenant_id, user_id, role) VALUES ($1, $2, $3)`, [
      invite.tenant_id,
      user.id,
      ROLES[invite.role],
    ]);
    await db.query(
      'UPDATE han_saas.invitations SET accepted_at = CURRENT_TIMESTAMP, accepted_user_id = $2 WHERE id = $1',
      [invite.id, user.id],
    );
    return { tenantId: invite.tenant_id, slug: office[0].slug, userId: user.id, username: user.username };
  });
}

module.exports = { createInvitation, revokeInvitation, listInvitations, acceptInvitation };
