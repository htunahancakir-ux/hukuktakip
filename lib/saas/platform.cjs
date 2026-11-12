const { randomUUID } = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');
const { prepareOffice, insertPreparedOffice } = require('./tenants.cjs');
const { LEGACY_TENANT_ID } = require('./tenant-pool.cjs');
const { GATED_MODULES } = require('./module-gate.cjs');
const { record } = require('./platform-account.cjs');
const campaigns = require('./campaigns.cjs');
const { closeWon } = require('./pipeline.cjs');

// Super-admin operations. Every function takes the platform operator's id, which the
// HTTP layer takes from the verified session, never from the request body. All money is
// integer kuruş (TRY) and every total is computed here: no amount sent by a client is
// trusted except an explicit, bounded operator override that is recorded in the ledger.

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CODE = /^[a-z][a-z0-9-]{1,40}$/;
const MONTH_SECONDS = 30 * 86400;
// General KDV rate in Turkey. It is only the default of the sale form: every sale stores the
// rate the operator confirmed, so a legal rate change never touches recorded sales.
const DEFAULT_VAT_RATE = 20;
// Ledger amounts are KDV-exclusive. KDV is rounded half away from zero per ledger row, in
// integer kuruş; VAT_SQL is the same rule for aggregate queries.
const VAT_SQL = 'round(s.amount_kurus::numeric * s.vat_rate / 100)::bigint';
function vatOf(net, rate) {
  const value = Math.floor((Math.abs(net) * rate + 50) / 100);
  return net < 0 ? -value : value;
}
function vatRate(input) {
  return input.vatRatePercent === undefined ? DEFAULT_VAT_RATE : whole(input.vatRatePercent, 'KDV oranı', 0, 100);
}
const MAX_KURUS = 100_000_000; // 1,000,000.00 TRY per unit price
const fail = (status, message) => Object.assign(new Error(message), { status });
const num = (value) => Number(value ?? 0);

function kurus(value, label, { max = MAX_KURUS, min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw fail(400, `${label} geçersiz.`);
  return value;
}
function whole(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw fail(400, `${label} ${min}–${max} arasında olmalıdır.`);
  return value;
}
function id(value, label = 'Kayıt') {
  if (typeof value !== 'string' || !UUID.test(value)) throw fail(404, `${label} bulunamadı.`);
  return value;
}
function optionalText(value, label, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max) throw fail(400, `${label} çok uzun.`);
  return value.trim();
}
function requiredText(value, label, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max)
    throw fail(400, `${label} ${min}–${max} karakter olmalıdır.`);
  return value.trim();
}
const money = (kurusValue) => (kurusValue / 100).toFixed(2).replace('.', ',') + ' TL';

async function event(db, tenantId, adminId, action, detail = {}) {
  await db.query('INSERT INTO han_saas.tenant_events(tenant_id, admin_id, action, detail) VALUES ($1, $2, $3, $4::jsonb)', [
    tenantId,
    adminId,
    action,
    JSON.stringify(detail),
  ]);
}

async function insertSale(db, adminId, sale) {
  const { rows } = await db.query(
    `INSERT INTO han_saas.sales(id, tenant_id, kind, description, amount_kurus, status, term_months,
       user_count, module_code, invoice_no, created_by, vat_rate, quantity, campaign_id, breakdown, paid_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb,
       CASE WHEN $6 = 'paid' THEN CURRENT_TIMESTAMP END)
     RETURNING id`,
    [
      randomUUID(),
      sale.tenantId,
      sale.kind,
      sale.description,
      sale.amount,
      sale.paid ? 'paid' : 'pending',
      sale.termMonths ?? null,
      sale.userCount ?? null,
      sale.moduleCode ?? null,
      sale.invoiceNo ?? null,
      adminId,
      sale.vatRate,
      sale.quantity ?? null,
      sale.campaignId ?? null,
      sale.breakdown ? JSON.stringify(sale.breakdown) : null,
    ],
  );
  return rows[0].id;
}

// Locks the office's subscription row, which also serialises concurrent sales on it.
async function lockOffice(db, tenantId) {
  const { rows } = await db.query(
    `SELECT t.id, t.slug, t.name, t.status, s.status AS sub_status, s.seat_limit,
            s.user_price_kurus::text AS user_price,
            GREATEST(0, EXTRACT(EPOCH FROM (s.access_until - CURRENT_TIMESTAMP)))::float8 AS remaining_seconds
     FROM han_saas.tenants t JOIN han_saas.subscriptions s ON s.tenant_id = t.id
     WHERE t.id = $1 FOR UPDATE OF s`,
    [tenantId],
  );
  if (!rows.length) throw fail(404, 'Büro bulunamadı veya aboneliği yok.');
  if (rows[0].status === 'closed') throw fail(409, 'Kapatılmış büro üzerinde işlem yapılamaz.');
  return { ...rows[0], userPrice: num(rows[0].user_price), remainingMonths: rows[0].remaining_seconds / MONTH_SECONDS };
}

async function activeModules(db, tenantId) {
  const { rows } = await db.query(
    `SELECT module_code, price_kurus::text AS price FROM han_saas.tenant_modules
     WHERE tenant_id = $1 AND status = 'active' ORDER BY module_code`,
    [tenantId],
  );
  return rows.map((row) => ({ code: row.module_code, price: num(row.price) }));
}

// Campaign of a sale, when the operator chose one (campaignId) or typed a coupon (couponCode).
async function campaignFor(db, input, tenantId) {
  if (!input.campaignId && !input.couponCode) return null;
  return campaigns.resolveCampaign(db, { campaignId: input.campaignId, couponCode: input.couponCode, tenantId });
}
function checkOffers(campaign, offers) {
  const total = offers.reduce((sum, line) => sum + line.discountKurus, 0);
  if (campaign && total <= 0) throw fail(400, 'Kampanya bu satıştaki ürünlere uygulanmıyor.');
  return total;
}
// One adjustment row per discounted line (with its product, for per-product profit), then the
// office's single use of the campaign.
async function bookCampaign(db, adminId, campaign, offers, base, tenantId) {
  if (!campaign) return;
  for (const line of offers)
    if (line.discountKurus > 0)
      await insertSale(db, adminId, {
        ...base,
        tenantId,
        kind: 'adjustment',
        description: `Kampanya: ${campaign.name}`.slice(0, 300),
        amount: -line.discountKurus,
        moduleCode: line.code === 'users' ? null : line.code,
        campaignId: campaign.id,
      });
  await campaigns.redeem(
    db,
    adminId,
    campaign,
    tenantId,
    offers.reduce((sum, line) => sum + line.discountKurus, 0),
  );
}

// Free trial of a monthly module: on for `days` (default: the product's trial days), then off
// by itself. One trial per office and module; converting it is an ordinary "Modül ekle".
async function startTrial(pool, adminId, input) {
  const tenantId = id(input.tenantId, 'Büro');
  if (typeof input.moduleCode !== 'string' || !CODE.test(input.moduleCode)) throw fail(400, 'Modül geçersiz.');
  return inTransaction(pool, async (db) => {
    await lockOffice(db, tenantId);
    const { rows } = await db.query(
      `SELECT code, name, trial_days, monthly_price_kurus::text AS price FROM han_saas.modules
       WHERE code = $1 AND kind = 'module' AND status IN ('selling', 'soon')`,
      [input.moduleCode],
    );
    if (!rows.length) throw fail(400, 'Bu ürün denemeye açık değil.');
    const days = whole(input.days ?? rows[0].trial_days, 'Deneme süresi (gün)', 1, 60);
    const { rows: existing } = await db.query(
      'SELECT status, trial_until FROM han_saas.tenant_modules WHERE tenant_id = $1 AND module_code = $2',
      [tenantId, input.moduleCode],
    );
    if (existing[0]?.status === 'active') throw fail(409, 'Modül bu büroda zaten etkin.');
    if (existing[0]?.trial_until) throw fail(409, 'Bu büro bu modülü daha önce denedi.');
    const { rows: saved } = await db.query(
      `INSERT INTO han_saas.tenant_modules(tenant_id, module_code, price_kurus, status, trial_until)
       VALUES ($1, $2, $3, 'trial', CURRENT_TIMESTAMP + make_interval(days => $4::int))
       ON CONFLICT (tenant_id, module_code) DO UPDATE
       SET status = 'trial', removed_at = NULL, price_kurus = EXCLUDED.price_kurus,
           trial_until = EXCLUDED.trial_until, added_at = clock_timestamp()
       RETURNING trial_until`,
      [tenantId, input.moduleCode, num(rows[0].price), days],
    );
    await event(db, tenantId, adminId, 'trial_started', { module: input.moduleCode, days });
    return { moduleCode: input.moduleCode, days, trialUntil: saved[0].trial_until };
  });
}

// Opens an office as a sale: subscription, first administrator, purchased users, add-on
// modules and the ledger rows, all or nothing. Access starts immediately; `paid: false`
// records the receivable and leaves it pending in the ledger.
async function openOffice(pool, adminId, input) {
  const userCount = whole(input.userCount, 'Kullanıcı sayısı', 1, 10000);
  const userPrice = kurus(input.userPriceKurus, 'Kullanıcı birim fiyatı');
  const term = whole(input.termMonths, 'Süre (ay)', 1, 36);
  const discount = kurus(input.discountKurus ?? 0, 'İndirim', { max: 1_000_000_000_000 });
  const codes = input.moduleCodes ?? [];
  if (!Array.isArray(codes) || codes.length > 50 || codes.some((c) => typeof c !== 'string' || !CODE.test(c)))
    throw fail(400, 'Modül listesi geçersiz.');
  const moduleCodes = [...new Set(codes)];
  const invoiceNo = optionalText(input.invoiceNo, 'Fatura no', 60);
  const paid = input.paid === true;
  const rate = vatRate(input);
  const prepared = await prepareOffice({
    slug: input.slug,
    name: input.name,
    admin: input.admin,
    userLimit: userCount,
  });
  return inTransaction(pool, async (db) => {
    const { rows: modules } = await db.query(
      `SELECT code, name, monthly_price_kurus::text AS price FROM han_saas.modules
       WHERE code = ANY($1::text[]) AND active AND kind = 'module'`,
      [moduleCodes],
    );
    if (modules.length !== moduleCodes.length) throw fail(400, 'Seçilen modüllerden biri satışa açık değil.');
    const usersTotal = userCount * userPrice * term;
    const moduleLines = modules.map((m) => ({ ...m, price: num(m.price), total: num(m.price) * term }));
    const total = usersTotal + moduleLines.reduce((sum, m) => sum + m.total, 0);
    const campaign = await campaignFor(db, input, null);
    const offers = campaign
      ? campaigns.discountLines(campaign, [
          { code: 'users', monthlyKurus: userCount * userPrice, months: term, amountKurus: usersTotal },
          ...moduleLines.map((m) => ({ code: m.code, monthlyKurus: m.price, months: term, amountKurus: m.total })),
        ])
      : [];
    const campaignDiscount = checkOffers(campaign, offers);
    if (discount + campaignDiscount > total) throw fail(400, 'İndirim toplam tutarı aşamaz.');
    const office = await insertPreparedOffice(db, prepared, {
      months: term,
      userPriceKurus: userPrice,
      status: 'active',
      planCode: 'paid',
    });
    await db.query("UPDATE han_saas.tenants SET status = 'enabled' WHERE id = $1", [office.id]);
    const base = { tenantId: office.id, paid, invoiceNo, termMonths: term, vatRate: rate };
    await insertSale(db, adminId, {
      ...base,
      kind: 'new_office',
      description: `Yeni büro: ${userCount} kullanıcı × ${money(userPrice)} × ${term} ay`,
      amount: usersTotal,
      userCount,
      campaignId: campaign?.id,
    });
    for (const m of moduleLines) {
      await db.query(
        'INSERT INTO han_saas.tenant_modules(tenant_id, module_code, price_kurus) VALUES ($1, $2, $3)',
        [office.id, m.code, m.price],
      );
      await insertSale(db, adminId, {
        ...base,
        kind: 'module',
        description: `Modül: ${m.name} × ${term} ay`,
        amount: m.total,
        moduleCode: m.code,
        campaignId: campaign?.id,
      });
    }
    await bookCampaign(db, adminId, campaign, offers, base, office.id);
    if (input.prospectId) await closeWon(db, adminId, input.prospectId, { tenantId: office.id, kind: 'new_office' });
    if (discount > 0)
      await insertSale(db, adminId, {
        ...base,
        kind: 'adjustment',
        description: 'İndirim',
        amount: -discount,
      });
    await event(db, office.id, adminId, 'office_opened', {
      userCount,
      userPrice,
      term,
      moduleCodes,
      discount,
      paid,
      ...(campaign ? { campaign: campaign.id, campaignDiscount } : {}),
    });
    return {
      office: { id: office.id, slug: office.slug, name: office.name, status: 'enabled', adminUserId: office.adminUserId },
      totalKurus: total,
      discountKurus: discount,
      campaignDiscountKurus: campaignDiscount,
      payableKurus: total - discount - campaignDiscount,
      vatRatePercent: rate,
      vatKurus:
        vatOf(usersTotal, rate) +
        moduleLines.reduce((sum, m) => sum + vatOf(m.total, rate), 0) -
        vatOf(discount, rate) -
        offers.reduce((sum, l) => sum + vatOf(l.discountKurus, rate), 0),
    };
  });
}

// Sets the purchased user count. Increases are charged pro rata for the remaining term
// at the (possibly updated) unit price; `chargeKurus` lets the operator override that
// figure. Decreases cannot go below the users already in the office and are not
// refunded automatically (record a refund explicitly).
async function changeUsers(pool, adminId, input) {
  const tenantId = id(input.tenantId, 'Büro');
  const userCount = whole(input.userCount, 'Kullanıcı sayısı', 1, 10000);
  const invoiceNo = optionalText(input.invoiceNo, 'Fatura no', 60);
  const rate = vatRate(input);
  return inTransaction(pool, async (db) => {
    const office = await lockOffice(db, tenantId);
    const price =
      input.userPriceKurus === undefined ? office.userPrice : kurus(input.userPriceKurus, 'Kullanıcı birim fiyatı');
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM han_saas.memberships WHERE tenant_id = $1 AND status = 'active'",
      [tenantId],
    );
    if (userCount < rows[0].n)
      throw fail(409, `Büroda ${rows[0].n} aktif kullanıcı var; sayı bunun altına indirilemez.`);
    const delta = userCount - office.seat_limit;
    const prorated = delta > 0 ? Math.round(delta * price * office.remainingMonths) : 0;
    const charge =
      input.chargeKurus === undefined ? prorated : kurus(input.chargeKurus, 'Tutar', { max: 1_000_000_000_000 });
    await db.query('UPDATE han_saas.subscriptions SET seat_limit = $2, user_price_kurus = $3 WHERE tenant_id = $1', [
      tenantId,
      userCount,
      price,
    ]);
    let saleId = null;
    if (delta > 0 && charge > 0)
      saleId = await insertSale(db, adminId, {
        tenantId,
        kind: 'users',
        description: `Kullanıcı artışı: ${office.seat_limit} → ${userCount} (kalan süre oranlı)`,
        amount: charge,
        userCount,
        paid: input.paid === true,
        invoiceNo,
        vatRate: rate,
      });
    await event(db, tenantId, adminId, 'users_changed', { from: office.seat_limit, to: userCount, price, charge });
    return { userCount, userPriceKurus: price, chargeKurus: saleId ? charge : 0, vatKurus: saleId ? vatOf(charge, rate) : 0, saleId };
  });
}

async function addModule(pool, adminId, input) {
  const tenantId = id(input.tenantId, 'Büro');
  if (typeof input.moduleCode !== 'string' || !CODE.test(input.moduleCode)) throw fail(400, 'Modül geçersiz.');
  const invoiceNo = optionalText(input.invoiceNo, 'Fatura no', 60);
  const rate = vatRate(input);
  return inTransaction(pool, async (db) => {
    const office = await lockOffice(db, tenantId);
    const { rows } = await db.query(
      "SELECT code, name, monthly_price_kurus::text AS price FROM han_saas.modules WHERE code = $1 AND active AND kind = 'module'",
      [input.moduleCode],
    );
    if (!rows.length) throw fail(400, 'Modül satışa açık değil.');
    const price = num(rows[0].price);
    // The campaign is checked against the office as it is before this sale ("not bought yet",
    // "trialing"), so it is resolved before the module row changes.
    const campaign = await campaignFor(db, input, tenantId);
    const { rows: existing } = await db.query(
      `INSERT INTO han_saas.tenant_modules(tenant_id, module_code, price_kurus) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, module_code) DO UPDATE
       SET status = 'active', removed_at = NULL, price_kurus = EXCLUDED.price_kurus, added_at = clock_timestamp()
       WHERE han_saas.tenant_modules.status IN ('removed', 'trial') RETURNING module_code`,
      [tenantId, input.moduleCode, price],
    );
    if (!existing.length) throw fail(409, 'Modül bu büroda zaten etkin.');
    const prorated = Math.round(price * office.remainingMonths);
    const charge =
      input.chargeKurus === undefined ? prorated : kurus(input.chargeKurus, 'Tutar', { max: 1_000_000_000_000 });
    const offers = campaign
      ? campaigns.discountLines(campaign, [
          { code: input.moduleCode, monthlyKurus: price, months: office.remainingMonths, amountKurus: charge },
        ])
      : [];
    const campaignDiscount = checkOffers(campaign, offers);
    let saleId = null;
    const base = { tenantId, paid: input.paid === true, invoiceNo, vatRate: rate };
    if (charge > 0) {
      saleId = await insertSale(db, adminId, {
        ...base,
        kind: 'module',
        description: `Modül: ${rows[0].name} (kalan süre oranlı)`,
        amount: charge,
        moduleCode: input.moduleCode,
        campaignId: campaign?.id,
      });
      await bookCampaign(db, adminId, campaign, offers, base, tenantId);
    }
    if (input.prospectId) await closeWon(db, adminId, input.prospectId, { tenantId, kind: 'upsell' });
    await event(db, tenantId, adminId, 'module_added', {
      module: input.moduleCode,
      price,
      charge,
      ...(campaign ? { campaign: campaign.id, campaignDiscount } : {}),
    });
    return {
      moduleCode: input.moduleCode,
      priceKurus: price,
      chargeKurus: saleId ? charge : 0,
      campaignDiscountKurus: campaignDiscount,
      vatKurus: saleId ? vatOf(charge, rate) - vatOf(campaignDiscount, rate) : 0,
      saleId,
    };
  });
}

// Takes effect immediately; no automatic refund. The ledger keeps the original sale.
async function removeModule(pool, adminId, input) {
  const tenantId = id(input.tenantId, 'Büro');
  return inTransaction(pool, async (db) => {
    await lockOffice(db, tenantId);
    const { rows } = await db.query(
      `UPDATE han_saas.tenant_modules SET status = 'removed', removed_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $1 AND module_code = $2 AND status IN ('active', 'trial') RETURNING module_code`,
      [tenantId, String(input.moduleCode)],
    );
    if (!rows.length) throw fail(404, 'Modül bu büroda etkin değil.');
    await event(db, tenantId, adminId, 'module_removed', { module: input.moduleCode });
    return { moduleCode: rows[0].module_code };
  });
}

// Extends access by `termMonths` from the later of now and the current end date, billed
// at the office's agreed user price and the module prices locked at sale time.
async function renewOffice(pool, adminId, input) {
  const tenantId = id(input.tenantId, 'Büro');
  const term = whole(input.termMonths, 'Süre (ay)', 1, 36);
  const discount = kurus(input.discountKurus ?? 0, 'İndirim', { max: 1_000_000_000_000 });
  const invoiceNo = optionalText(input.invoiceNo, 'Fatura no', 60);
  const rate = vatRate(input);
  return inTransaction(pool, async (db) => {
    const office = await lockOffice(db, tenantId);
    const modules = await activeModules(db, tenantId);
    const usersTotal = office.seat_limit * office.userPrice * term;
    const total = usersTotal + modules.reduce((sum, m) => sum + m.price * term, 0);
    const campaign = await campaignFor(db, input, tenantId);
    const offers = campaign
      ? campaigns.discountLines(campaign, [
          { code: 'users', monthlyKurus: office.seat_limit * office.userPrice, months: term, amountKurus: usersTotal },
          ...modules.map((m) => ({ code: m.code, monthlyKurus: m.price, months: term, amountKurus: m.price * term })),
        ])
      : [];
    const campaignDiscount = checkOffers(campaign, offers);
    if (discount + campaignDiscount > total) throw fail(400, 'İndirim toplam tutarı aşamaz.');
    const { rows } = await db.query(
      `UPDATE han_saas.subscriptions SET status = 'active', plan_code = 'paid',
         access_until = GREATEST(access_until, CURRENT_TIMESTAMP) + make_interval(months => $2::int)
       WHERE tenant_id = $1 RETURNING access_until`,
      [tenantId, term],
    );
    const base = { tenantId, paid: input.paid === true, invoiceNo, termMonths: term, vatRate: rate };
    const saleId = await insertSale(db, adminId, {
      ...base,
      kind: 'renewal',
      description: `Yenileme: ${office.seat_limit} kullanıcı${modules.length ? ' + ' + modules.length + ' modül' : ''} × ${term} ay`,
      amount: total,
      userCount: office.seat_limit,
      campaignId: campaign?.id,
      breakdown: [
        { code: 'users', amount: usersTotal },
        ...modules.map((m) => ({ code: m.code, amount: m.price * term })),
      ],
    });
    if (discount > 0)
      await insertSale(db, adminId, { ...base, kind: 'adjustment', description: 'Yenileme indirimi', amount: -discount });
    await bookCampaign(db, adminId, campaign, offers, base, tenantId);
    await event(db, tenantId, adminId, 'renewed', {
      term,
      total,
      discount,
      ...(campaign ? { campaign: campaign.id, campaignDiscount } : {}),
    });
    return {
      saleId,
      accessUntil: rows[0].access_until,
      totalKurus: total,
      discountKurus: discount,
      campaignDiscountKurus: campaignDiscount,
      payableKurus: total - discount - campaignDiscount,
      vatRatePercent: rate,
      vatKurus:
        vatOf(total, rate) - vatOf(discount, rate) - offers.reduce((sum, l) => sum + vatOf(l.discountKurus, rate), 0),
    };
  });
}

async function markSalePaid(pool, adminId, input) {
  const saleId = id(input.saleId, 'Satış');
  const invoiceNo = optionalText(input.invoiceNo, 'Fatura no', 60);
  return inTransaction(pool, async (db) => {
    const { rows } = await db.query(
      `UPDATE han_saas.sales SET status = 'paid', paid_at = CURRENT_TIMESTAMP,
         invoice_no = coalesce($2, invoice_no)
       WHERE id = $1 AND status = 'pending' RETURNING tenant_id, amount_kurus::text AS amount`,
      [saleId, invoiceNo],
    );
    if (!rows.length) throw fail(409, 'Satış bulunamadı veya bekleyen durumda değil.');
    await event(db, rows[0].tenant_id, adminId, 'sale_paid', { saleId, amount: num(rows[0].amount) });
    return { saleId };
  });
}

// Voiding keeps the row for the audit trail and removes it from revenue. It does not
// undo what was delivered (users, modules, access): change those explicitly.
async function voidSale(pool, adminId, input) {
  const saleId = id(input.saleId, 'Satış');
  const reason = requiredText(input.reason, 'Gerekçe', 3, 300);
  return inTransaction(pool, async (db) => {
    const { rows } = await db.query(
      `UPDATE han_saas.sales SET status = 'void', voided_at = CURRENT_TIMESTAMP, void_reason = $2,
         paid_at = NULL
       WHERE id = $1 AND status IN ('pending', 'paid')
       RETURNING tenant_id, amount_kurus::text AS amount`,
      [saleId, reason],
    );
    if (!rows.length) throw fail(409, 'Satış bulunamadı veya zaten iptal edilmiş.');
    await event(db, rows[0].tenant_id, adminId, 'sale_voided', { saleId, amount: num(rows[0].amount), reason });
    return { saleId };
  });
}

async function recordRefund(pool, adminId, input) {
  const tenantId = id(input.tenantId, 'Büro');
  const amount = kurus(input.amountKurus, 'İade tutarı', { min: 1, max: 1_000_000_000_000 });
  const description = requiredText(input.description, 'Açıklama', 3, 300);
  const invoiceNo = optionalText(input.invoiceNo, 'Fatura no', 60);
  const rate = vatRate(input);
  return inTransaction(pool, async (db) => {
    const { rows: exists } = await db.query('SELECT id FROM han_saas.tenants WHERE id = $1 FOR UPDATE', [tenantId]);
    if (!exists.length) throw fail(404, 'Büro bulunamadı.');
    const { rows } = await db.query(
      "SELECT coalesce(sum(amount_kurus), 0)::text AS total FROM han_saas.sales WHERE tenant_id = $1 AND status = 'paid'",
      [tenantId],
    );
    if (amount > num(rows[0].total)) throw fail(409, 'İade tutarı bu büronun tahsil edilen toplamını aşamaz.');
    const saleId = await insertSale(db, adminId, {
      tenantId,
      kind: 'refund',
      description,
      amount: -amount,
      paid: true,
      invoiceNo,
      vatRate: rate,
    });
    await event(db, tenantId, adminId, 'refunded', { amount, description });
    return { saleId };
  });
}

const TRANSITIONS = {
  provisioning: ['enabled', 'closed'],
  enabled: ['suspended', 'closed'],
  suspended: ['enabled', 'closed'],
  closed: [],
};

// Taking an office offline is immediate for new requests (the Host resolver stops
// serving it, within its short cache). 'closed' is final; suspension is reversible.
async function setOfficeStatus(pool, adminId, input) {
  const tenantId = id(input.tenantId, 'Büro');
  if (tenantId === LEGACY_TENANT_ID)
    throw fail(409, 'Mevcut büro kök alan adıyla çalışır ve buradan pasife alınamaz.');
  const status = String(input.status);
  if (!['enabled', 'suspended', 'closed'].includes(status)) throw fail(400, 'Geçersiz durum.');
  const reason = status === 'enabled' ? optionalText(input.reason, 'Gerekçe', 300) : requiredText(input.reason, 'Gerekçe', 3, 300);
  return inTransaction(pool, async (db) => {
    const { rows } = await db.query('SELECT status FROM han_saas.tenants WHERE id = $1 FOR UPDATE', [tenantId]);
    if (!rows.length) throw fail(404, 'Büro bulunamadı.');
    if (!TRANSITIONS[rows[0].status].includes(status))
      throw fail(409, `Büro ${rows[0].status} durumundan ${status} durumuna alınamaz.`);
    if (status === 'enabled') {
      const { rows: sub } = await db.query(
        `SELECT 1 FROM han_saas.subscriptions WHERE tenant_id = $1 AND status IN ('trialing', 'active')
         AND access_until > CURRENT_TIMESTAMP`,
        [tenantId],
      );
      if (!sub.length) throw fail(409, 'Etkinleştirmek için geçerli bir abonelik gerekir; önce yenileyin.');
    }
    await db.query('UPDATE han_saas.tenants SET status = $2 WHERE id = $1', [tenantId, status]);
    await event(db, tenantId, adminId, 'status_' + status, { from: rows[0].status, reason });
    return { tenantId, status };
  });
}

// Product catalog (han_saas.modules). `kind`: module (monthly add-on behind a feature gate),
// usage_pack (one-off package, e.g. 1000 SMS) or service (one-off, e.g. setup). `status`:
// draft → soon (announced, not sold) → selling → retired. The older form { active: true }
// still means "selling".
const PRODUCT_KINDS = ['module', 'usage_pack', 'service'];
const PRODUCT_STATUSES = ['draft', 'soon', 'selling', 'retired'];
async function upsertModule(pool, input, adminId = null) {
  if (typeof input.code !== 'string' || !CODE.test(input.code)) throw fail(400, 'Ürün kodu geçersiz.');
  const name = requiredText(input.name, 'Ürün adı', 2, 120);
  const description = optionalText(input.description, 'Açıklama', 500) ?? '';
  const price = kurus(input.monthlyPriceKurus, 'Fiyat');
  const kind = input.kind ?? 'module';
  if (!PRODUCT_KINDS.includes(kind)) throw fail(400, 'Ürün türü geçersiz.');
  const status = input.status ?? (input.active === true ? 'selling' : 'draft');
  if (!PRODUCT_STATUSES.includes(status)) throw fail(400, 'Ürün durumu geçersiz.');
  if (status === 'selling' && price === 0) throw fail(400, 'Satışa açmak için fiyat girin.');
  const features = input.features ?? [];
  if (
    !Array.isArray(features) ||
    features.length > 12 ||
    features.some((f) => typeof f !== 'string' || !f.trim() || f.trim().length > 120)
  )
    throw fail(400, 'Özellik listesi en fazla 12 madde, her biri en fazla 120 karakter olabilir.');
  const trialDays = kind === 'module' ? whole(input.trialDays ?? 0, 'Deneme süresi (gün)', 0, 60) : 0;
  let packQuantity = null;
  let packUnit = null;
  if (kind === 'usage_pack') {
    packQuantity = whole(input.packQuantity, 'Paket miktarı', 1, 100_000_000);
    packUnit = requiredText(input.packUnit, 'Paket birimi', 1, 30);
  }
  const sortOrder = whole(input.sortOrder ?? 100, 'Sıra', 0, 1000);
  return inTransaction(pool, async (db) => {
    const { rows: before } = await db.query('SELECT kind FROM han_saas.modules WHERE code = $1 FOR UPDATE', [
      input.code,
    ]);
    if (before.length && before[0].kind !== kind) {
      const { rows: used } = await db.query(
        `SELECT 1 FROM han_saas.sales WHERE module_code = $1
         UNION ALL SELECT 1 FROM han_saas.tenant_modules WHERE module_code = $1 LIMIT 1`,
        [input.code],
      );
      if (used.length) throw fail(409, 'Satılmış bir ürünün türü değiştirilemez; yeni bir ürün oluşturun.');
    }
    await db.query(
      `INSERT INTO han_saas.modules(code, name, description, monthly_price_kurus, active, kind, status, features,
         trial_days, pack_quantity, pack_unit, sort_order, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
         monthly_price_kurus = EXCLUDED.monthly_price_kurus, active = EXCLUDED.active, kind = EXCLUDED.kind,
         status = EXCLUDED.status, features = EXCLUDED.features, trial_days = EXCLUDED.trial_days,
         pack_quantity = EXCLUDED.pack_quantity, pack_unit = EXCLUDED.pack_unit, sort_order = EXCLUDED.sort_order,
         updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [
        input.code,
        name,
        description,
        price,
        status === 'selling',
        kind,
        status,
        JSON.stringify(features.map((f) => f.trim())),
        trialDays,
        packQuantity,
        packUnit,
        sortOrder,
        adminId,
      ],
    );
    if (adminId) await record(db, adminId, 'product.save', input.code, `${name} · ${status} · ${money(price)}`);
    return { code: input.code };
  });
}

async function listModules(pool) {
  const { rows } = await pool.query(
    `SELECT m.code, m.name, m.description, m.monthly_price_kurus::text AS price, m.active, m.kind, m.status,
            m.features, m.trial_days, m.pack_quantity, m.pack_unit, m.sort_order,
            (SELECT count(*)::int FROM han_saas.tenant_modules tm
               WHERE tm.module_code = m.code AND tm.status = 'active') AS offices,
            (SELECT coalesce(sum(tm.price_kurus), 0)::text FROM han_saas.tenant_modules tm
               WHERE tm.module_code = m.code AND tm.status = 'active') AS monthly,
            (SELECT count(*)::int FROM han_saas.sales s WHERE s.module_code = m.code AND s.status <> 'void') AS sold,
            (SELECT coalesce(sum(s.amount_kurus), 0)::text FROM han_saas.sales s
               WHERE s.module_code = m.code AND s.status = 'paid') AS paid
     FROM han_saas.modules m
     ORDER BY array_position(ARRAY['selling', 'soon', 'draft', 'retired'], m.status), m.sort_order, m.name`,
  );
  return rows.map((row) => ({
    code: row.code,
    name: row.name,
    description: row.description,
    monthlyPriceKurus: num(row.price),
    active: row.active,
    kind: row.kind,
    status: row.status,
    features: row.features,
    trialDays: row.trial_days,
    packQuantity: row.pack_quantity,
    packUnit: row.pack_unit,
    sortOrder: row.sort_order,
    offices: row.offices,
    monthlyKurus: num(row.monthly),
    sold: row.sold,
    paidKurus: num(row.paid),
    // true: the application switches the feature off for offices that were not sold it.
    gated: GATED_MODULES.includes(row.code),
  }));
}

// Sells a one-off product (a service or a usage package) to an office. Monthly add-ons go
// through addModule. The amount is price × quantity unless the operator overrides it.
async function sellProduct(pool, adminId, input) {
  const tenantId = id(input.tenantId, 'Büro');
  if (typeof input.code !== 'string' || !CODE.test(input.code)) throw fail(400, 'Ürün geçersiz.');
  const quantity = whole(input.quantity ?? 1, 'Adet', 1, 10000);
  const invoiceNo = optionalText(input.invoiceNo, 'Fatura no', 60);
  const rate = vatRate(input);
  return inTransaction(pool, async (db) => {
    await lockOffice(db, tenantId);
    const { rows } = await db.query(
      `SELECT code, name, kind, monthly_price_kurus::text AS price, pack_quantity, pack_unit FROM han_saas.modules
       WHERE code = $1 AND active`,
      [input.code],
    );
    if (!rows.length) throw fail(400, 'Ürün satışa açık değil.');
    const product = rows[0];
    if (product.kind === 'module') throw fail(400, 'Aylık modüller büroya "Modül ekle" ile satılır.');
    const listed = num(product.price) * quantity;
    const amount =
      input.chargeKurus === undefined ? listed : kurus(input.chargeKurus, 'Tutar', { max: 1_000_000_000_000 });
    const campaign = await campaignFor(db, input, tenantId);
    const offers = campaign
      ? campaigns.discountLines(campaign, [{ code: product.code, amountKurus: amount, quantity, oneOff: true }])
      : [];
    const campaignDiscount = checkOffers(campaign, offers);
    const what =
      product.kind === 'usage_pack'
        ? `${product.name} (${quantity} × ${product.pack_quantity} ${product.pack_unit})`
        : `${product.name}${quantity > 1 ? ` × ${quantity}` : ''}`;
    const base = { tenantId, paid: input.paid === true, invoiceNo, vatRate: rate };
    const saleId = await insertSale(db, adminId, {
      ...base,
      kind: product.kind,
      description: what.slice(0, 300),
      amount,
      moduleCode: product.code,
      quantity,
      campaignId: campaign?.id,
    });
    await bookCampaign(db, adminId, campaign, offers, base, tenantId);
    if (input.prospectId) await closeWon(db, adminId, input.prospectId, { tenantId, kind: 'upsell' });
    await event(db, tenantId, adminId, 'product_sold', {
      product: product.code,
      quantity,
      amount,
      ...(campaign ? { campaign: campaign.id, campaignDiscount } : {}),
    });
    return {
      saleId,
      code: product.code,
      quantity,
      amountKurus: amount,
      campaignDiscountKurus: campaignDiscount,
      payableKurus: amount - campaignDiscount,
      vatKurus: vatOf(amount, rate) - vatOf(campaignDiscount, rate),
    };
  });
}

const OFFICES_SQL = `
  SELECT t.id, t.slug, t.name, t.status, t.created_at,
    s.status AS sub_status, s.plan_code, s.access_until, s.seat_limit,
    s.user_price_kurus::text AS user_price,
    -- Accounts the office created inside its own application live in its workspace state, not in
    -- memberships; count whichever is larger so the console never under-reports.
    GREATEST(
      (SELECT count(*)::int FROM han_saas.memberships m WHERE m.tenant_id = t.id AND m.status = 'active'),
      coalesce((SELECT count(*)::int FROM han_private.han_state hs
                CROSS JOIN LATERAL jsonb_array_elements(
                  CASE WHEN jsonb_typeof(hs.payload->'users') = 'array' THEN hs.payload->'users' ELSE '[]'::jsonb END) u
                WHERE hs.tenant_id = t.id AND hs.id = 1 AND coalesce(u->>'active', 'true') <> 'false'
                  AND coalesce(u->>'platformSupport', 'false') <> 'true'), 0)
    ) AS used,
    coalesce((SELECT sum(price_kurus) FROM han_saas.tenant_modules tm
      WHERE tm.tenant_id = t.id AND tm.status = 'active'), 0)::text AS module_monthly,
    coalesce((SELECT array_agg(module_code ORDER BY module_code) FROM han_saas.tenant_modules tm
      WHERE tm.tenant_id = t.id AND tm.status = 'active'), '{}') AS modules,
    coalesce((SELECT sum(amount_kurus) FROM han_saas.sales x
      WHERE x.tenant_id = t.id AND x.status = 'paid'), 0)::text AS paid_total,
    coalesce((SELECT sum(amount_kurus) FROM han_saas.sales x
      WHERE x.tenant_id = t.id AND x.status = 'pending'), 0)::text AS pending_total
  FROM han_saas.tenants t LEFT JOIN han_saas.subscriptions s ON s.tenant_id = t.id`;

function officeRow(row, now) {
  const hasSub = row.sub_status !== null;
  const monthly = hasSub ? row.seat_limit * num(row.user_price) + num(row.module_monthly) : 0;
  const until = row.access_until ? new Date(row.access_until).getTime() : null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    subscription: hasSub
      ? {
          status: row.sub_status,
          planCode: row.plan_code,
          accessUntil: row.access_until,
          expired: until !== null && until <= now,
          daysLeft: until === null ? null : Math.ceil((until - now) / 86400000),
        }
      : null,
    userLimit: hasSub ? row.seat_limit : null,
    usersUsed: row.used,
    userPriceKurus: hasSub ? num(row.user_price) : null,
    modules: row.modules,
    monthlyKurus: monthly,
    paidKurus: num(row.paid_total),
    pendingKurus: num(row.pending_total),
    legacy: row.id === LEGACY_TENANT_ID,
  };
}

async function dashboard(pool) {
  return inTransaction(
    pool,
    async (db) => {
      const now = Date.now();
      const offices = (await db.query(OFFICES_SQL + ' ORDER BY t.created_at DESC')).rows.map((r) => officeRow(r, now));
      const billable = offices.filter(
        (o) => o.status === 'enabled' && o.subscription?.status === 'active' && !o.subscription.expired,
      );
      const live = offices.filter((o) => o.status === 'enabled');
      const byStatus = Object.fromEntries(['provisioning', 'enabled', 'suspended', 'closed'].map((s) => [s, 0]));
      for (const o of offices) byStatus[o.status]++;
      const months = (
        await db.query(
          `WITH m AS (SELECT generate_series(
              date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Istanbul') - interval '11 months',
              date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Istanbul'), interval '1 month') AS month)
           SELECT to_char(m.month, 'YYYY-MM') AS month,
             coalesce(sum(s.amount_kurus), 0)::text AS total
           FROM m LEFT JOIN han_saas.sales s ON s.status = 'paid'
             AND date_trunc('month', s.paid_at AT TIME ZONE 'Europe/Istanbul') = m.month
           GROUP BY m.month ORDER BY m.month`,
        )
      ).rows.map((r) => ({ month: r.month, kurus: num(r.total) }));
      const totals = (
        await db.query(
          `SELECT
             coalesce(sum(amount_kurus) FILTER (WHERE status = 'paid'), 0)::text AS paid,
             coalesce(sum(amount_kurus) FILTER (WHERE status = 'pending'), 0)::text AS pending,
             count(*) FILTER (WHERE status = 'pending')::int AS pending_count
           FROM han_saas.sales`,
        )
      ).rows[0];
      const byKind = (
        await db.query(
          `SELECT kind, sum(amount_kurus)::text AS total FROM han_saas.sales WHERE status = 'paid'
           GROUP BY kind ORDER BY kind`,
        )
      ).rows.map((r) => ({ kind: r.kind, kurus: num(r.total) }));
      const moduleRows = (
        await db.query(
          `SELECT m.code, m.name,
             (SELECT count(*)::int FROM han_saas.tenant_modules tm
               JOIN han_saas.tenants t ON t.id = tm.tenant_id
               WHERE tm.module_code = m.code AND tm.status = 'active' AND t.status = 'enabled') AS offices,
             coalesce((SELECT sum(tm.price_kurus) FROM han_saas.tenant_modules tm
               JOIN han_saas.tenants t ON t.id = tm.tenant_id
               WHERE tm.module_code = m.code AND tm.status = 'active' AND t.status = 'enabled'), 0)::text AS monthly,
             coalesce((SELECT sum(amount_kurus) FROM han_saas.sales x
               WHERE x.module_code = m.code AND x.status = 'paid'), 0)::text AS paid
           FROM han_saas.modules m ORDER BY m.name`,
        )
      ).rows.map((r) => ({ code: r.code, name: r.name, offices: r.offices, monthlyKurus: num(r.monthly), paidKurus: num(r.paid) }));
      const pending = (
        await db.query(
          `SELECT s.id, s.tenant_id, t.name AS tenant_name, s.kind, s.description, s.amount_kurus::text AS amount,
                  s.vat_rate, ${VAT_SQL}::text AS vat, s.created_at FROM han_saas.sales s JOIN han_saas.tenants t ON t.id = s.tenant_id
           WHERE s.status = 'pending' ORDER BY s.created_at LIMIT 100`,
        )
      ).rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        kind: r.kind,
        description: r.description,
        amountKurus: num(r.amount),
        vatRatePercent: r.vat_rate,
        vatKurus: num(r.vat),
        grossKurus: num(r.amount) + num(r.vat),
        createdAt: r.created_at,
      }));
      const thisMonth = months[months.length - 1].kurus;
      return {
        generatedAt: new Date(now).toISOString(),
        offices: { total: offices.length, ...byStatus },
        users: {
          sold: live.reduce((sum, o) => sum + (o.userLimit ?? 0), 0),
          used: live.reduce((sum, o) => sum + o.usersUsed, 0),
        },
        revenue: {
          mrrKurus: billable.reduce((sum, o) => sum + o.monthlyKurus, 0),
          paidKurus: num(totals.paid),
          thisMonthKurus: thisMonth,
          lastMonthKurus: months[months.length - 2].kurus,
          pendingKurus: num(totals.pending),
          pendingCount: totals.pending_count,
          months,
          byKind,
        },
        attention: {
          expiringSoon: offices.filter(
            (o) => o.status === 'enabled' && o.subscription && !o.subscription.expired && o.subscription.daysLeft <= 14,
          ).length,
          expired: offices.filter((o) => o.status === 'enabled' && o.subscription?.expired).length,
          trials: offices.filter((o) => o.status === 'enabled' && o.subscription?.status === 'trialing').length,
          fullSeats: live.filter((o) => o.userLimit !== null && o.usersUsed >= o.userLimit).length,
        },
        modules: moduleRows,
        pendingSales: pending,
        officeList: offices,
      };
    },
    { readOnly: true },
  );
}

async function officeDetail(pool, input) {
  const tenantId = id(input.tenantId, 'Büro');
  return inTransaction(
    pool,
    async (db) => {
      const { rows } = await db.query(OFFICES_SQL + ' WHERE t.id = $1', [tenantId]);
      if (!rows.length) throw fail(404, 'Büro bulunamadı.');
      const sales = (
        await db.query(
          `SELECT s.id, s.kind, s.description, s.amount_kurus::text AS amount, s.vat_rate, ${VAT_SQL}::text AS vat,
                  s.status, s.term_months, s.invoice_no,
                  s.created_at, s.paid_at, s.voided_at, s.void_reason, a.name AS created_by
           FROM han_saas.sales s JOIN han_saas.platform_admins a ON a.id = s.created_by
           WHERE s.tenant_id = $1 ORDER BY s.created_at DESC, s.id LIMIT 100`,
          [tenantId],
        )
      ).rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        description: r.description,
        amountKurus: num(r.amount),
        vatRatePercent: r.vat_rate,
        vatKurus: num(r.vat),
        grossKurus: num(r.amount) + num(r.vat),
        status: r.status,
        termMonths: r.term_months,
        invoiceNo: r.invoice_no,
        createdAt: r.created_at,
        paidAt: r.paid_at,
        voidedAt: r.voided_at,
        voidReason: r.void_reason,
        createdBy: r.created_by,
      }));
      const events = (
        await db.query(
          `SELECT e.id::text AS id, e.action, e.detail, e.created_at, a.name AS admin_name
           FROM han_saas.tenant_events e JOIN han_saas.platform_admins a ON a.id = e.admin_id
           WHERE e.tenant_id = $1 ORDER BY e.id DESC LIMIT 50`,
          [tenantId],
        )
      ).rows.map((r) => ({ id: r.id, action: r.action, detail: r.detail, createdAt: r.created_at, admin: r.admin_name }));
      const modules = (
        await db.query(
          `SELECT tm.module_code, m.name, tm.price_kurus::text AS price, tm.status, tm.added_at, tm.trial_until
           FROM han_saas.tenant_modules tm JOIN han_saas.modules m ON m.code = tm.module_code
           WHERE tm.tenant_id = $1 ORDER BY tm.status, m.name`,
          [tenantId],
        )
      ).rows.map((r) => ({
        code: r.module_code,
        name: r.name,
        priceKurus: num(r.price),
        status: r.status,
        addedAt: r.added_at,
        trialUntil: r.trial_until,
      }));
      const cost = (
        await db.query(
          "SELECT coalesce(sum(amount_kurus), 0)::text AS total FROM han_saas.expenses WHERE tenant_id = $1 AND status = 'active'",
          [tenantId],
        )
      ).rows[0];
      return { office: officeRow(rows[0], Date.now()), sales, events, modules, costKurus: num(cost.total) };
    },
    { readOnly: true },
  );
}

module.exports = {
  DEFAULT_VAT_RATE,
  VAT_SQL,
  vatOf,
  openOffice,
  changeUsers,
  addModule,
  removeModule,
  renewOffice,
  markSalePaid,
  voidSale,
  recordRefund,
  setOfficeStatus,
  upsertModule,
  listModules,
  sellProduct,
  startTrial,
  PRODUCT_KINDS,
  PRODUCT_STATUSES,
  dashboard,
  officeDetail,
};
