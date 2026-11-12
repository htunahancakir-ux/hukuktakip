const crypto = require('node:crypto');
const { randomUUID } = crypto;
const { inTransaction } = require('../db-transaction.cjs');
const { record } = require('./platform-account.cjs');

// Remote support access (han_saas.support_access). An office CEO or admin grants the platform's
// support team access to the office for 15, 30 or 60 minutes; the clock starts when an operator
// first connects. The operator may add 15 minutes once; more time is asked of the office. The
// team works through the office's hidden support account (outputs/icrapro/access-support-account.cjs):
// a connection is an ordinary office session for that account whose expiry is the grant's
// deadline, so every existing check (read-only, roles, audit) applies unchanged, and the
// session ends by itself when time is up.

const SUPPORT_ACCOUNT_ID = 'platform-support';
const MINUTES = [15, 30, 60];
const OFFER_HOURS = 24; // a grant nobody used lapses after this
const CODE_SECONDS = 120; // an entry link works once, within 2 minutes
const SELF_EXTENSION = 15; // minutes the operator may add once on their own
const EXTEND_WINDOW_MINUTES = 5; // ... from 5 minutes before the deadline
const GRACE_MINUTES = 30; // after the deadline, time can still be added for this long
const REQUEST_GRACE_MINUTES = 120; // ... or, with an extension asked of the office, this long
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MANAGERS = ['ceo', 'admin'];
const fail = (status, message) => Object.assign(new Error(message), { status });
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const label = (user) => String(user?.name || user?.username || 'Büro kullanıcısı').slice(0, 160);

function uuid(value, what = 'Kayıt') {
  if (typeof value !== 'string' || !UUID.test(value)) throw fail(404, `${what} bulunamadı.`);
  return value;
}

// Grants whose time is over are closed lazily, whenever the office or the console looks.
async function settle(db, tenantId = null) {
  await db.query(
    `UPDATE han_saas.support_access SET status = 'expired', ended_at = CURRENT_TIMESTAMP, ended_by_label = 'Süre doldu'
     WHERE ($1::uuid IS NULL OR tenant_id = $1) AND (
       (status = 'pending' AND offer_until <= CURRENT_TIMESTAMP)
       OR (status = 'active' AND extension_requested_minutes IS NULL
           AND deadline <= CURRENT_TIMESTAMP - make_interval(mins => ${GRACE_MINUTES}))
       OR (status = 'active' AND deadline <= CURRENT_TIMESTAMP - make_interval(mins => ${REQUEST_GRACE_MINUTES})))`,
    [tenantId],
  );
}

// Moves the support account's sessions in this office to the grant's deadline (or ends them).
async function syncSessions(db, tenantId, deadline) {
  if (deadline)
    await db.query(
      'UPDATE han_private.han_sessions SET expires_at = $3 WHERE tenant_id = $1 AND account_id = $2',
      [tenantId, SUPPORT_ACCOUNT_ID, new Date(deadline).getTime()],
    );
  else
    await db.query('DELETE FROM han_private.han_sessions WHERE tenant_id = $1 AND account_id = $2', [
      tenantId,
      SUPPORT_ACCOUNT_ID,
    ]);
}

// A system line on the ticket: by the operator (adminId) or by an office user (by).
async function note(db, ticketId, body, { adminId = null, by = null } = {}) {
  await db.query(
    "INSERT INTO han_saas.support_messages(ticket_id, kind, author_id, author_label, body) VALUES ($1, 'system', $2, $3, $4)",
    [ticketId, adminId, adminId ? null : String(by || 'Büro').slice(0, 160), body.slice(0, 5000)],
  );
  await db.query('UPDATE han_saas.support_tickets SET updated_at = clock_timestamp() WHERE id = $1', [
    ticketId,
  ]);
}

const ACCESS_FIELDS = `a.id, a.tenant_id, a.ticket_id, a.granted_by_user, a.granted_by_label, a.allow_edit, a.minutes,
  a.status, a.created_at, a.offer_until, a.started_at, a.deadline, a.self_extended, a.extension_requested_minutes,
  a.extension_requested_at, a.extension_note, a.ended_at, a.ended_by_label, a.connected_admin_id`;

function view(a, now = Date.now()) {
  if (!a) return null;
  const deadline = a.deadline ? new Date(a.deadline).getTime() : null;
  const connected = a.status === 'active' && deadline > now;
  return {
    id: a.id,
    ticketId: a.ticket_id,
    status: a.status,
    // pending: waiting for the team; connected: inside the office now; overtime: time is up,
    // more can still be added; closed: ended, revoked or lapsed.
    state:
      a.status === 'pending'
        ? 'pending'
        : connected
          ? 'connected'
          : a.status === 'active'
            ? 'overtime'
            : 'closed',
    minutes: a.minutes,
    allowEdit: a.allow_edit,
    grantedBy: a.granted_by_label,
    grantedByUser: a.granted_by_user,
    offerUntil: a.offer_until,
    startedAt: a.started_at,
    deadline: a.deadline,
    remainingSeconds: deadline ? Math.max(0, Math.round((deadline - now) / 1000)) : null,
    selfExtended: a.self_extended,
    extensionRequest: a.extension_requested_minutes
      ? { minutes: a.extension_requested_minutes, note: a.extension_note, at: a.extension_requested_at }
      : null,
    endedAt: a.ended_at,
    endedBy: a.ended_by_label,
  };
}

// ---------------------------------------------------------------------------- office side

function createSupportAccess(pool, { tenantId }) {
  async function openGrant(db, { lock = false } = {}) {
    await settle(db, tenantId);
    const { rows } = await db.query(
      `SELECT ${ACCESS_FIELDS} FROM han_saas.support_access a
       WHERE a.tenant_id = $1 AND a.status IN ('pending', 'active') ${lock ? 'FOR UPDATE' : ''}`,
      [tenantId],
    );
    return rows[0] || null;
  }
  const mayDecide = (user, grant) =>
    MANAGERS.includes(user?.role) || grant.granted_by_user === String(user?.id);

  return {
    // Written after the office's own transaction created/updated the support account.
    async grant(user, { ticketId, minutes, allowEdit }) {
      uuid(ticketId, 'Destek kaydı');
      if (!MINUTES.includes(minutes)) throw fail(400, 'Erişim süresini seçin: 15 dk, 30 dk veya 1 saat.');
      return inTransaction(pool, async (db) => {
        const { rows: ticket } = await db.query(
          'SELECT id, status FROM han_saas.support_tickets WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
          [ticketId, tenantId],
        );
        if (!ticket.length) throw fail(404, 'Destek kaydı bulunamadı.');
        if (ticket[0].status === 'closed') throw fail(409, 'Kapatılmış bir kayda erişim izni verilemez.');
        // A new grant replaces any open one (and ends its connection).
        const previous = await openGrant(db, { lock: true });
        if (previous) {
          await db.query(
            `UPDATE han_saas.support_access SET status = CASE WHEN status = 'pending' THEN 'expired' ELSE 'ended' END,
               ended_at = CURRENT_TIMESTAMP, ended_by_label = 'Yeni izin verildi' WHERE id = $1`,
            [previous.id],
          );
          await syncSessions(db, tenantId, null);
        }
        const id = randomUUID();
        await db.query(
          `INSERT INTO han_saas.support_access(id, tenant_id, ticket_id, granted_by_user, granted_by_label, allow_edit, minutes, offer_until)
           VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP + make_interval(hours => ${OFFER_HOURS}))`,
          [id, tenantId, ticketId, String(user.id).slice(0, 100), label(user), allowEdit === true, minutes],
        );
        await note(
          db,
          ticketId,
          `${label(user)} destek ekibine ${minutes} dk erişim izni verdi (${allowEdit ? 'değişiklik yapabilir' : 'yalnızca görüntüleme'}). Süre ilk bağlantıda başlar.`,
          { by: label(user) },
        );
        return { id, minutes, allowEdit: allowEdit === true };
      });
    },

    // What the office screen shows: the open grant (with time left and any extension asked
    // for) to managers, to whoever granted it and to the support account itself; and the
    // person's tickets that support answered ("sorun çözüldü, test edin").
    async status(user) {
      return inTransaction(pool, async (db) => {
        const grant = await openGrant(db);
        const manager = MANAGERS.includes(user?.role);
        const visible =
          grant && (manager || user?.platformSupport || grant.granted_by_user === String(user?.id));
        const { rows: answered } = await db.query(
          `SELECT t.id, t.ticket_no::int AS number, t.subject,
             (SELECT m.body FROM han_saas.support_messages m WHERE m.ticket_id = t.id AND m.kind = 'operator'
              ORDER BY m.id DESC LIMIT 1) AS reply
           FROM han_saas.support_tickets t
           -- The opener confirms the fix; tickets an operator recorded (no opener) go to managers.
           WHERE t.tenant_id = $1 AND t.status = 'waiting_customer'
             AND (t.opened_by_user = $3 OR ($2 AND t.opened_by_user IS NULL))
           ORDER BY t.updated_at DESC LIMIT 5`,
          [tenantId, manager && !user?.platformSupport, String(user?.id || '')],
        );
        return {
          access: visible
            ? { ...view(grant), canDecide: !user?.platformSupport && mayDecide(user, grant) }
            : null,
          self: user?.platformSupport ? view(grant) : null,
          answered: user?.platformSupport
            ? []
            : answered.map((t) => ({
                ticketId: t.id,
                number: t.number,
                subject: t.subject,
                reply: (t.reply || '').slice(0, 300),
              })),
        };
      });
    },

    async decideExtension(user, accessId, approve) {
      uuid(accessId, 'Erişim izni');
      return inTransaction(pool, async (db) => {
        const grant = await openGrant(db, { lock: true });
        if (!grant || grant.id !== accessId) throw fail(404, 'Açık bir erişim izni bulunamadı.');
        if (user?.platformSupport || !mayDecide(user, grant))
          throw fail(403, 'Ek süreyi CEO, yönetici veya izni veren onaylar.');
        if (!grant.extension_requested_minutes) throw fail(409, 'Bekleyen bir ek süre talebi yok.');
        const minutes = grant.extension_requested_minutes;
        if (approve) {
          const { rows } = await db.query(
            `UPDATE han_saas.support_access SET deadline = GREATEST(deadline, CURRENT_TIMESTAMP) + make_interval(mins => $2::int),
               extension_requested_minutes = NULL, extension_requested_at = NULL, extension_note = NULL
             WHERE id = $1 RETURNING deadline`,
            [grant.id, minutes],
          );
          await syncSessions(db, tenantId, rows[0].deadline);
          await note(db, grant.ticket_id, `${label(user)} ${minutes} dk ek süreyi onayladı.`, {
            by: label(user),
          });
          return { approved: true, deadline: rows[0].deadline };
        }
        await db.query(
          `UPDATE han_saas.support_access SET extension_requested_minutes = NULL, extension_requested_at = NULL,
             extension_note = NULL WHERE id = $1`,
          [grant.id],
        );
        await note(db, grant.ticket_id, `${label(user)} ${minutes} dk ek süre talebini reddetti.`, {
          by: label(user),
        });
        return { approved: false };
      });
    },

    // "Erişimi sonlandır": the support team is out at once.
    async end(user, accessId) {
      uuid(accessId, 'Erişim izni');
      return inTransaction(pool, async (db) => {
        const grant = await openGrant(db, { lock: true });
        if (!grant || grant.id !== accessId) throw fail(404, 'Açık bir erişim izni bulunamadı.');
        if (user?.platformSupport || !mayDecide(user, grant))
          throw fail(403, 'Erişimi CEO, yönetici veya izni veren sonlandırır.');
        await db.query(
          `UPDATE han_saas.support_access SET status = 'revoked', ended_at = CURRENT_TIMESTAMP, ended_by_label = $2,
             extension_requested_minutes = NULL, extension_requested_at = NULL, extension_note = NULL
           WHERE id = $1`,
          [grant.id, label(user)],
        );
        await syncSessions(db, tenantId, null);
        await note(db, grant.ticket_id, `${label(user)} destek erişimini sonlandırdı.`, { by: label(user) });
        return { ended: true };
      });
    },

    // The access link. Checks the one-time code against this office, starts the clock on the
    // first entry and returns a session token for the support account, valid until the deadline.
    async enter(code) {
      if (typeof code !== 'string' || !/^[a-f0-9]{64}$/.test(code))
        throw fail(403, 'Destek bağlantısı geçersiz.');
      return inTransaction(pool, async (db) => {
        await settle(db, tenantId);
        const { rows } = await db.query(
          `SELECT c.code_hash, c.admin_id, c.expires_at, c.used_at, ${ACCESS_FIELDS}
           FROM han_saas.support_access_codes c JOIN han_saas.support_access a ON a.id = c.access_id
           WHERE c.code_hash = $1 FOR UPDATE OF c, a`,
          [sha256(code)],
        );
        const row = rows[0];
        // The same answer for every failure: an unknown, used, late or foreign code.
        const invalid = () =>
          fail(403, 'Destek bağlantısı geçersiz veya süresi dolmuş. Konsoldan yeniden bağlanın.');
        if (
          !row ||
          row.tenant_id !== tenantId ||
          row.used_at ||
          new Date(row.expires_at).getTime() <= Date.now()
        )
          throw invalid();
        if (!['pending', 'active'].includes(row.status)) throw invalid();
        await db.query(
          'UPDATE han_saas.support_access_codes SET used_at = CURRENT_TIMESTAMP WHERE code_hash = $1',
          [row.code_hash],
        );
        let deadline = row.deadline;
        if (row.status === 'pending') {
          const { rows: started } = await db.query(
            `UPDATE han_saas.support_access SET status = 'active', started_at = CURRENT_TIMESTAMP,
               deadline = CURRENT_TIMESTAMP + make_interval(mins => minutes), connected_admin_id = $2
             WHERE id = $1 RETURNING deadline`,
            [row.id, row.admin_id],
          );
          deadline = started[0].deadline;
          await note(db, row.ticket_id, `Destek ekibi büroya bağlandı. Süre başladı: ${row.minutes} dk.`, {
            adminId: row.admin_id,
          });
        } else if (new Date(deadline).getTime() <= Date.now())
          throw fail(403, 'Destek erişiminin süresi doldu.');
        const { rows: account } = await db.query(
          'SELECT 1 FROM han_private.han_account_index WHERE tenant_id = $1 AND id = $2 AND enabled',
          [tenantId, SUPPORT_ACCOUNT_ID],
        );
        if (!account.length) throw fail(409, 'Büroda destek hesabı hazır değil. Büro izni yeniden versin.');
        const token = crypto.randomBytes(32).toString('hex');
        const expires = new Date(deadline).getTime();
        await db.query(
          `INSERT INTO han_private.han_sessions(tenant_id, token_hash, account_id, device_type, expires_at, seen_at)
           VALUES ($1, $2, $3, 'desktop', $4, $5)
           ON CONFLICT (tenant_id, account_id, device_type) DO UPDATE
           SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, seen_at = EXCLUDED.seen_at`,
          [tenantId, sha256(token), SUPPORT_ACCOUNT_ID, expires, Date.now()],
        );
        await db.query(
          'INSERT INTO han_saas.tenant_events(tenant_id, admin_id, action, detail) VALUES ($1, $2, $3, $4::jsonb)',
          [tenantId, row.admin_id, 'support_access_entered', JSON.stringify({ access: row.id, deadline })],
        );
        return { token, deadline, maxAgeSeconds: Math.max(1, Math.round((expires - Date.now()) / 1000)) };
      });
    },
  };
}

// --------------------------------------------------------------------------- console side

async function ticketGrant(db, ticketId, { lock = false } = {}) {
  uuid(ticketId, 'Destek kaydı');
  const { rows: t } = await db.query('SELECT tenant_id FROM han_saas.support_tickets WHERE id = $1', [
    ticketId,
  ]);
  if (!t.length) throw fail(404, 'Destek kaydı bulunamadı.');
  await settle(db, t[0].tenant_id);
  const { rows } = await db.query(
    `SELECT ${ACCESS_FIELDS}, tn.slug, tn.name AS office FROM han_saas.support_access a
     JOIN han_saas.tenants tn ON tn.id = a.tenant_id
     WHERE a.ticket_id = $1 AND a.status IN ('pending', 'active') ${lock ? 'FOR UPDATE OF a' : ''}`,
    [ticketId],
  );
  return rows[0] || null;
}

// The ticket's grants for the console: the open one first, then the history.
async function ticketAccess(pool, ticketId) {
  uuid(ticketId, 'Destek kaydı');
  return inTransaction(pool, async (db) => {
    await ticketGrant(db, ticketId);
    const { rows } = await db.query(
      `SELECT ${ACCESS_FIELDS}, pa.name AS admin_name FROM han_saas.support_access a
       LEFT JOIN han_saas.platform_admins pa ON pa.id = a.connected_admin_id
       WHERE a.ticket_id = $1 ORDER BY a.created_at DESC LIMIT 20`,
      [ticketId],
    );
    return {
      access: rows.map((r) => ({ ...view(r), connectedBy: r.admin_name || null })),
    };
  });
}

// "Büroya bağlan": a one-time entry code for the office's access link. Operators need
// two-step sign-in for this: the link opens the office's client and debtor data.
async function connect(pool, admin, { ticketId }) {
  if (!admin?.totpEnabled)
    throw fail(403, 'Büroya bağlanmak için hesabınızda iki aşamalı doğrulamayı açın (Yönetim → Hesabım).');
  return inTransaction(pool, async (db) => {
    const grant = await ticketGrant(db, ticketId, { lock: true });
    if (!grant) throw fail(409, 'Bu kayıtta geçerli bir erişim izni yok.');
    if (grant.status === 'active' && new Date(grant.deadline).getTime() <= Date.now())
      throw fail(409, 'Erişim süresi doldu. Süreyi uzatın veya büroya ek süre talebi gönderin.');
    const code = crypto.randomBytes(32).toString('hex');
    await db.query(
      `INSERT INTO han_saas.support_access_codes(code_hash, access_id, admin_id, expires_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP + make_interval(secs => ${CODE_SECONDS}))`,
      [sha256(code), grant.id, admin.id],
    );
    await record(db, admin.id, 'support.connect', grant.tenant_id, `${grant.office} · ${grant.minutes} dk`);
    return {
      code,
      tenantId: grant.tenant_id,
      slug: grant.slug,
      path: '/api/support-access/enter?code=' + code,
    };
  });
}

// "+15 dk": once per grant, from 5 minutes before the deadline (or after it, within 30 min).
async function extend(pool, adminId, { ticketId }) {
  return inTransaction(pool, async (db) => {
    const grant = await ticketGrant(db, ticketId, { lock: true });
    if (!grant || grant.status !== 'active') throw fail(409, 'Uzatılacak açık bir bağlantı yok.');
    if (grant.self_extended)
      throw fail(409, 'Ek 15 dakika zaten kullanıldı. Büroya ek süre talebi gönderin.');
    const left = new Date(grant.deadline).getTime() - Date.now();
    if (left > EXTEND_WINDOW_MINUTES * 60000)
      throw fail(409, `Süre, son ${EXTEND_WINDOW_MINUTES} dakikada uzatılabilir.`);
    const { rows } = await db.query(
      `UPDATE han_saas.support_access SET deadline = GREATEST(deadline, CURRENT_TIMESTAMP) + make_interval(mins => ${SELF_EXTENSION}),
         self_extended = true WHERE id = $1 RETURNING deadline`,
      [grant.id],
    );
    await syncSessions(db, grant.tenant_id, rows[0].deadline);
    await note(db, grant.ticket_id, `Destek ekibi süreyi ${SELF_EXTENSION} dk uzattı.`, { adminId });
    await record(db, adminId, 'support.extend', grant.tenant_id, `${grant.office} +${SELF_EXTENSION} dk`);
    return { deadline: rows[0].deadline };
  });
}

// "Ek süre iste": the office sees it on its screen and approves or refuses.
async function requestExtension(pool, adminId, { ticketId, minutes, note: text }) {
  if (!MINUTES.includes(minutes)) throw fail(400, 'Ek süre 15, 30 veya 60 dakika olabilir.');
  const reason = text === undefined || text === null ? '' : String(text).trim();
  if (reason.length > 300) throw fail(400, 'Not en fazla 300 karakter olabilir.');
  return inTransaction(pool, async (db) => {
    const grant = await ticketGrant(db, ticketId, { lock: true });
    if (!grant || grant.status !== 'active') throw fail(409, 'Ek süre istenecek açık bir bağlantı yok.');
    await db.query(
      `UPDATE han_saas.support_access SET extension_requested_minutes = $2, extension_requested_at = CURRENT_TIMESTAMP,
         extension_note = $3 WHERE id = $1`,
      [grant.id, minutes, reason || null],
    );
    await note(
      db,
      grant.ticket_id,
      `Destek ekibi ${minutes} dk ek süre istedi.${reason ? ' Not: ' + reason : ''}`,
      { adminId },
    );
    await record(
      db,
      adminId,
      'support.extension_request',
      grant.tenant_id,
      `${grant.office} · ${minutes} dk`,
    );
    return { requested: minutes };
  });
}

// The operator is done: the connection ends now.
async function endAccess(pool, adminId, { ticketId }) {
  return inTransaction(pool, async (db) => {
    const grant = await ticketGrant(db, ticketId, { lock: true });
    if (!grant) throw fail(409, 'Açık bir erişim izni yok.');
    await db.query(
      `UPDATE han_saas.support_access SET status = 'ended', ended_at = CURRENT_TIMESTAMP, ended_by_label = 'Destek ekibi',
         extension_requested_minutes = NULL, extension_requested_at = NULL, extension_note = NULL WHERE id = $1`,
      [grant.id],
    );
    await syncSessions(db, grant.tenant_id, null);
    await note(db, grant.ticket_id, 'Destek ekibi bağlantıyı bitirdi.', { adminId });
    await record(db, adminId, 'support.end', grant.tenant_id, grant.office);
    return { ended: true };
  });
}

// Open grants across offices, for the console's support list and overview.
async function openAccessByTicket(pool) {
  return inTransaction(pool, async (db) => {
    await settle(db);
    const { rows } = await db.query(
      `SELECT ${ACCESS_FIELDS} FROM han_saas.support_access a WHERE a.status IN ('pending', 'active')`,
    );
    return Object.fromEntries(rows.map((r) => [r.ticket_id, view(r)]));
  });
}

module.exports = {
  SUPPORT_ACCOUNT_ID,
  MINUTES,
  createSupportAccess,
  ticketAccess,
  connect,
  extend,
  requestExtension,
  endAccess,
  openAccessByTicket,
};
