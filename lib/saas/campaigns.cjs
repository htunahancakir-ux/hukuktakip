const { randomUUID } = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');
const { record } = require('./platform-account.cjs');

// Campaigns and coupons (han_saas.campaigns). The operator picks a campaign, or types its
// coupon code, while selling; the discount is computed here from the sale lines and booked by
// lib/saas/platform.cjs as `adjustment` rows carrying campaign_id. Nothing a client sends is
// trusted as an amount.
//
// A sale line is { code, monthlyKurus, months, amountKurus } for monthly items (users = the
// user licence, or a module) or { code, amountKurus, quantity, oneOff: true } for one-off
// products. Discounts per line:
//   percent: monthly × % × discounted months   |  one-off: amount × %
//   amount:  min(value, monthly) × months      |  one-off: min(value × quantity, amount)
// "discounted months" is the whole term, or at most 1 / 3 months; never more than the line.

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CODE = /^[a-z][a-z0-9-]{1,40}$/;
// Coupons are plain ASCII, compared upper-cased the non-Turkish way ("kasim" → "KASIM", not "KASİM").
const COUPON = /^[A-Z0-9][A-Z0-9-]{2,29}$/;
const TYPES = ['percent', 'amount'];
const APPLIES = { first_month: 1, first_3_months: 3, whole_term: Infinity };
const AUDIENCES = ['all', 'new_offices', 'without_product', 'trialing', 'selected'];
const STATUSES = ['active', 'paused', 'ended'];
const fail = (status, message) => Object.assign(new Error(message), { status });
const num = (value) => Number(value ?? 0);

function clean(input) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length < 2 || name.length > 120) throw fail(400, 'Kampanya adı 2–120 karakter olmalıdır.');
  const codes = input.productCodes ?? [];
  if (!Array.isArray(codes) || codes.length > 50 || codes.some((c) => typeof c !== 'string' || !(c === 'users' || CODE.test(c))))
    throw fail(400, 'Ürün listesi geçersiz.');
  if (!TYPES.includes(input.discountType)) throw fail(400, 'İndirim türünü seçin: yüzde veya tutar.');
  const value = input.discountValue;
  if (!Number.isSafeInteger(value) || value <= 0 || value > (input.discountType === 'percent' ? 100 : 100_000_000))
    throw fail(400, input.discountType === 'percent' ? 'İndirim yüzdesi 1–100 olmalıdır.' : 'İndirim tutarı geçersiz.');
  const applies = input.applies ?? 'whole_term';
  if (!(applies in APPLIES)) throw fail(400, 'İndirim süresi geçersiz.');
  const audience = input.audience ?? 'all';
  if (!AUDIENCES.includes(audience)) throw fail(400, 'Hedef kitle geçersiz.');
  const tenantIds = audience === 'selected' ? input.tenantIds ?? [] : [];
  if (!Array.isArray(tenantIds) || tenantIds.length > 1000 || tenantIds.some((t) => typeof t !== 'string' || !UUID.test(t)))
    throw fail(400, 'Seçilen büro listesi geçersiz.');
  if (audience === 'selected' && !tenantIds.length) throw fail(400, 'En az bir büro seçin.');
  const startsAt = new Date(input.startsAt ?? Date.now());
  const endsAt = new Date(input.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt)
    throw fail(400, 'Kampanya bitişi başlangıçtan sonra olmalıdır.');
  let coupon = input.couponCode ? String(input.couponCode).trim().toUpperCase() : null;
  if (coupon && !COUPON.test(coupon)) throw fail(400, 'Kupon kodu 3–30 karakter; harf, rakam ve tire olmalıdır.');
  const maxUses = input.maxUses === undefined || input.maxUses === null || input.maxUses === '' ? null : input.maxUses;
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100000))
    throw fail(400, 'Kullanım sınırı 1–100000 olmalıdır.');
  return {
    name,
    productCodes: [...new Set(codes)],
    discountType: input.discountType,
    discountValue: value,
    applies,
    audience,
    tenantIds: [...new Set(tenantIds)],
    startsAt,
    endsAt,
    coupon,
    maxUses,
  };
}

async function upsertCampaign(pool, adminId, input) {
  const c = clean(input);
  return inTransaction(pool, async (db) => {
    if (input.id !== undefined) {
      if (typeof input.id !== 'string' || !UUID.test(input.id)) throw fail(404, 'Kampanya bulunamadı.');
      const { rows } = await db.query('SELECT * FROM han_saas.campaigns WHERE id = $1 FOR UPDATE', [input.id]);
      if (!rows.length) throw fail(404, 'Kampanya bulunamadı.');
      const before = rows[0];
      // Used campaigns keep their terms; only name, end date, limit and coupon can change.
      const sorted = (list) => JSON.stringify([...list].sort());
      const termsChanged =
        before.discount_type !== c.discountType ||
        num(before.discount_value) !== c.discountValue ||
        before.applies !== c.applies ||
        sorted(before.product_codes) !== sorted(c.productCodes);
      if (before.used_count > 0 && termsChanged)
        throw fail(409, 'Kullanılmış bir kampanyanın indirimi değiştirilemez; yeni kampanya açın.');
      if (c.maxUses !== null && c.maxUses < before.used_count)
        throw fail(400, `Kullanım sınırı, şimdiye kadarki kullanımın (${before.used_count}) altına inemez.`);
      await db.query(
        `UPDATE han_saas.campaigns SET name = $2, product_codes = $3, discount_type = $4, discount_value = $5, applies = $6,
           audience = $7, tenant_ids = $8, starts_at = $9, ends_at = $10, coupon_code = $11, max_uses = $12
         WHERE id = $1`,
        [input.id, c.name, c.productCodes, c.discountType, c.discountValue, c.applies, c.audience, c.tenantIds,
          c.startsAt, c.endsAt, c.coupon, c.maxUses],
      ).catch(duplicateCoupon);
      await record(db, adminId, 'campaign.save', input.id, c.name);
      return { id: input.id };
    }
    const id = randomUUID();
    await db.query(
      `INSERT INTO han_saas.campaigns(id, name, product_codes, discount_type, discount_value, applies, audience, tenant_ids,
         starts_at, ends_at, coupon_code, max_uses, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [id, c.name, c.productCodes, c.discountType, c.discountValue, c.applies, c.audience, c.tenantIds,
        c.startsAt, c.endsAt, c.coupon, c.maxUses, adminId],
    ).catch(duplicateCoupon);
    await record(db, adminId, 'campaign.create', id, c.name);
    return { id };
  });
}
function duplicateCoupon(error) {
  if (error.code === '23505') throw fail(409, 'Bu kupon kodu başka bir kampanyada kullanılıyor.');
  throw error;
}

async function setCampaignStatus(pool, adminId, { id, status }) {
  if (typeof id !== 'string' || !UUID.test(id)) throw fail(404, 'Kampanya bulunamadı.');
  if (!STATUSES.includes(status)) throw fail(400, 'Durum geçersiz.');
  return inTransaction(pool, async (db) => {
    const { rows } = await db.query('UPDATE han_saas.campaigns SET status = $2 WHERE id = $1 RETURNING name', [id, status]);
    if (!rows.length) throw fail(404, 'Kampanya bulunamadı.');
    await record(db, adminId, 'campaign.status', id, `${rows[0].name} → ${status}`);
    return { id, status };
  });
}

// Every campaign with its results: offices that used it, revenue of the sales made with it
// (not voided) and the discount given.
async function listCampaigns(pool) {
  const { rows } = await pool.query(
    `SELECT c.*,
       (SELECT coalesce(sum(s.amount_kurus), 0)::text FROM han_saas.sales s
          WHERE s.campaign_id = c.id AND s.kind <> 'adjustment' AND s.status <> 'void') AS revenue,
       (SELECT coalesce(-sum(s.amount_kurus), 0)::text FROM han_saas.sales s
          WHERE s.campaign_id = c.id AND s.kind = 'adjustment' AND s.status <> 'void') AS discount
     FROM han_saas.campaigns c ORDER BY c.created_at DESC LIMIT 500`,
  );
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    productCodes: r.product_codes,
    discountType: r.discount_type,
    discountValue: num(r.discount_value),
    applies: r.applies,
    audience: r.audience,
    tenantIds: r.tenant_ids,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    couponCode: r.coupon_code,
    maxUses: r.max_uses,
    usedCount: r.used_count,
    status: r.status,
    live: r.status === 'active' && new Date(r.starts_at).getTime() <= now && new Date(r.ends_at).getTime() > now,
    revenueKurus: num(r.revenue),
    discountKurus: num(r.discount),
    createdAt: r.created_at,
  }));
}

// Finds a usable campaign by id or coupon for this sale and locks it, so its use limit holds
// under concurrent sales. `tenantId` is null when a new office is being opened.
async function resolveCampaign(db, { campaignId, couponCode, tenantId = null, lock = true }) {
  let rows;
  if (campaignId) {
    if (typeof campaignId !== 'string' || !UUID.test(campaignId)) throw fail(404, 'Kampanya bulunamadı.');
    ({ rows } = await db.query(`SELECT * FROM han_saas.campaigns WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [campaignId]));
  } else {
    const code = String(couponCode || '').trim().toUpperCase();
    if (!COUPON.test(code)) throw fail(404, 'Kupon kodu bulunamadı.');
    ({ rows } = await db.query(`SELECT * FROM han_saas.campaigns WHERE coupon_code = $1${lock ? ' FOR UPDATE' : ''}`, [code]));
  }
  if (!rows.length) throw fail(404, campaignId ? 'Kampanya bulunamadı.' : 'Kupon kodu bulunamadı.');
  const c = rows[0];
  const { rows: clock } = await db.query('SELECT CURRENT_TIMESTAMP AS now');
  const now = new Date(clock[0].now).getTime();
  if (c.status !== 'active') throw fail(409, 'Kampanya şu anda kullanılamıyor.');
  if (new Date(c.starts_at).getTime() > now) throw fail(409, 'Kampanya henüz başlamadı.');
  if (new Date(c.ends_at).getTime() <= now) throw fail(409, 'Kampanyanın süresi doldu.');
  if (c.max_uses !== null && c.used_count >= c.max_uses) throw fail(409, 'Kampanyanın kullanım sınırı doldu.');
  if (c.audience === 'new_offices' && tenantId) throw fail(409, 'Bu kampanya yalnızca yeni açılan bürolar içindir.');
  if (c.audience === 'selected' && (!tenantId || !c.tenant_ids.includes(tenantId)))
    throw fail(409, 'Bu kampanya bu büro için tanımlı değil.');
  if (tenantId) {
    const { rows: used } = await db.query(
      'SELECT 1 FROM han_saas.campaign_redemptions WHERE campaign_id = $1 AND tenant_id = $2',
      [c.id, tenantId],
    );
    if (used.length) throw fail(409, 'Bu büro bu kampanyayı daha önce kullandı.');
    if (c.audience === 'without_product' || c.audience === 'trialing') {
      const { rows: owned } = await db.query(
        `SELECT status FROM han_saas.tenant_modules
         WHERE tenant_id = $1 AND (cardinality($2::text[]) = 0 OR module_code = ANY($2::text[]))`,
        [tenantId, c.product_codes],
      );
      if (c.audience === 'without_product' && owned.some((r) => r.status === 'active'))
        throw fail(409, 'Bu kampanya, ürünü henüz almamış bürolar içindir.');
      if (c.audience === 'trialing' && !owned.some((r) => r.status === 'trial'))
        throw fail(409, 'Bu kampanya, ürünü denemekte olan bürolar içindir.');
    }
  }
  return c;
}

// Discount of each sale line under a campaign (integer kuruş, never above the line).
function discountLines(campaign, lines) {
  const value = num(campaign.discount_value);
  const pct = campaign.discount_type === 'percent';
  const limit = APPLIES[campaign.applies];
  return lines.map((line) => {
    const eligible = !campaign.product_codes.length || campaign.product_codes.includes(line.code);
    if (!eligible || !(line.amountKurus > 0)) return { ...line, discountKurus: 0 };
    let discount;
    if (line.oneOff) discount = pct ? Math.round((line.amountKurus * value) / 100) : value * (line.quantity || 1);
    else {
      const months = Math.min(line.months, limit);
      const perMonth = pct ? (line.monthlyKurus * value) / 100 : Math.min(value, line.monthlyKurus);
      discount = Math.round(perMonth * months);
    }
    return { ...line, discountKurus: Math.max(0, Math.min(discount, line.amountKurus)) };
  });
}

// Records the use: one redemption per office and campaign, and the use counter.
async function redeem(db, adminId, campaign, tenantId, discountKurus) {
  await db.query(
    'INSERT INTO han_saas.campaign_redemptions(campaign_id, tenant_id, discount_kurus, created_by) VALUES ($1, $2, $3, $4)',
    [campaign.id, tenantId, discountKurus, adminId],
  );
  await db.query('UPDATE han_saas.campaigns SET used_count = used_count + 1 WHERE id = $1', [campaign.id]);
}

// Preview for the sale forms: which discount a campaign or coupon would give these lines.
async function quote(pool, { campaignId, couponCode, tenantId = null, lines }) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 60) throw fail(400, 'Satış kalemleri geçersiz.');
  const clean = lines.map((l) => {
    if (typeof l.code !== 'string' || !(l.code === 'users' || CODE.test(l.code))) throw fail(400, 'Ürün geçersiz.');
    const amountKurus = num(l.amountKurus);
    if (!Number.isSafeInteger(amountKurus) || amountKurus < 0) throw fail(400, 'Tutar geçersiz.');
    return l.oneOff
      ? { code: l.code, amountKurus, quantity: Math.max(1, Math.floor(num(l.quantity) || 1)), oneOff: true }
      : { code: l.code, amountKurus, monthlyKurus: Math.max(0, num(l.monthlyKurus)), months: Math.max(0, num(l.months)) };
  });
  return inTransaction(
    pool,
    async (db) => {
      const campaign = await resolveCampaign(db, { campaignId, couponCode, tenantId, lock: false });
      const priced = discountLines(campaign, clean);
      return {
        campaign: { id: campaign.id, name: campaign.name },
        lines: priced,
        discountKurus: priced.reduce((sum, l) => sum + l.discountKurus, 0),
      };
    },
    { readOnly: true },
  );
}

module.exports = { upsertCampaign, setCampaignStatus, listCampaigns, resolveCampaign, discountLines, redeem, quote, APPLIES };
