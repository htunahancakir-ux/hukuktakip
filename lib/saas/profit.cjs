const { randomUUID } = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');
const { record } = require('./platform-account.cjs');
const { CATEGORIES } = require('./finance.cjs');
const { DEFAULT_VAT_RATE } = require('./platform.cjs');
const { LEGACY_TENANT_ID } = require('./tenant-pool.cjs');

// Profitability: per product and per office, plus recurring expenses and unit costs.
//
// Revenue is the collected (paid) ledger in the chosen months, KDV excluded. A product's revenue
// is its own sale rows, its share of renewals (sales.breakdown) and its campaign discounts;
// "users" collects user licences, new-office rows and refunds/adjustments without a product.
// Costs are expenses linked to the product or office, plus an ESTIMATE of usage cost: AI
// tokens, SMS segments and phone minutes × the unit costs the operator enters. The estimate is
// only used to share costs out; the monthly profit (finance.cjs financeSummary) counts real
// expenses only, so an AI invoice entered as an expense is not counted twice.

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CODE = /^[a-z][a-z0-9-]{1,40}$/;
const ZONE = "'Europe/Istanbul'";
const UNIT_KEYS = ['aiInputPerMillionKurus', 'aiOutputPerMillionKurus', 'smsSegmentKurus', 'voipMinuteKurus'];
// Which product an estimated usage cost belongs to.
const USAGE_PRODUCT = { ai: 'ai-assistant', voip: 'voip' };
const fail = (status, message) => Object.assign(new Error(message), { status });
const num = (value) => Number(value ?? 0);

async function unitCosts(db) {
  const { rows } = await db.query("SELECT value FROM han_saas.platform_settings WHERE key = 'unit_costs'");
  const saved = rows[0]?.value || {};
  return Object.fromEntries(UNIT_KEYS.map((k) => [k, Number.isSafeInteger(saved[k]) ? saved[k] : 0]));
}

async function saveUnitCosts(pool, adminId, input) {
  const value = {};
  for (const key of UNIT_KEYS) {
    const v = input[key] ?? 0;
    if (!Number.isSafeInteger(v) || v < 0 || v > 100_000_000) throw fail(400, 'Birim maliyet geçersiz.');
    value[key] = v;
  }
  return inTransaction(pool, async (db) => {
    await db.query(
      `INSERT INTO han_saas.platform_settings(key, value, updated_by, updated_at) VALUES ('unit_costs', $1::jsonb, $2, clock_timestamp())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(value), adminId],
    );
    await record(db, adminId, 'settings.unit_costs', null, JSON.stringify(value));
    return value;
  });
}

// --- Recurring expenses -------------------------------------------------------------------

async function addRecurring(pool, adminId, input) {
  if (!CATEGORIES.includes(input.category)) throw fail(400, 'Kategori geçersiz.');
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (description.length < 2 || description.length > 300) throw fail(400, 'Açıklama 2–300 karakter olmalıdır.');
  const vendor = input.vendor ? String(input.vendor).trim().slice(0, 120) || null : null;
  if (!Number.isSafeInteger(input.amountKurus) || input.amountKurus < 1 || input.amountKurus > 1_000_000_000_000)
    throw fail(400, 'Tutar geçersiz.');
  const rate = input.vatRatePercent ?? DEFAULT_VAT_RATE;
  if (!Number.isInteger(rate) || rate < 0 || rate > 100) throw fail(400, 'KDV oranı 0–100 olmalıdır.');
  const day = input.dayOfMonth ?? 1;
  if (!Number.isInteger(day) || day < 1 || day > 28) throw fail(400, 'Ayın günü 1–28 olmalıdır.');
  const date = (v, label) => {
    if (v === undefined || v === null || v === '') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(Date.parse(v))) throw fail(400, `${label} geçersiz.`);
    return String(v);
  };
  const startsOn = date(input.startsOn, 'Başlangıç tarihi');
  if (!startsOn) throw fail(400, 'Başlangıç tarihi geçersiz.');
  const endsOn = date(input.endsOn, 'Bitiş tarihi');
  if (endsOn && endsOn < startsOn) throw fail(400, 'Bitiş başlangıçtan önce olamaz.');
  const tenantId = input.tenantId || null;
  if (tenantId && !UUID.test(tenantId)) throw fail(400, 'Büro geçersiz.');
  const moduleCode = input.moduleCode || null;
  if (moduleCode && !CODE.test(moduleCode)) throw fail(400, 'Ürün geçersiz.');
  return inTransaction(pool, async (db) => {
    const id = randomUUID();
    await db
      .query(
        `INSERT INTO han_saas.recurring_expenses(id, category, description, vendor, amount_kurus, vat_rate, tenant_id,
           module_code, day_of_month, starts_on, ends_on, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [id, input.category, description, vendor, input.amountKurus, rate, tenantId, moduleCode, day, startsOn, endsOn, adminId],
      )
      .catch((error) => {
        if (error.code === '23503') throw fail(400, 'Büro veya ürün bulunamadı.');
        throw error;
      });
    await record(db, adminId, 'recurring.create', id, description);
    await postRecurring(db);
    return { id };
  });
}

async function stopRecurring(pool, adminId, { id }) {
  if (typeof id !== 'string' || !UUID.test(id)) throw fail(404, 'Tekrarlayan gider bulunamadı.');
  return inTransaction(pool, async (db) => {
    const { rows } = await db.query(
      'UPDATE han_saas.recurring_expenses SET active = false WHERE id = $1 AND active RETURNING description',
      [id],
    );
    if (!rows.length) throw fail(409, 'Tekrarlayan gider bulunamadı veya zaten durdurulmuş.');
    await record(db, adminId, 'recurring.stop', id, rows[0].description);
    return { id };
  });
}

async function listRecurring(pool) {
  const { rows } = await pool.query(
    `SELECT r.*, r.starts_on::text AS starts_text, r.ends_on::text AS ends_text, t.name AS tenant_name, m.name AS module_name,
       (SELECT max(period) FROM han_saas.expenses x WHERE x.recurring_id = r.id) AS last_period
     FROM han_saas.recurring_expenses r
     LEFT JOIN han_saas.tenants t ON t.id = r.tenant_id
     LEFT JOIN han_saas.modules m ON m.code = r.module_code
     ORDER BY r.active DESC, r.created_at DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    description: r.description,
    vendor: r.vendor,
    amountKurus: num(r.amount_kurus),
    vatRatePercent: r.vat_rate,
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    moduleCode: r.module_code,
    moduleName: r.module_name,
    dayOfMonth: r.day_of_month,
    startsOn: r.starts_text,
    endsOn: r.ends_text,
    active: r.active,
    lastPeriod: r.last_period,
  }));
}

// Writes the expense row of every month that is due (its day has come, Istanbul time), at
// most 24 months back, once per month. Safe to run any number of times.
async function postRecurring(db) {
  const { rowCount } = await db.query(
    `INSERT INTO han_saas.expenses(id, spent_on, category, description, vendor, amount_kurus, vat_rate, tenant_id,
       module_code, recurring_id, period, created_by)
     SELECT gen_random_uuid(), d.spent_on, r.category, r.description, r.vendor, r.amount_kurus, r.vat_rate, r.tenant_id,
       r.module_code, r.id, to_char(d.spent_on, 'YYYY-MM'), r.created_by
     FROM han_saas.recurring_expenses r
     CROSS JOIN LATERAL (
       SELECT (m + make_interval(days => r.day_of_month - 1))::date AS spent_on
       FROM generate_series(
         greatest(date_trunc('month', r.starts_on::timestamp),
                  date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE ${ZONE}) - interval '23 months'),
         date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE ${ZONE}), interval '1 month') AS m
     ) d
     WHERE r.active AND d.spent_on >= r.starts_on AND (r.ends_on IS NULL OR d.spent_on <= r.ends_on)
       AND d.spent_on <= (CURRENT_TIMESTAMP AT TIME ZONE ${ZONE})::date
     ON CONFLICT (recurring_id, period) WHERE recurring_id IS NOT NULL DO NOTHING`,
  );
  return rowCount ?? 0;
}

// --- Profitability --------------------------------------------------------------------------

async function profitReport(pool, input = {}) {
  return inTransaction(pool, async (db) => {
    await postRecurring(db);
    const { rows: now } = await db.query(`SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE ${ZONE}, 'YYYY-MM') AS month`);
    const to = input.to || now[0].month;
    if (!MONTH.test(to)) throw fail(400, 'Ay geçersiz. Örnek: 2026-11');
    let from = input.from;
    if (!from) {
      const [y, m] = to.split('-').map(Number);
      const start = new Date(Date.UTC(y, m - 12, 1));
      from = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
    }
    if (!MONTH.test(from) || from > to) throw fail(400, 'Ay aralığı geçersiz.');
    const units = await unitCosts(db);
    // [from, to] as Istanbul month starts; $1 inclusive, $2 exclusive.
    const range = [from + '-01', to + '-01'];
    const inRange = (column) =>
      `date_trunc('month', ${column} AT TIME ZONE ${ZONE}) >= $1::date AND date_trunc('month', ${column} AT TIME ZONE ${ZONE}) <= $2::date`;

    // Revenue lines: renewals split by their breakdown, everything else by module_code.
    const { rows: revenue } = await db.query(
      `WITH paid AS (SELECT * FROM han_saas.sales s WHERE s.status = 'paid' AND ${inRange('s.paid_at')}),
       lines AS (
         SELECT p.tenant_id, b->>'code' AS code, (b->>'amount')::bigint AS amount
         FROM paid p CROSS JOIN LATERAL jsonb_array_elements(p.breakdown) b WHERE p.breakdown IS NOT NULL
         UNION ALL
         SELECT p.tenant_id, coalesce(p.module_code, 'users'), p.amount_kurus FROM paid p WHERE p.breakdown IS NULL
       )
       SELECT tenant_id, code, sum(amount)::text AS amount FROM lines GROUP BY tenant_id, code`,
      range,
    );
    const { rows: expenses } = await db.query(
      `SELECT tenant_id, module_code, sum(amount_kurus)::text AS amount FROM han_saas.expenses
       WHERE status = 'active' AND date_trunc('month', spent_on) >= $1::date AND date_trunc('month', spent_on) <= $2::date
       GROUP BY tenant_id, module_code`,
      range,
    );
    const { rows: ai } = await db.query(
      `SELECT tenant_id, metric, sum(quantity)::text AS q FROM han_saas.usage_daily
       WHERE date_trunc('month', day) >= $1::date AND date_trunc('month', day) <= $2::date GROUP BY tenant_id, metric`,
      range,
    );
    const { rows: sms } = await db.query(
      `SELECT tenant_id, sum(segments)::text AS q FROM han_saas.sms_log
       WHERE status = 'sent' AND tenant_id IS NOT NULL AND ${inRange('created_at')} GROUP BY tenant_id`,
      range,
    );
    const { rows: voip } = await db.query(
      `SELECT tenant_id, sum(ceil(least(greatest(coalesce((body->>'duration')::numeric, 0), 0), 86400) / 60))::text AS q
       FROM han_private.voip_calls WHERE ${inRange('created_at')} GROUP BY tenant_id`,
      range,
    );
    const { rows: offices } = await db.query(
      `SELECT t.id, t.name, t.slug, t.status, s.access_until FROM han_saas.tenants t
       LEFT JOIN han_saas.subscriptions s ON s.tenant_id = t.id`,
    );
    const { rows: products } = await db.query('SELECT code, name, kind FROM han_saas.modules');

    // Usage per office, in units and estimated kuruş.
    const usage = new Map();
    const use = (tenant) => {
      if (!usage.has(tenant))
        usage.set(tenant, { aiRequests: 0, aiInputTokens: 0, aiOutputTokens: 0, smsSegments: 0, voipMinutes: 0 });
      return usage.get(tenant);
    };
    for (const r of ai) {
      const key = { ai_requests: 'aiRequests', ai_input_tokens: 'aiInputTokens', ai_output_tokens: 'aiOutputTokens' }[r.metric];
      use(r.tenant_id)[key] += num(r.q);
    }
    for (const r of sms) use(r.tenant_id).smsSegments += num(r.q);
    for (const r of voip) if (r.tenant_id) use(r.tenant_id).voipMinutes += num(r.q);
    const costOf = (u) => {
      const aiCost = Math.round(
        (u.aiInputTokens * units.aiInputPerMillionKurus + u.aiOutputTokens * units.aiOutputPerMillionKurus) / 1_000_000,
      );
      return {
        ai: aiCost,
        sms: u.smsSegments * units.smsSegmentKurus,
        voip: u.voipMinutes * units.voipMinuteKurus,
      };
    };

    // Per office.
    const officeRows = new Map(
      offices.map((o) => [
        o.id,
        { tenantId: o.id, name: o.name, slug: o.slug, status: o.status, accessUntil: o.access_until, revenueKurus: 0, expenseKurus: 0 },
      ]),
    );
    for (const r of revenue) if (officeRows.has(r.tenant_id)) officeRows.get(r.tenant_id).revenueKurus += num(r.amount);
    for (const r of expenses) if (r.tenant_id && officeRows.has(r.tenant_id)) officeRows.get(r.tenant_id).expenseKurus += num(r.amount);
    const officeList = [...officeRows.values()].map((o) => {
      const u = usage.get(o.tenantId) || { aiRequests: 0, aiInputTokens: 0, aiOutputTokens: 0, smsSegments: 0, voipMinutes: 0 };
      const c = costOf(u);
      const usageKurus = c.ai + c.sms + c.voip;
      const profit = o.revenueKurus - o.expenseKurus - usageKurus;
      return {
        ...o,
        usage: u,
        usageCostKurus: usageKurus,
        usageCost: c,
        profitKurus: profit,
        marginPercent: o.revenueKurus > 0 ? Math.round((profit / o.revenueKurus) * 100) : null,
      };
    });
    officeList.sort((a, b) => a.profitKurus - b.profitKurus);

    // Per product.
    const productRows = new Map([
      ['users', { code: 'users', name: 'Kullanıcı lisansı ve genel', kind: 'users', revenueKurus: 0, expenseKurus: 0, usageCostKurus: 0 }],
      ...products.map((p) => [p.code, { code: p.code, name: p.name, kind: p.kind, revenueKurus: 0, expenseKurus: 0, usageCostKurus: 0 }]),
    ]);
    const product = (code) => productRows.get(productRows.has(code) ? code : 'users');
    for (const r of revenue) product(r.code).revenueKurus += num(r.amount);
    for (const r of expenses) if (r.module_code) product(r.module_code).expenseKurus += num(r.amount);
    let smsUsage = 0;
    for (const o of officeList) {
      if (productRows.has(USAGE_PRODUCT.ai)) productRows.get(USAGE_PRODUCT.ai).usageCostKurus += o.usageCost.ai;
      if (productRows.has(USAGE_PRODUCT.voip)) productRows.get(USAGE_PRODUCT.voip).usageCostKurus += o.usageCost.voip;
      smsUsage += o.usageCost.sms;
    }
    const productList = [...productRows.values()]
      .map((p) => {
        const profit = p.revenueKurus - p.expenseKurus - p.usageCostKurus;
        return { ...p, profitKurus: profit, marginPercent: p.revenueKurus > 0 ? Math.round((profit / p.revenueKurus) * 100) : null };
      })
      .filter((p) => p.revenueKurus || p.expenseKurus || p.usageCostKurus || p.code === 'users');

    // Indicators.
    const { rows: k } = await db.query(
      `SELECT
         count(*) FILTER (WHERE t.status = 'enabled' AND s.access_until > CURRENT_TIMESTAMP)::int AS active,
         count(*) FILTER (WHERE t.status = 'enabled' AND s.access_until <= CURRENT_TIMESTAMP)::int AS expired,
         count(*) FILTER (WHERE t.status IN ('suspended', 'closed'))::int AS lost,
         count(*) FILTER (WHERE t.status = 'enabled'
           AND date_trunc('month', s.access_until AT TIME ZONE ${ZONE}) = date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE ${ZONE}))::int AS renew_this_month,
         coalesce(sum(s.seat_limit * s.user_price_kurus) FILTER (WHERE t.status = 'enabled' AND s.access_until > CURRENT_TIMESTAMP), 0)::text AS users_mrr,
         coalesce(sum((SELECT sum(tm.price_kurus) FROM han_saas.tenant_modules tm WHERE tm.tenant_id = t.id AND tm.status = 'active'))
           FILTER (WHERE t.status = 'enabled' AND s.access_until > CURRENT_TIMESTAMP), 0)::text AS modules_mrr
       FROM han_saas.tenants t JOIN han_saas.subscriptions s ON s.tenant_id = t.id
       WHERE t.id <> $1`,
      [LEGACY_TENANT_ID],
    );
    const { rows: reach } = await db.query(
      `SELECT m.code, m.name, count(tm.tenant_id) FILTER (WHERE tm.status = 'active')::int AS offices
       FROM han_saas.modules m LEFT JOIN han_saas.tenant_modules tm ON tm.module_code = m.code
       WHERE m.kind = 'module' AND m.status IN ('selling', 'soon', 'retired') GROUP BY m.code, m.name ORDER BY m.name`,
    );
    const active = k[0].active;
    const mrr = num(k[0].users_mrr) + num(k[0].modules_mrr);
    const totals = {
      revenueKurus: productList.reduce((s, p) => s + p.revenueKurus, 0),
      linkedExpenseKurus: productList.reduce((s, p) => s + p.expenseKurus, 0),
      usageCostKurus: officeList.reduce((s, o) => s + o.usageCostKurus, 0),
      smsUsageCostKurus: smsUsage,
    };
    return {
      from,
      to,
      unitCosts: units,
      totals,
      products: productList,
      offices: officeList,
      indicators: {
        activeOffices: active,
        expiredOffices: k[0].expired,
        lostOffices: k[0].lost,
        churnPercent: active + k[0].expired + k[0].lost ? Math.round(((k[0].expired + k[0].lost) / (active + k[0].expired + k[0].lost)) * 100) : null,
        renewalsThisMonth: k[0].renew_this_month,
        mrrKurus: mrr,
        arpuKurus: active ? Math.round(mrr / active) : null,
        reach: reach.map((r) => ({ code: r.code, name: r.name, offices: r.offices, percent: active ? Math.round((r.offices / active) * 100) : null })),
      },
    };
  });
}

module.exports = {
  UNIT_KEYS,
  unitCosts: (pool) => unitCosts(pool),
  saveUnitCosts,
  addRecurring,
  stopRecurring,
  listRecurring,
  postRecurring,
  // Writes due recurring expenses; the finance pages call it before reading.
  postRecurringNow: (pool) => inTransaction(pool, (db) => postRecurring(db)),
  profitReport,
};
