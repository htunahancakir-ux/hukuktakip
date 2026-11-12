const { randomUUID } = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');
const { record } = require('./platform-account.cjs');

// Sales pipeline (han_saas.prospects): offices that are not customers yet (new_office) and
// sales to existing offices (upsell). Office requests ("Talep et", "İlgileniyorum") arrive
// here from lib/saas/office-catalog.cjs. Opening an office or adding a module with a
// `prospectId` marks the prospect won (lib/saas/platform.cjs, closeWon).

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CODE = /^[a-z][a-z0-9-]{1,40}$/;
const STAGES = ['new', 'contacted', 'demo', 'offer', 'won', 'lost'];
const OPEN_STAGES = ['new', 'contacted', 'demo', 'offer'];
const SOURCES = ['advertising', 'referral', 'web', 'announcement', 'request', 'other'];
const STAGE_LABELS = { new: 'Yeni', contacted: 'Görüşüldü', demo: 'Demo', offer: 'Teklif', won: 'Kazanıldı', lost: 'Kaybedildi' };
const fail = (status, message) => Object.assign(new Error(message), { status });
const num = (value) => Number(value ?? 0);

function optional(value, label, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max) throw fail(400, `${label} en fazla ${max} karakter olabilir.`);
  return value.trim() || null;
}
function prospectId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw fail(404, 'Fırsat bulunamadı.');
  return value;
}

function clean(input) {
  const officeName = typeof input.officeName === 'string' ? input.officeName.trim() : '';
  if (officeName.length < 2 || officeName.length > 160) throw fail(400, 'Büro adı 2–160 karakter olmalıdır.');
  const source = input.source ?? 'other';
  if (!SOURCES.includes(source)) throw fail(400, 'Kaynak geçersiz.');
  const codes = input.productCodes ?? [];
  if (!Array.isArray(codes) || codes.length > 20 || codes.some((c) => typeof c !== 'string' || !CODE.test(c)))
    throw fail(400, 'Ürün listesi geçersiz.');
  const users = input.expectedUsers === undefined || input.expectedUsers === null || input.expectedUsers === '' ? null : input.expectedUsers;
  if (users !== null && (!Number.isInteger(users) || users < 1 || users > 10000))
    throw fail(400, 'Beklenen kullanıcı sayısı 1–10000 olmalıdır.');
  const monthly = input.expectedMonthlyKurus ?? 0;
  if (!Number.isSafeInteger(monthly) || monthly < 0) throw fail(400, 'Beklenen aylık tutar geçersiz.');
  const next = input.nextActionAt ? new Date(input.nextActionAt) : null;
  if (next && Number.isNaN(next.getTime())) throw fail(400, 'Sonraki adım tarihi geçersiz.');
  const owner = input.ownerAdminId ? String(input.ownerAdminId) : null;
  if (owner && !UUID.test(owner)) throw fail(400, 'Sorumlu geçersiz.');
  return {
    officeName,
    contactName: optional(input.contactName, 'Yetkili', 120),
    phone: optional(input.phone, 'Telefon', 40),
    email: optional(input.email, 'E-posta', 160),
    city: optional(input.city, 'Şehir', 80),
    source,
    productCodes: [...new Set(codes)],
    expectedUsers: users,
    expectedMonthlyKurus: monthly,
    nextActionAt: next,
    ownerAdminId: owner,
    note: optional(input.note, 'Not', 2000),
  };
}

const view = (r) => ({
  id: r.id,
  kind: r.kind,
  tenantId: r.tenant_id,
  tenantName: r.tenant_name ?? null,
  officeName: r.office_name,
  contactName: r.contact_name,
  phone: r.phone,
  email: r.email,
  city: r.city,
  source: r.source,
  stage: r.stage,
  expectedUsers: r.expected_users,
  productCodes: r.product_codes,
  expectedMonthlyKurus: num(r.expected_monthly_kurus),
  ownerAdminId: r.owner_admin_id,
  ownerName: r.owner_name ?? null,
  nextActionAt: r.next_action_at,
  lostReason: r.lost_reason,
  wonTenantId: r.won_tenant_id,
  note: r.note,
  createdBy: r.created_by,
  createdLabel: r.created_label,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  closedAt: r.closed_at,
});
const SELECT = `SELECT p.*, t.name AS tenant_name, a.name AS owner_name
  FROM han_saas.prospects p
  LEFT JOIN han_saas.tenants t ON t.id = p.tenant_id
  LEFT JOIN han_saas.platform_admins a ON a.id = p.owner_admin_id`;

// The board: open and recently closed prospects, plus totals per stage and the conversion
// rate of the last 12 months (won / (won + lost)).
async function listProspects(pool, { stage, source, owner, q } = {}) {
  if (stage && !STAGES.includes(stage)) throw fail(400, 'Aşama geçersiz.');
  if (source && !SOURCES.includes(source)) throw fail(400, 'Kaynak geçersiz.');
  if (owner && !UUID.test(owner)) throw fail(400, 'Sorumlu geçersiz.');
  const search = q ? String(q).trim().slice(0, 80) : '';
  const { rows } = await pool.query(
    `${SELECT}
     WHERE ($1::text IS NULL OR p.stage = $1) AND ($2::text IS NULL OR p.source = $2)
       AND ($3::uuid IS NULL OR p.owner_admin_id = $3)
       AND ($4 = '' OR p.office_name ILIKE '%' || $4 || '%' OR coalesce(p.contact_name, '') ILIKE '%' || $4 || '%')
       AND (p.closed_at IS NULL OR p.closed_at > CURRENT_TIMESTAMP - interval '90 days')
     ORDER BY p.next_action_at NULLS LAST, p.updated_at DESC LIMIT 500`,
    [stage || null, source || null, owner || null, search],
  );
  const { rows: totals } = await pool.query(
    `SELECT stage, count(*)::int AS n, coalesce(sum(expected_monthly_kurus), 0)::text AS monthly
     FROM han_saas.prospects WHERE closed_at IS NULL OR closed_at > CURRENT_TIMESTAMP - interval '12 months'
     GROUP BY stage`,
  );
  const byStage = Object.fromEntries(STAGES.map((s) => [s, { count: 0, monthlyKurus: 0 }]));
  for (const t of totals) byStage[t.stage] = { count: t.n, monthlyKurus: num(t.monthly) };
  const decided = byStage.won.count + byStage.lost.count;
  return {
    prospects: rows.map(view),
    byStage,
    conversionPercent: decided ? Math.round((byStage.won.count / decided) * 100) : null,
    dueToday: rows.filter(
      (r) => OPEN_STAGES.includes(r.stage) && r.next_action_at && new Date(r.next_action_at).getTime() <= endOfToday(),
    ).length,
  };
}
// End of today in Istanbul (UTC+3 all year).
function endOfToday(now = Date.now()) {
  const shift = 3 * 3600000;
  return Math.floor((now + shift) / 86400000) * 86400000 + 86400000 - shift;
}

async function prospectDetail(pool, id) {
  prospectId(id);
  const { rows } = await pool.query(`${SELECT} WHERE p.id = $1`, [id]);
  if (!rows.length) throw fail(404, 'Fırsat bulunamadı.');
  const { rows: notes } = await pool.query(
    `SELECT n.id, n.body, n.created_at, a.name AS admin_name FROM han_saas.prospect_notes n
     LEFT JOIN han_saas.platform_admins a ON a.id = n.admin_id WHERE n.prospect_id = $1 ORDER BY n.id DESC LIMIT 200`,
    [id],
  );
  return {
    prospect: view(rows[0]),
    notes: notes.map((n) => ({ id: Number(n.id), body: n.body, at: n.created_at, by: n.admin_name || 'Büro talebi' })),
  };
}

async function createProspect(pool, adminId, input) {
  const p = clean(input);
  const tenantId = input.tenantId ? String(input.tenantId) : null;
  if (tenantId && !UUID.test(tenantId)) throw fail(400, 'Büro geçersiz.');
  return inTransaction(pool, async (db) => {
    const id = randomUUID();
    await db
      .query(
        `INSERT INTO han_saas.prospects(id, kind, tenant_id, office_name, contact_name, phone, email, city, source,
           expected_users, product_codes, expected_monthly_kurus, owner_admin_id, next_action_at, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [id, tenantId ? 'upsell' : 'new_office', tenantId, p.officeName, p.contactName, p.phone, p.email, p.city,
          p.source, p.expectedUsers, p.productCodes, p.expectedMonthlyKurus, p.ownerAdminId ?? adminId, p.nextActionAt,
          p.note, adminId],
      )
      .catch((error) => {
        if (error.code === '23503') throw fail(400, 'Büro veya sorumlu bulunamadı.');
        throw error;
      });
    await record(db, adminId, 'prospect.create', id, p.officeName);
    return { id };
  });
}

async function updateProspect(pool, adminId, input) {
  const id = prospectId(input.id);
  const p = clean(input);
  return inTransaction(pool, async (db) => {
    const { rows } = await db
      .query(
        `UPDATE han_saas.prospects SET office_name = $2, contact_name = $3, phone = $4, email = $5, city = $6,
           source = $7, expected_users = $8, product_codes = $9, expected_monthly_kurus = $10,
           owner_admin_id = CASE WHEN $14 THEN owner_admin_id ELSE $11::uuid END, next_action_at = $12, note = $13, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 RETURNING id`,
        [id, p.officeName, p.contactName, p.phone, p.email, p.city, p.source, p.expectedUsers, p.productCodes,
          p.expectedMonthlyKurus, p.ownerAdminId, p.nextActionAt, p.note, input.ownerAdminId === undefined],
      )
      .catch((error) => {
        if (error.code === '23503') throw fail(400, 'Sorumlu bulunamadı.');
        throw error;
      });
    if (!rows.length) throw fail(404, 'Fırsat bulunamadı.');
    await record(db, adminId, 'prospect.save', id, p.officeName);
    return { id };
  });
}

// Moves a prospect along the board. "won" is set by the sale itself (closeWon); here an
// operator can mark it lost (with a reason) or move it between the open stages or reopen it.
async function moveProspect(pool, adminId, { id, stage, lostReason }) {
  prospectId(id);
  if (!STAGES.includes(stage) || stage === 'won')
    throw fail(400, stage === 'won' ? 'Kazanıldı, büro açılınca veya modül satılınca kendiliğinden işaretlenir.' : 'Aşama geçersiz.');
  const reason = stage === 'lost' ? optional(lostReason, 'Kaybetme nedeni', 300) : null;
  if (stage === 'lost' && !reason) throw fail(400, 'Kaybetme nedenini yazın.');
  return inTransaction(pool, async (db) => {
    const { rows } = await db.query(
      `UPDATE han_saas.prospects SET stage = $2, lost_reason = $3, updated_at = CURRENT_TIMESTAMP,
         closed_at = CASE WHEN $2 = 'lost' THEN CURRENT_TIMESTAMP END, won_tenant_id = NULL
       WHERE id = $1 RETURNING office_name`,
      [id, stage, reason],
    );
    if (!rows.length) throw fail(404, 'Fırsat bulunamadı.');
    await db.query("INSERT INTO han_saas.prospect_notes(prospect_id, admin_id, body) VALUES ($1, $2, $3)", [
      id,
      adminId,
      `Aşama: ${STAGE_LABELS[stage]}${reason ? ' — ' + reason : ''}`,
    ]);
    await record(db, adminId, 'prospect.stage', id, `${rows[0].office_name} → ${stage}`);
    return { id, stage };
  });
}

async function addProspectNote(pool, adminId, { id, body }) {
  prospectId(id);
  if (typeof body !== 'string' || !body.trim() || body.trim().length > 2000) throw fail(400, 'Not 1–2000 karakter olmalıdır.');
  return inTransaction(pool, async (db) => {
    const { rows } = await db.query(
      'UPDATE han_saas.prospects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id',
      [id],
    );
    if (!rows.length) throw fail(404, 'Fırsat bulunamadı.');
    await db.query('INSERT INTO han_saas.prospect_notes(prospect_id, admin_id, body) VALUES ($1, $2, $3)', [
      id,
      adminId,
      body.trim(),
    ]);
    return { id };
  });
}

// Called inside the sale's transaction: the sale closes its prospect as won.
async function closeWon(db, adminId, prospect, { tenantId, kind }) {
  prospectId(prospect);
  const { rows } = await db.query(
    `UPDATE han_saas.prospects SET stage = 'won', won_tenant_id = $2, closed_at = CURRENT_TIMESTAMP,
       lost_reason = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND kind = $3 AND stage NOT IN ('won', 'lost') AND (kind = 'new_office' OR tenant_id = $2)
     RETURNING id`,
    [prospect, tenantId, kind],
  );
  if (!rows.length) throw fail(409, 'Fırsat bu satışla eşleşmiyor veya zaten kapanmış.');
  await db.query("INSERT INTO han_saas.prospect_notes(prospect_id, admin_id, body) VALUES ($1, $2, 'Kazanıldı: satış yapıldı.')", [
    prospect,
    adminId,
  ]);
}

module.exports = {
  listProspects,
  prospectDetail,
  createProspect,
  updateProspect,
  moveProspect,
  addProspectNote,
  closeWon,
  STAGES,
  SOURCES,
  endOfToday,
};
