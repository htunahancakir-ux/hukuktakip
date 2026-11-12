const { randomUUID } = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');
const { record } = require('./platform-account.cjs');

// Announcements the operator publishes to offices' home pages (han_saas.announcements): a new
// product, a campaign, a price change or planned maintenance. Offices read them through
// lib/saas/office-catalog.cjs. Text only; the office screen renders it with textContent.

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CODE = /^[a-z][a-z0-9-]{1,40}$/;
const KINDS = ['new_product', 'campaign', 'price_change', 'maintenance'];
const AUDIENCES = ['all', 'without_product', 'trialing', 'selected'];
const STATUSES = ['draft', 'published', 'archived'];
const fail = (status, message) => Object.assign(new Error(message), { status });

function text(value, label, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max)
    throw fail(400, `${label} ${min}–${max} karakter olmalıdır.`);
  return value.trim();
}

function clean(input) {
  if (!KINDS.includes(input.kind)) throw fail(400, 'Duyuru türü geçersiz.');
  const title = text(input.title, 'Başlık', 3, 80);
  const body = text(input.body, 'Metin', 1, 400);
  const productCode = input.productCode ? String(input.productCode) : null;
  if (productCode && !CODE.test(productCode)) throw fail(400, 'Ürün geçersiz.');
  const campaignId = input.campaignId ? String(input.campaignId) : null;
  if (campaignId && !UUID.test(campaignId)) throw fail(400, 'Kampanya geçersiz.');
  if (input.kind === 'campaign' && !campaignId) throw fail(400, 'Kampanya duyurusu için kampanya seçin.');
  const audience = input.audience ?? 'all';
  if (!AUDIENCES.includes(audience)) throw fail(400, 'Hedef kitle geçersiz.');
  if (['without_product', 'trialing'].includes(audience) && !productCode)
    throw fail(400, 'Bu hedef kitle için ürün seçin.');
  const tenantIds = audience === 'selected' ? input.tenantIds ?? [] : [];
  if (!Array.isArray(tenantIds) || tenantIds.length > 1000 || tenantIds.some((t) => typeof t !== 'string' || !UUID.test(t)))
    throw fail(400, 'Seçilen büro listesi geçersiz.');
  if (audience === 'selected' && !tenantIds.length) throw fail(400, 'En az bir büro seçin.');
  // Sales messages go to managers only; maintenance may go to everyone.
  const roles = input.kind === 'maintenance' && input.roles === 'everyone' ? 'everyone' : 'managers';
  const startsAt = new Date(input.startsAt ?? Date.now());
  const endsAt = new Date(input.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt)
    throw fail(400, 'Bitiş başlangıçtan sonra olmalıdır.');
  const priority = input.priority ?? 50;
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) throw fail(400, 'Öncelik 0–100 olmalıdır.');
  return {
    kind: input.kind,
    title,
    body,
    productCode,
    campaignId,
    audience,
    tenantIds: [...new Set(tenantIds)],
    roles,
    startsAt,
    endsAt,
    dismissible: input.dismissible !== false,
    priority,
  };
}

async function upsertAnnouncement(pool, adminId, input) {
  const a = clean(input);
  const values = [a.kind, a.title, a.body, a.productCode, a.campaignId, a.audience, a.tenantIds, a.roles,
    a.startsAt, a.endsAt, a.dismissible, a.priority];
  return inTransaction(pool, async (db) => {
    const missing = (error) => {
      if (error.code === '23503') throw fail(400, 'Seçilen ürün veya kampanya bulunamadı.');
      throw error;
    };
    if (input.id !== undefined) {
      if (typeof input.id !== 'string' || !UUID.test(input.id)) throw fail(404, 'Duyuru bulunamadı.');
      const { rows } = await db
        .query(
          `UPDATE han_saas.announcements SET kind = $2, title = $3, body = $4, product_code = $5, campaign_id = $6,
             audience = $7, tenant_ids = $8, roles = $9, starts_at = $10, ends_at = $11, dismissible = $12,
             priority = $13, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 RETURNING id`,
          [input.id, ...values],
        )
        .catch(missing);
      if (!rows.length) throw fail(404, 'Duyuru bulunamadı.');
      await record(db, adminId, 'announcement.save', input.id, a.title);
      return { id: input.id };
    }
    const id = randomUUID();
    await db
      .query(
        `INSERT INTO han_saas.announcements(id, kind, title, body, product_code, campaign_id, audience, tenant_ids, roles,
           starts_at, ends_at, dismissible, priority, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [id, ...values, adminId],
      )
      .catch(missing);
    await record(db, adminId, 'announcement.create', id, a.title);
    return { id };
  });
}

async function setAnnouncementStatus(pool, adminId, { id, status }) {
  if (typeof id !== 'string' || !UUID.test(id)) throw fail(404, 'Duyuru bulunamadı.');
  if (!STATUSES.includes(status)) throw fail(400, 'Durum geçersiz.');
  return inTransaction(pool, async (db) => {
    const { rows } = await db.query(
      'UPDATE han_saas.announcements SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING title',
      [id, status],
    );
    if (!rows.length) throw fail(404, 'Duyuru bulunamadı.');
    await record(db, adminId, 'announcement.status', id, `${rows[0].title} → ${status}`);
    return { id, status };
  });
}

// All announcements with their reach: offices and people it was shown to, clicks, closes and
// "İlgileniyorum" presses.
async function listAnnouncements(pool) {
  const { rows } = await pool.query(
    `SELECT a.*, m.name AS product_name, c.name AS campaign_name,
       (SELECT count(DISTINCT v.tenant_id)::int FROM han_saas.announcement_views v WHERE v.announcement_id = a.id) AS offices,
       (SELECT count(*)::int FROM han_saas.announcement_views v WHERE v.announcement_id = a.id) AS shown,
       (SELECT count(*)::int FROM han_saas.announcement_views v WHERE v.announcement_id = a.id AND v.clicked_at IS NOT NULL) AS clicked,
       (SELECT count(*)::int FROM han_saas.announcement_views v WHERE v.announcement_id = a.id AND v.dismissed_at IS NOT NULL) AS dismissed,
       (SELECT count(*)::int FROM han_saas.announcement_views v WHERE v.announcement_id = a.id AND v.interested_at IS NOT NULL) AS interested
     FROM han_saas.announcements a
     LEFT JOIN han_saas.modules m ON m.code = a.product_code
     LEFT JOIN han_saas.campaigns c ON c.id = a.campaign_id
     ORDER BY a.created_at DESC LIMIT 300`,
  );
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    productCode: r.product_code,
    productName: r.product_name,
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    audience: r.audience,
    tenantIds: r.tenant_ids,
    roles: r.roles,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    dismissible: r.dismissible,
    priority: r.priority,
    status: r.status,
    live: r.status === 'published' && new Date(r.starts_at).getTime() <= now && new Date(r.ends_at).getTime() > now,
    stats: { offices: r.offices, shown: r.shown, clicked: r.clicked, dismissed: r.dismissed, interested: r.interested },
    createdAt: r.created_at,
  }));
}

module.exports = { upsertAnnouncement, setAnnouncementStatus, listAnnouncements, KINDS };
