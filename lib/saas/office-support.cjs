const { randomUUID } = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');
const { RESPONSE_HOURS } = require('./support.cjs');

// The office-facing side of support tickets. An office's CEO or admin opens a ticket and reads
// the operator's replies from inside the application. Everything is scoped to the one office
// this server serves; internal notes and audit lines never leave the control plane, and the
// operators' own names are not shown (replies come from "Destek ekibi").

const CATEGORIES = ['technical', 'billing', 'how_to', 'feature_request', 'other'];
// Offices may ask for up to "high"; an operator decides what is urgent.
const PRIORITIES = ['low', 'normal', 'high'];
const MAX_OPEN = 25;
const MAX_MESSAGES = 200;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

const fail = (status, message) => Object.assign(new Error(message), { status });
function text(value, label, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max)
    throw fail(400, `${label} ${min}–${max} karakter olmalıdır.`);
  return value.trim();
}

function createOfficeSupport(pool, { tenantId }) {
  const label = (user) => String(user?.name || user?.username || 'Büro kullanıcısı').slice(0, 160);
  // CEO and admins see every ticket of the office; other users only the ones they opened.
  const everything = (user) => !user || (['ceo', 'admin'].includes(user.role) && !user.platformSupport);
  const opener = (user) => String(user?.id || '');

  async function ownTicket(db, id, { lock = false, user = null } = {}) {
    if (typeof id !== 'string' || !UUID.test(id)) throw fail(404, 'Destek kaydı bulunamadı.');
    const { rows } = await db.query(
      `SELECT id, ticket_no::int AS number, subject, category, priority, status, created_at, updated_at,
              first_response_at, resolved_at, opened_by_office
       FROM han_saas.support_tickets WHERE id = $1 AND tenant_id = $2 AND ($3 OR opened_by_user = $4)
       ${lock ? 'FOR UPDATE' : ''}`,
      [id, tenantId, everything(user), opener(user)],
    );
    if (!rows.length) throw fail(404, 'Destek kaydı bulunamadı.');
    return rows[0];
  }
  const view = (r) => ({
    id: r.id,
    number: r.number,
    subject: r.subject,
    category: r.category,
    priority: r.priority,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    answered: r.first_response_at !== null,
    openedBy: r.opened_by_office ?? null,
  });

  return {
    async list(user = null) {
      const { rows } = await pool.query(
        `SELECT id, ticket_no::int AS number, subject, category, priority, status, created_at, updated_at,
                first_response_at, resolved_at, opened_by_office
         FROM han_saas.support_tickets WHERE tenant_id = $1 AND ($2 OR opened_by_user = $3)
         ORDER BY (status IN ('open', 'waiting_customer')) DESC, updated_at DESC LIMIT 200`,
        [tenantId, everything(user), opener(user)],
      );
      return { tickets: rows.map(view), manager: everything(user) };
    },

    async open(user, input) {
      const subject = text(input.subject, 'Konu', 3, 160);
      const body = text(input.body, 'Açıklama', 1, 5000);
      const category = CATEGORIES.includes(input.category ?? 'other') ? (input.category ?? 'other') : null;
      const priority = PRIORITIES.includes(input.priority ?? 'normal') ? (input.priority ?? 'normal') : null;
      if (!category) throw fail(400, 'Kategori geçersiz.');
      if (!priority) throw fail(400, 'Öncelik geçersiz.');
      return inTransaction(pool, async (db) => {
        // Serialize per office so the open-ticket cap cannot be raced past.
        await db.query('SELECT 1 FROM han_saas.tenants WHERE id = $1 FOR UPDATE', [tenantId]);
        const open = await db.query(
          "SELECT count(*)::int AS n FROM han_saas.support_tickets WHERE tenant_id = $1 AND status IN ('open', 'waiting_customer')",
          [tenantId],
        );
        if (open.rows[0].n >= MAX_OPEN)
          throw fail(
            429,
            `En fazla ${MAX_OPEN} açık destek kaydınız olabilir. Önce mevcut kayıtlar sonuçlansın.`,
          );
        const id = randomUUID();
        const { rows } = await db.query(
          `INSERT INTO han_saas.support_tickets(id, tenant_id, subject, category, priority, channel, contact_name,
             opened_by_office, opened_by_user, response_due_at)
           VALUES ($1, $2, $3, $4, $5, 'portal', $6, $6, $8, CURRENT_TIMESTAMP + make_interval(hours => $7::int))
           RETURNING ticket_no::int AS number`,
          [
            id,
            tenantId,
            subject,
            category,
            priority,
            label(user),
            RESPONSE_HOURS[priority],
            opener(user).slice(0, 100) || null,
          ],
        );
        await db.query(
          "INSERT INTO han_saas.support_messages(ticket_id, kind, author_id, author_label, body) VALUES ($1, 'customer', NULL, $2, $3)",
          [id, label(user), body],
        );
        return { id, number: rows[0].number };
      });
    },

    async detail(id, user = null) {
      return inTransaction(
        pool,
        async (db) => {
          const ticket = await ownTicket(db, id, { user });
          const { rows } = await db.query(
            `SELECT id::text AS id, kind, body, created_at, author_label
             FROM han_saas.support_messages
             WHERE ticket_id = $1 AND kind IN ('operator', 'customer') ORDER BY id`,
            [id],
          );
          return {
            ticket: view(ticket),
            messages: rows.map((m) => ({
              id: m.id,
              from: m.kind === 'operator' ? 'support' : 'office',
              author: m.kind === 'operator' ? 'Destek ekibi' : m.author_label || 'Büro',
              body: m.body,
              createdAt: m.created_at,
            })),
          };
        },
        { readOnly: true },
      );
    },

    // A message from the office reopens a resolved ticket and puts the ball back with support.
    async reply(user, id, input) {
      const body = text(input.body, 'Mesaj', 1, 5000);
      return inTransaction(pool, async (db) => {
        const ticket = await ownTicket(db, id, { lock: true, user });
        if (ticket.status === 'closed') throw fail(409, 'Bu kayıt kapatılmış. Yeni bir destek kaydı açın.');
        const count = await db.query(
          'SELECT count(*)::int AS n FROM han_saas.support_messages WHERE ticket_id = $1',
          [id],
        );
        if (count.rows[0].n >= MAX_MESSAGES)
          throw fail(429, 'Bu kayıttaki mesaj sınırına ulaşıldı. Yeni bir kayıt açın.');
        await db.query(
          "INSERT INTO han_saas.support_messages(ticket_id, kind, author_id, author_label, body) VALUES ($1, 'customer', NULL, $2, $3)",
          [id, label(user), body],
        );
        await db.query(
          `UPDATE han_saas.support_tickets SET status = 'open', updated_at = clock_timestamp(), resolved_at = NULL
           WHERE id = $1`,
          [id],
        );
        return { ticketId: id, status: 'open' };
      });
    },

    // "Çözüldü": the office confirms support's fix after testing it.
    async confirmResolved(user, id) {
      return inTransaction(pool, async (db) => {
        const ticket = await ownTicket(db, id, { lock: true, user });
        if (['resolved', 'closed'].includes(ticket.status)) return { ticketId: id, status: ticket.status };
        await db.query(
          "INSERT INTO han_saas.support_messages(ticket_id, kind, author_id, author_label, body) VALUES ($1, 'customer', NULL, $2, $3)",
          [id, label(user), 'Test ettik, sorun çözüldü. Teşekkürler.'],
        );
        await db.query(
          `UPDATE han_saas.support_tickets SET status = 'resolved', updated_at = clock_timestamp(),
             resolved_at = clock_timestamp() WHERE id = $1`,
          [id],
        );
        return { ticketId: id, status: 'resolved' };
      });
    },
  };
}

module.exports = { createOfficeSupport, MAX_OPEN };
