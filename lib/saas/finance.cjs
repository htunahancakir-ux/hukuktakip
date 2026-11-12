const { randomUUID } = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');
const { VAT_SQL, DEFAULT_VAT_RATE } = require('./platform.cjs');

// Platform finance: monthly KDV report for sales, the expense ledger (advertising, servers,
// AI usage …) and the profit summary built from both. All amounts are integer kuruş, KDV
// exclusive unless a field says "gross"/"Dahil"; KDV is derived per ledger row (see
// platform.cjs). Sales are counted in the month they are COLLECTED (cash basis, like the
// revenue figures); an invoice-date basis needs invoicing in the system and is not claimed.

const CATEGORIES = ['advertising', 'marketing', 'server', 'ai', 'telephony', 'software', 'personnel', 'other'];
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ZONE = "'Europe/Istanbul'";
const EXPENSE_VAT_SQL = 'round(x.amount_kurus::numeric * x.vat_rate / 100)::bigint';
const fail = (status, message) => Object.assign(new Error(message), { status });
const num = (value) => Number(value ?? 0);

function whole(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw fail(400, `${label} ${min}–${max} arasında olmalıdır.`);
  return value;
}
function text(value, label, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max)
    throw fail(400, `${label} ${min}–${max} karakter olmalıdır.`);
  return value.trim();
}
function optional(value, label, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max) throw fail(400, `${label} çok uzun.`);
  return value.trim();
}
function validDate(value) {
  const m = DATE.exec(String(value));
  if (!m) throw fail(400, 'Tarih geçersiz.');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || y < 2020)
    throw fail(400, 'Tarih geçersiz.');
  return value;
}
async function resolveMonth(db, value) {
  if (value !== undefined && value !== null && value !== '') {
    if (typeof value !== 'string' || !MONTH.test(value)) throw fail(400, 'Ay geçersiz. Örnek: 2026-11');
    return value;
  }
  const { rows } = await db.query(`SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE ${ZONE}, 'YYYY-MM') AS month`);
  return rows[0].month;
}

async function addExpense(pool, adminId, input) {
  const spentOn = validDate(input.spentOn);
  if (!CATEGORIES.includes(input.category)) throw fail(400, 'Kategori geçersiz.');
  const description = text(input.description, 'Açıklama', 2, 300);
  const vendor = optional(input.vendor, 'Tedarikçi', 120);
  const invoiceNo = optional(input.invoiceNo, 'Fatura no', 60);
  if (!Number.isSafeInteger(input.amountKurus) || input.amountKurus < 1 || input.amountKurus > 1_000_000_000_000)
    throw fail(400, 'Tutar geçersiz.');
  const rate = input.vatRatePercent === undefined ? DEFAULT_VAT_RATE : whole(input.vatRatePercent, 'KDV oranı', 0, 100);
  const tenantId = input.tenantId === undefined || input.tenantId === null || input.tenantId === '' ? null : input.tenantId;
  if (tenantId !== null && (typeof tenantId !== 'string' || !UUID.test(tenantId))) throw fail(404, 'Büro bulunamadı.');
  // Optional: the product this cost belongs to (for per-product profit).
  const moduleCode = input.moduleCode ? String(input.moduleCode) : null;
  if (moduleCode && !/^[a-z][a-z0-9-]{1,40}$/.test(moduleCode)) throw fail(400, 'Ürün geçersiz.');
  return inTransaction(pool, async (db) => {
    const { rows: today } = await db.query(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE ${ZONE})::date::text AS today`);
    if (spentOn > today[0].today) throw fail(400, 'Gider tarihi gelecekte olamaz.');
    if (tenantId) {
      const office = await db.query('SELECT 1 FROM han_saas.tenants WHERE id = $1', [tenantId]);
      if (!office.rows.length) throw fail(404, 'Büro bulunamadı.');
    }
    if (moduleCode) {
      const product = await db.query('SELECT 1 FROM han_saas.modules WHERE code = $1', [moduleCode]);
      if (!product.rows.length) throw fail(404, 'Ürün bulunamadı.');
    }
    const id = randomUUID();
    await db.query(
      `INSERT INTO han_saas.expenses(id, spent_on, category, description, vendor, amount_kurus, vat_rate, tenant_id,
         invoice_no, created_by, module_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, spentOn, input.category, description, vendor, input.amountKurus, rate, tenantId, invoiceNo, adminId, moduleCode],
    );
    return { id };
  });
}

async function voidExpense(pool, adminId, input) {
  if (typeof input.expenseId !== 'string' || !UUID.test(input.expenseId)) throw fail(404, 'Gider bulunamadı.');
  const reason = text(input.reason, 'Gerekçe', 3, 300);
  void adminId;
  const { rows } = await pool.query(
    `UPDATE han_saas.expenses SET status = 'void', voided_at = CURRENT_TIMESTAMP, void_reason = $2
     WHERE id = $1 AND status = 'active' RETURNING id`,
    [input.expenseId, reason],
  );
  if (!rows.length) throw fail(409, 'Gider bulunamadı veya zaten iptal edilmiş.');
  return { expenseId: rows[0].id };
}

const sums = (r) => ({ netKurus: num(r.net), vatKurus: num(r.vat), grossKurus: num(r.net) + num(r.vat), count: r.count ?? 0 });

// Sales of one month with KDV per row and the month-end totals. Collected sales are the
// month's KDV base; pending sales are listed and totalled separately; voided ones are shown
// but counted nowhere.
async function salesReport(pool, input = {}) {
  return inTransaction(
    pool,
    async (db) => {
      const month = await resolveMonth(db, input.month);
      const window = `(coalesce(s.paid_at, s.created_at) AT TIME ZONE ${ZONE}) >= to_date($1 || '-01', 'YYYY-MM-DD')::timestamp
        AND (coalesce(s.paid_at, s.created_at) AT TIME ZONE ${ZONE}) < to_date($1 || '-01', 'YYYY-MM-DD')::timestamp + interval '1 month'`;
      const sales = (
        await db.query(
          `SELECT s.id, s.tenant_id, t.name AS tenant_name, s.kind, s.description, s.status, s.invoice_no,
                  s.amount_kurus::text AS net, s.vat_rate, ${VAT_SQL}::text AS vat, s.created_at, s.paid_at
           FROM han_saas.sales s JOIN han_saas.tenants t ON t.id = s.tenant_id
           WHERE ${window} ORDER BY coalesce(s.paid_at, s.created_at) DESC, s.id LIMIT 2000`,
          [month],
        )
      ).rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        kind: r.kind,
        description: r.description,
        status: r.status,
        invoiceNo: r.invoice_no,
        amountKurus: num(r.net),
        vatRatePercent: r.vat_rate,
        vatKurus: num(r.vat),
        grossKurus: num(r.net) + num(r.vat),
        createdAt: r.created_at,
        paidAt: r.paid_at,
      }));
      const totalFor = async (status) =>
        sums(
          (
            await db.query(
              `SELECT coalesce(sum(s.amount_kurus), 0)::text AS net, coalesce(sum(${VAT_SQL}), 0)::text AS vat,
                      count(*)::int AS count FROM han_saas.sales s WHERE s.status = $2 AND ${window}`,
              [month, status],
            )
          ).rows[0],
        );
      const byRate = (
        await db.query(
          `SELECT s.vat_rate, sum(s.amount_kurus)::text AS net, sum(${VAT_SQL})::text AS vat
           FROM han_saas.sales s WHERE s.status = 'paid' AND ${window} GROUP BY s.vat_rate ORDER BY s.vat_rate`,
          [month],
        )
      ).rows.map((r) => ({ ratePercent: r.vat_rate, ...sums(r) }));
      return { month, sales, collected: await totalFor('paid'), pending: await totalFor('pending'), byRate };
    },
    { readOnly: true },
  );
}

async function expensesReport(pool, input = {}) {
  return inTransaction(
    pool,
    async (db) => {
      const month = await resolveMonth(db, input.month);
      const window = `x.spent_on >= to_date($1 || '-01', 'YYYY-MM-DD') AND x.spent_on < (to_date($1 || '-01', 'YYYY-MM-DD') + interval '1 month')::date`;
      const expenses = (
        await db.query(
          `SELECT x.id, x.spent_on::text AS spent_on, x.category, x.description, x.vendor, x.invoice_no, x.status,
                  x.tenant_id, t.name AS tenant_name, x.amount_kurus::text AS net, x.vat_rate, ${EXPENSE_VAT_SQL}::text AS vat,
                  x.void_reason, x.module_code, m.name AS module_name, x.recurring_id
           FROM han_saas.expenses x LEFT JOIN han_saas.tenants t ON t.id = x.tenant_id
           LEFT JOIN han_saas.modules m ON m.code = x.module_code
           WHERE ${window} ORDER BY x.spent_on DESC, x.created_at DESC LIMIT 2000`,
          [month],
        )
      ).rows.map((r) => ({
        id: r.id,
        spentOn: r.spent_on,
        category: r.category,
        description: r.description,
        vendor: r.vendor,
        invoiceNo: r.invoice_no,
        status: r.status,
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        amountKurus: num(r.net),
        vatRatePercent: r.vat_rate,
        vatKurus: num(r.vat),
        grossKurus: num(r.net) + num(r.vat),
        voidReason: r.void_reason,
        moduleCode: r.module_code,
        moduleName: r.module_name,
        recurring: !!r.recurring_id,
      }));
      const byCategory = (
        await db.query(
          `SELECT x.category, sum(x.amount_kurus)::text AS net, sum(${EXPENSE_VAT_SQL})::text AS vat, count(*)::int AS count
           FROM han_saas.expenses x WHERE x.status = 'active' AND ${window} GROUP BY x.category ORDER BY x.category`,
          [month],
        )
      ).rows.map((r) => ({ category: r.category, ...sums(r) }));
      const total = byCategory.reduce(
        (acc, c) => ({ netKurus: acc.netKurus + c.netKurus, vatKurus: acc.vatKurus + c.vatKurus, grossKurus: acc.grossKurus + c.grossKurus, count: acc.count + c.count }),
        { netKurus: 0, vatKurus: 0, grossKurus: 0, count: 0 },
      );
      return { month, expenses, byCategory, total };
    },
    { readOnly: true },
  );
}

// Twelve months of income, cost, profit and KDV. "Acquisition cost" is advertising plus
// marketing spend divided by the offices sold that month (cost to win one office).
async function financeSummary(pool) {
  return inTransaction(
    pool,
    async (db) => {
      const { rows } = await db.query(
        `WITH m AS (SELECT generate_series(
             date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE ${ZONE}) - interval '11 months',
             date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE ${ZONE}), interval '1 month') AS month)
         SELECT to_char(m.month, 'YYYY-MM') AS month,
           (SELECT coalesce(sum(s.amount_kurus), 0) FROM han_saas.sales s WHERE s.status = 'paid'
              AND date_trunc('month', s.paid_at AT TIME ZONE ${ZONE}) = m.month)::text AS sales_net,
           (SELECT coalesce(sum(${VAT_SQL}), 0) FROM han_saas.sales s WHERE s.status = 'paid'
              AND date_trunc('month', s.paid_at AT TIME ZONE ${ZONE}) = m.month)::text AS sales_vat,
           (SELECT coalesce(sum(x.amount_kurus), 0) FROM han_saas.expenses x WHERE x.status = 'active'
              AND date_trunc('month', x.spent_on) = m.month)::text AS cost_net,
           (SELECT coalesce(sum(${EXPENSE_VAT_SQL}), 0) FROM han_saas.expenses x WHERE x.status = 'active'
              AND date_trunc('month', x.spent_on) = m.month)::text AS cost_vat,
           (SELECT coalesce(sum(x.amount_kurus), 0) FROM han_saas.expenses x WHERE x.status = 'active'
              AND x.category IN ('advertising', 'marketing') AND date_trunc('month', x.spent_on) = m.month)::text AS acquisition,
           (SELECT count(*)::int FROM han_saas.sales s WHERE s.kind = 'new_office' AND s.status <> 'void'
              AND date_trunc('month', s.created_at AT TIME ZONE ${ZONE}) = m.month) AS new_offices
         FROM m ORDER BY m.month`,
      );
      const months = rows.map((r) => {
        const salesNet = num(r.sales_net);
        const salesVat = num(r.sales_vat);
        const costNet = num(r.cost_net);
        const costVat = num(r.cost_vat);
        return {
          month: r.month,
          salesNetKurus: salesNet,
          salesVatKurus: salesVat,
          salesGrossKurus: salesNet + salesVat,
          costNetKurus: costNet,
          costVatKurus: costVat,
          costGrossKurus: costNet + costVat,
          profitKurus: salesNet - costNet,
          vatPayableKurus: salesVat - costVat,
          acquisitionKurus: num(r.acquisition),
          newOffices: r.new_offices,
          costPerNewOfficeKurus: r.new_offices > 0 ? Math.round(num(r.acquisition) / r.new_offices) : null,
        };
      });
      const sum = (key) => months.reduce((total, m) => total + m[key], 0);
      return {
        months,
        totals: {
          salesNetKurus: sum('salesNetKurus'),
          salesVatKurus: sum('salesVatKurus'),
          salesGrossKurus: sum('salesGrossKurus'),
          costNetKurus: sum('costNetKurus'),
          costVatKurus: sum('costVatKurus'),
          profitKurus: sum('profitKurus'),
          vatPayableKurus: sum('vatPayableKurus'),
        },
      };
    },
    { readOnly: true },
  );
}

module.exports = { CATEGORIES, addExpense, voidExpense, salesReport, expensesReport, financeSummary };
