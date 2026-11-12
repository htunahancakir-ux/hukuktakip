const crypto = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');
const { hashPassword } = require('../password-policy.cjs');
const { issueCode, smsPhone, message } = require('../sms-recovery.cjs');
const { maskNumber } = require('../verimor-sms.cjs');
const platformSms = require('./platform-sms.cjs');

// Operator-side password reset for an office's CEO or admin (a locked-out office manager calls
// support). Either a one-time SMS code is sent to the account's registered mobile (the manager
// then sets a new password from "Şifremi unuttum"), or a temporary password is generated and
// shown once to the operator, who reads it out to the verified person.

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (status, message) => Object.assign(new Error(message), { status });
const MANAGER = ['ceo', 'admin'];

async function lockState(db, tenantId) {
  const { rows } = await db.query('SELECT payload FROM han_private.han_state WHERE tenant_id = $1 AND id = 1 FOR UPDATE', [
    tenantId,
  ]);
  if (!rows.length) throw fail(404, 'Büro çalışma alanı bulunamadı.');
  const active = await db.query("SELECT 1 FROM han_data.control WHERE tenant_id = $1 AND id = 1 AND mode = 'active'", [tenantId]);
  if (active.rows.length) throw fail(409, 'Kayıt deposu etkin bürolarda şifre sıfırlama konsoldan henüz yapılamıyor.');
  return rows[0].payload;
}
async function saveState(db, tenantId, payload) {
  await db.query(
    `UPDATE han_private.han_state SET payload = $2::jsonb, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = $1 AND id = 1`,
    [tenantId, JSON.stringify(payload)],
  );
}

async function officeManagers(pool, tenantId) {
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) throw fail(404, 'Büro bulunamadı.');
  const { rows } = await pool.query('SELECT payload FROM han_private.han_state WHERE tenant_id = $1 AND id = 1', [tenantId]);
  if (!rows.length) return [];
  const state = rows[0].payload;
  return (state.users || [])
    .filter((user) => MANAGER.includes(user.role) && user.active !== false)
    .map((user) => ({
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      phone: maskNumber(smsPhone(state, user)) || null,
    }));
}

// mode 'sms': send a one-time code to the registered mobile. mode 'password': set a generated
// temporary password and return it once. Both end the account's open sessions only when the
// password itself changes (the SMS code changes nothing until it is used).
async function resetManager(pool, adminId, { tenantId, userId, mode }, { fetcher } = {}) {
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) throw fail(404, 'Büro bulunamadı.');
  if (!['sms', 'password'].includes(mode)) throw fail(400, 'Sıfırlama yöntemi geçersiz.');
  if (mode === 'sms') {
    const settings = platformSms.publicConfig(
      (await pool.query("SELECT value FROM han_saas.platform_settings WHERE key = 'sms'")).rows[0]?.value,
    );
    if (!settings.enabled) throw fail(412, 'Platform SMS hizmeti açık değil. Yönetim → SMS bölümünden ayarlayın.');
  }
  const temporary = mode === 'password' ? crypto.randomBytes(9).toString('base64url') : null; // 12 chars
  const salt = temporary ? crypto.randomBytes(16).toString('hex') : null;
  const hash = temporary ? await hashPassword(temporary, salt) : null;

  const outcome = await inTransaction(pool, async (db) => {
    const state = await lockState(db, tenantId);
    const user = (state.users || []).find((u) => u.id === userId);
    if (!user || !MANAGER.includes(user.role) || user.active === false)
      throw fail(404, 'Büroda bu yönetici hesabı bulunamadı.');
    let phone = null;
    let code = null;
    if (mode === 'sms') {
      phone = smsPhone(state, user);
      if (!phone) throw fail(409, 'Bu hesapta kayıtlı cep telefonu yok. Geçici şifre oluşturun.');
      code = issueCode(state, user, { force: true });
    } else {
      user.salt = salt;
      user.hash = hash;
      await db.query('DELETE FROM han_private.han_sessions WHERE tenant_id = $1 AND account_id = $2', [tenantId, user.id]);
    }
    await saveState(db, tenantId, state);
    await db.query('INSERT INTO han_saas.tenant_events(tenant_id, admin_id, action, detail) VALUES ($1, $2, $3, $4::jsonb)', [
      tenantId,
      adminId,
      'manager_password_reset',
      JSON.stringify({ mode, username: user.username, role: user.role }),
    ]);
    return { phone, code, username: user.username };
  });

  if (mode === 'sms') {
    // Sent after commit so a retried transaction can never send two codes.
    await platformSms.sendSms(pool, { to: outcome.phone, text: message(outcome.code), tenantId, purpose: 'operator_reset' }, { fetcher });
    return { mode, username: outcome.username, phone: maskNumber(outcome.phone) };
  }
  return { mode, username: outcome.username, temporaryPassword: temporary };
}

module.exports = { officeManagers, resetManager };
