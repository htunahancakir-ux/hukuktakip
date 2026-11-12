const crypto = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');
const { hashPassword, verifyPassword, passwordValid } = require('../password-policy.cjs');
const totp = require('./totp.cjs');
const { createPlatformAdmin, verifySecondFactor } = require('./platform-auth.cjs');

const fail = (status, message) => Object.assign(new Error(message), { status });
const MIN_PASSWORD = 12;

async function record(db, adminId, action, target, detail) {
  await db.query('INSERT INTO han_saas.platform_audit(admin_id, action, target, detail) VALUES ($1, $2, $3, $4)', [
    adminId,
    action,
    target ?? null,
    detail ?? null,
  ]);
}

function checkNewPassword(password) {
  if (typeof password !== 'string' || !passwordValid(password) || password.length < MIN_PASSWORD)
    throw fail(400, `Şifre en az ${MIN_PASSWORD} karakter olmalıdır.`);
}

async function adminRow(db, id, { lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT id, username, name, salt, hash, active, totp_secret_enc, totp_pending_enc, totp_enabled_at,
            cardinality(recovery_hashes) AS recovery_left
     FROM han_saas.platform_admins WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [id],
  );
  if (!rows.length) throw fail(404, 'Operatör bulunamadı.');
  return rows[0];
}

async function accountInfo(pool, adminId, { requireTotp = false } = {}) {
  const row = await adminRow(pool, adminId);
  return {
    username: row.username,
    name: row.name,
    totpEnabled: !!row.totp_enabled_at,
    recoveryCodesLeft: row.totp_enabled_at ? row.recovery_left : 0,
    totpRequired: requireTotp === true,
  };
}

// Changing the password signs every other session out, so a stolen session cannot outlive it.
async function changePassword(pool, adminId, { current, next }, { keepTokenHash = '' } = {}) {
  checkNewPassword(next);
  const row = await adminRow(pool, adminId);
  if (!(await verifyPassword(String(current ?? ''), row))) throw fail(403, 'Mevcut şifre yanlış.');
  if (current === next) throw fail(400, 'Yeni şifre mevcut şifreden farklı olmalıdır.');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPassword(next, salt);
  await inTransaction(pool, async (db) => {
    await db.query('UPDATE han_saas.platform_admins SET salt = $2, hash = $3, password_changed_at = now() WHERE id = $1', [
      adminId,
      salt,
      hash,
    ]);
    await db.query('DELETE FROM han_saas.platform_sessions WHERE admin_id = $1 AND token_hash <> $2', [
      adminId,
      keepTokenHash,
    ]);
    await record(db, adminId, 'password.change', row.username);
  });
  return { ok: true };
}

// Step 1: create a pending secret. Nothing is enforced until the operator proves their
// authenticator works by confirming a code.
async function startTotpSetup(pool, adminId) {
  const row = await adminRow(pool, adminId);
  if (row.totp_enabled_at) throw fail(409, 'İki aşamalı doğrulama zaten etkin.');
  const secret = totp.newSecret();
  const sealed = totp.seal(secret); // fails closed (412) when no server key is configured
  await pool.query('UPDATE han_saas.platform_admins SET totp_pending_enc = $2 WHERE id = $1', [adminId, sealed]);
  return { secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri: totp.otpauthUri(secret, row.username) };
}

// Step 2: the code proves the secret reached the authenticator. Recovery codes are shown
// exactly once; only their hashes are kept.
async function confirmTotpSetup(pool, adminId, { code }) {
  const result = await inTransaction(pool, async (db) => {
    const row = await adminRow(db, adminId, { lock: true });
    if (row.totp_enabled_at) throw fail(409, 'İki aşamalı doğrulama zaten etkin.');
    if (!row.totp_pending_enc) throw fail(409, 'Önce kurulumu başlatın.');
    const step = totp.matchStep(totp.open(row.totp_pending_enc), code);
    if (step === null) throw fail(400, 'Kod doğru değil. Uygulamadaki güncel 6 haneli kodu girin.');
    const recoveryCodes = totp.newRecoveryCodes();
    await db.query(
      `UPDATE han_saas.platform_admins
       SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled_at = now(),
           totp_last_step = $2, recovery_hashes = $3
       WHERE id = $1`,
      [adminId, step, recoveryCodes.map(totp.recoveryHash)],
    );
    await record(db, adminId, 'totp.enable', row.username);
    return { recoveryCodes };
  });
  return result;
}

// Turning it off needs the password and a current code (or recovery code), so a hijacked
// session alone cannot strip the protection. Not allowed while the server requires it.
async function disableTotp(pool, adminId, { password, code }, { required = false } = {}) {
  if (required) throw fail(409, 'Bu sunucuda iki aşamalı doğrulama zorunludur.');
  const row = await adminRow(pool, adminId);
  if (!row.totp_enabled_at) throw fail(409, 'İki aşamalı doğrulama etkin değil.');
  if (!(await verifyPassword(String(password ?? ''), row))) throw fail(403, 'Şifre yanlış.');
  await inTransaction(pool, async (db) => {
    if (!(await verifySecondFactor(db, row, code))) throw fail(403, 'Doğrulama kodu yanlış.');
    await db.query(
      `UPDATE han_saas.platform_admins
       SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL,
           totp_last_step = 0, recovery_hashes = '{}'
       WHERE id = $1`,
      [adminId],
    );
    await record(db, adminId, 'totp.disable', row.username);
  });
  return { ok: true };
}

async function listOperators(pool) {
  const { rows } = await pool.query(
    `SELECT id, username, name, active, totp_enabled_at IS NOT NULL AS "totpEnabled", created_at AS "createdAt"
     FROM han_saas.platform_admins ORDER BY active DESC, username`,
  );
  return rows;
}

async function addOperator(pool, actorId, input) {
  const admin = await createPlatformAdmin(pool, input);
  await record(pool, actorId, 'operator.add', admin.username);
  return admin;
}

async function setOperatorActive(pool, actorId, { operatorId, active }) {
  if (typeof active !== 'boolean') throw fail(400, 'Durum geçersiz.');
  if (operatorId === actorId && !active) throw fail(409, 'Kendi hesabınızı pasife alamazsınız.');
  return inTransaction(pool, async (db) => {
    const target = await adminRow(db, operatorId, { lock: true });
    await db.query('UPDATE han_saas.platform_admins SET active = $2 WHERE id = $1', [operatorId, active]);
    if (!active) await db.query('DELETE FROM han_saas.platform_sessions WHERE admin_id = $1', [operatorId]);
    await record(db, actorId, active ? 'operator.enable' : 'operator.disable', target.username);
    return { id: operatorId, active };
  });
}

// For an operator who forgot their password. The new password is chosen by the resetting
// operator and handed over out of band; the target's sessions end immediately.
async function resetOperatorPassword(pool, actorId, { operatorId, password }) {
  if (operatorId === actorId) throw fail(409, 'Kendi şifrenizi "Hesabım" bölümünden değiştirin.');
  checkNewPassword(password);
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPassword(password, salt);
  return inTransaction(pool, async (db) => {
    const target = await adminRow(db, operatorId, { lock: true });
    await db.query('UPDATE han_saas.platform_admins SET salt = $2, hash = $3, password_changed_at = now() WHERE id = $1', [
      operatorId,
      salt,
      hash,
    ]);
    await db.query('DELETE FROM han_saas.platform_sessions WHERE admin_id = $1', [operatorId]);
    await record(db, actorId, 'operator.reset_password', target.username);
    return { ok: true };
  });
}

// For an operator who lost the phone and the recovery codes.
async function resetOperatorTotp(pool, actorId, { operatorId }) {
  if (operatorId === actorId) throw fail(409, 'Kendi doğrulamanızı "Hesabım" bölümünden kapatın.');
  return inTransaction(pool, async (db) => {
    const target = await adminRow(db, operatorId, { lock: true });
    await db.query(
      `UPDATE han_saas.platform_admins
       SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL,
           totp_last_step = 0, recovery_hashes = '{}'
       WHERE id = $1`,
      [operatorId],
    );
    await db.query('DELETE FROM han_saas.platform_sessions WHERE admin_id = $1', [operatorId]);
    await record(db, actorId, 'operator.reset_totp', target.username);
    return { ok: true };
  });
}

async function listAudit(pool, { limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT a.id::text AS id, a.action, a.target, a.detail, a.created_at AS "createdAt", p.username AS "by"
     FROM han_saas.platform_audit a JOIN han_saas.platform_admins p ON p.id = a.admin_id
     ORDER BY a.id DESC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 100, 1), 500)],
  );
  return rows;
}

module.exports = {
  accountInfo,
  changePassword,
  startTotpSetup,
  confirmTotpSetup,
  disableTotp,
  listOperators,
  addOperator,
  setOperatorActive,
  resetOperatorPassword,
  resetOperatorTotp,
  listAudit,
  record,
};
