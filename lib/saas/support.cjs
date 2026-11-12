const { randomUUID } = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');

// Support tickets for the platform console. Like the sales ledger this is control-plane
// data: operators record a request that arrived by phone, WhatsApp or e-mail, reply to it
// and track it to resolution. The operator's id always comes from the verified session.
// Offices cannot read or write these tables (no grants, RLS on).

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CATEGORIES = ['technical', 'billing', 'how_to', 'feature_request', 'other'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const CHANNELS = ['phone', 'email', 'whatsapp', 'portal', 'other'];
const STATUSES = ['open', 'waiting_customer', 'resolved', 'closed'];
// First-response target by priority, in wall-clock hours from the moment the ticket is opened.
const RESPONSE_HOURS = { urgent: 4, high: 8, normal: 24, low: 72 };
const LIST_LIMIT = 500;

const fail = (status, message) => Object.assign(new Error(message), { status });
const one = (value, allowed, label) => {
  if (!allowed.includes(value)) throw fail(400, `${label} geçersiz.`);
  return value;
};
function uuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw fail(404, `${label} bulunamadı.`);
  return value;
}
function required(value, label, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max)
    throw fail(400, `${label} ${min}–${max} karakter olmalıdır.`);
  return value.trim();
}
function optional(value, label, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max) throw fail(400, `${label} çok uzun.`);
  return value.trim();
}

const LABEL = {
  open: 'Açık',
  waiting_customer: 'Müşteri bekleniyor',
  resolved: 'Çözüldü',
  closed: 'Kapalı',
  low: 'Düşük',
  normal: 'Normal',
  high: 'Yüksek',
  urgent: 'Acil',
};

const TICKETS_SQL = `
  SELECT k.id, k.ticket_no::int AS ticket_no, k.tenant_id, t.name AS office_name, t.slug AS office_slug,
         k.subject, k.category, k.priority, k.status, k.channel, k.contact_name, k.contact_info,
         k.assigned_to, a.name AS assigned_name, k.created_at, k.updated_at, k.response_due_at,
         k.first_response_at, k.resolved_at,
         (k.status = 'open' AND k.first_response_at IS NULL AND k.response_due_at < CURRENT_TIMESTAMP) AS overdue
  FROM han_saas.support_tickets k
  JOIN han_saas.tenants t ON t.id = k.tenant_id
  LEFT JOIN han_saas.platform_admins a ON a.id = k.assigned_to`;

function ticketRow(r) {
  return {
    id: r.id,
    number: r.ticket_no,
    tenantId: r.tenant_id,
    officeName: r.office_name,
    officeSlug: r.office_slug,
    subject: r.subject,
    category: r.category,
    priority: r.priority,
    status: r.status,
    channel: r.channel,
    contactName: r.contact_name,
    contactInfo: r.contact_info,
    assignedTo: r.assigned_to ? { id: r.assigned_to, name: r.assigned_name } : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    responseDueAt: r.response_due_at,
    firstResponseAt: r.first_response_at,
    resolvedAt: r.resolved_at,
    overdue: r.overdue === true,
  };
}

async function systemLine(db, ticketId, adminId, body) {
  await db.query("INSERT INTO han_saas.support_messages(ticket_id, kind, author_id, body) VALUES ($1, 'system', $2, $3)", [
    ticketId,
    adminId,
    body,
  ]);
}

async function lockTicket(db, ticketId) {
  const { rows } = await db.query(
    `SELECT id, status, priority, assigned_to, created_at, first_response_at, resolved_at
     FROM han_saas.support_tickets WHERE id = $1 FOR UPDATE`,
    [ticketId],
  );
  if (!rows.length) throw fail(404, 'Destek kaydı bulunamadı.');
  return rows[0];
}

async function openTicket(pool, adminId, input) {
  const tenantId = uuid(input.tenantId, 'Büro');
  const subject = required(input.subject, 'Konu', 3, 160);
  const body = required(input.body, 'Açıklama', 1, 5000);
  const category = one(input.category ?? 'other', CATEGORIES, 'Kategori');
  const priority = one(input.priority ?? 'normal', PRIORITIES, 'Öncelik');
  const channel = one(input.channel ?? 'other', CHANNELS, 'Kanal');
  const contactName = optional(input.contactName, 'Kişi adı', 120);
  const contactInfo = optional(input.contactInfo, 'İletişim bilgisi', 160);
  return inTransaction(pool, async (db) => {
    const office = await db.query('SELECT 1 FROM han_saas.tenants WHERE id = $1', [tenantId]);
    if (!office.rows.length) throw fail(404, 'Büro bulunamadı.');
    const ticketId = randomUUID();
    const { rows } = await db.query(
      `INSERT INTO han_saas.support_tickets(id, tenant_id, subject, category, priority, channel, contact_name,
         contact_info, created_by, response_due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP + make_interval(hours => $10::int))
       RETURNING ticket_no::int AS ticket_no`,
      [ticketId, tenantId, subject, category, priority, channel, contactName, contactInfo, adminId, RESPONSE_HOURS[priority]],
    );
    await db.query("INSERT INTO han_saas.support_messages(ticket_id, kind, author_id, body) VALUES ($1, 'customer', $2, $3)", [
      ticketId,
      adminId,
      body,
    ]);
    return { id: ticketId, number: rows[0].ticket_no };
  });
}

// Replies and notes. A reply or a customer message moves the ticket to the state the
// conversation implies; internal notes never change it.
async function addMessage(pool, adminId, input) {
  const ticketId = uuid(input.ticketId, 'Destek kaydı');
  const kind = one(input.kind, ['operator', 'customer', 'internal'], 'Mesaj türü');
  const body = required(input.body, 'Mesaj', 1, 5000);
  const requested = input.status === undefined ? undefined : one(input.status, ['open', 'waiting_customer', 'resolved'], 'Durum');
  if (requested && kind === 'internal') throw fail(400, 'İç not durumu değiştirmez.');
  return inTransaction(pool, async (db) => {
    const ticket = await lockTicket(db, ticketId);
    if (ticket.status === 'closed') throw fail(409, 'Kapalı kayda mesaj eklenemez. Önce yeniden açın.');
    await db.query('INSERT INTO han_saas.support_messages(ticket_id, kind, author_id, body) VALUES ($1, $2, $3, $4)', [
      ticketId,
      kind,
      adminId,
      body,
    ]);
    if (kind === 'internal') return { ticketId, status: ticket.status };
    const next = requested ?? (kind === 'customer' ? 'open' : ticket.status === 'open' ? 'waiting_customer' : ticket.status);
    await db.query(
      `UPDATE han_saas.support_tickets SET status = $2, updated_at = clock_timestamp(),
         first_response_at = CASE WHEN $3 = 'operator' THEN coalesce(first_response_at, clock_timestamp())
                                  ELSE first_response_at END,
         resolved_at = CASE WHEN $2 = 'resolved' THEN coalesce(resolved_at, clock_timestamp()) ELSE NULL END
       WHERE id = $1`,
      [ticketId, next, kind],
    );
    if (next !== ticket.status) await systemLine(db, ticketId, adminId, `Durum: ${LABEL[ticket.status]} → ${LABEL[next]}`);
    return { ticketId, status: next };
  });
}

async function setStatus(pool, adminId, input) {
  const ticketId = uuid(input.ticketId, 'Destek kaydı');
  const next = one(input.status, STATUSES, 'Durum');
  return inTransaction(pool, async (db) => {
    const ticket = await lockTicket(db, ticketId);
    if (ticket.status === next) throw fail(409, 'Kayıt zaten bu durumda.');
    await db.query(
      `UPDATE han_saas.support_tickets SET status = $2, updated_at = clock_timestamp(),
         resolved_at = CASE WHEN $2 IN ('resolved', 'closed') THEN coalesce(resolved_at, clock_timestamp()) ELSE NULL END
       WHERE id = $1`,
      [ticketId, next],
    );
    await systemLine(db, ticketId, adminId, `Durum: ${LABEL[ticket.status]} → ${LABEL[next]}`);
    return { ticketId, status: next };
  });
}

// The first-response target follows the new priority until somebody has responded.
async function setPriority(pool, adminId, input) {
  const ticketId = uuid(input.ticketId, 'Destek kaydı');
  const priority = one(input.priority, PRIORITIES, 'Öncelik');
  return inTransaction(pool, async (db) => {
    const ticket = await lockTicket(db, ticketId);
    if (ticket.priority === priority) throw fail(409, 'Kayıt zaten bu öncelikte.');
    await db.query(
      `UPDATE han_saas.support_tickets SET priority = $2, updated_at = clock_timestamp(),
         response_due_at = CASE WHEN first_response_at IS NULL
           THEN created_at + make_interval(hours => $3::int) ELSE response_due_at END
       WHERE id = $1`,
      [ticketId, priority, RESPONSE_HOURS[priority]],
    );
    await systemLine(db, ticketId, adminId, `Öncelik: ${LABEL[ticket.priority]} → ${LABEL[priority]}`);
    return { ticketId, priority };
  });
}

// `assignTo` is either the string 'me' (the session operator) or null (unassign). Assigning
// to another operator needs an operator-management screen that does not exist yet.
async function assign(pool, adminId, input) {
  const ticketId = uuid(input.ticketId, 'Destek kaydı');
  if (input.assignTo !== 'me' && input.assignTo !== null) throw fail(400, 'Atama geçersiz.');
  const assignee = input.assignTo === 'me' ? adminId : null;
  return inTransaction(pool, async (db) => {
    const ticket = await lockTicket(db, ticketId);
    if ((ticket.assigned_to ?? null) === assignee) throw fail(409, 'Atama zaten böyle.');
    await db.query('UPDATE han_saas.support_tickets SET assigned_to = $2, updated_at = clock_timestamp() WHERE id = $1', [
      ticketId,
      assignee,
    ]);
    await systemLine(db, ticketId, adminId, assignee ? 'Kayıt üstlenildi' : 'Atama kaldırıldı');
    return { ticketId, assigned: !!assignee };
  });
}

async function listTickets(pool) {
  return inTransaction(
    pool,
    async (db) => {
      const tickets = (
        await db.query(
          TICKETS_SQL +
            ` ORDER BY (k.status IN ('open', 'waiting_customer')) DESC, k.updated_at DESC, k.ticket_no DESC LIMIT ${LIST_LIMIT}`,
        )
      ).rows.map(ticketRow);
      const { rows } = await db.query(
        `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
                count(*) FILTER (WHERE status = 'waiting_customer')::int AS waiting,
                count(*) FILTER (WHERE status IN ('open', 'waiting_customer') AND priority = 'urgent')::int AS urgent,
                count(*) FILTER (WHERE status = 'open' AND first_response_at IS NULL
                                   AND response_due_at < CURRENT_TIMESTAMP)::int AS overdue,
                count(*) FILTER (WHERE resolved_at > CURRENT_TIMESTAMP - interval '30 days')::int AS resolved30,
                avg(EXTRACT(EPOCH FROM (first_response_at - created_at)) / 3600.0)
                  FILTER (WHERE first_response_at IS NOT NULL
                            AND created_at > CURRENT_TIMESTAMP - interval '30 days')::float8 AS avg_response_hours
         FROM han_saas.support_tickets`,
      );
      const s = rows[0];
      return {
        tickets,
        summary: {
          open: s.open,
          waitingCustomer: s.waiting,
          urgent: s.urgent,
          overdue: s.overdue,
          resolvedLast30Days: s.resolved30,
          avgFirstResponseHours: s.avg_response_hours === null ? null : Math.round(s.avg_response_hours * 10) / 10,
        },
      };
    },
    { readOnly: true },
  );
}

async function ticketDetail(pool, input) {
  const ticketId = uuid(input.ticketId, 'Destek kaydı');
  return inTransaction(
    pool,
    async (db) => {
      const { rows } = await db.query(TICKETS_SQL + ' WHERE k.id = $1', [ticketId]);
      if (!rows.length) throw fail(404, 'Destek kaydı bulunamadı.');
      const messages = (
        await db.query(
          `SELECT m.id::text AS id, m.kind, m.body, m.created_at, coalesce(a.name, m.author_label) AS author
           FROM han_saas.support_messages m LEFT JOIN han_saas.platform_admins a ON a.id = m.author_id
           WHERE m.ticket_id = $1 ORDER BY m.id`,
          [ticketId],
        )
      ).rows.map((m) => ({ id: m.id, kind: m.kind, body: m.body, createdAt: m.created_at, author: m.author }));
      return { ticket: ticketRow(rows[0]), messages };
    },
    { readOnly: true },
  );
}

module.exports = { openTicket, addMessage, setStatus, setPriority, assign, listTickets, ticketDetail, RESPONSE_HOURS };
