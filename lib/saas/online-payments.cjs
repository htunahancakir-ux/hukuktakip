const { randomUUID } = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');
const { VAT_SQL } = require('./platform.cjs');

// Online collection of an office's pending sales with iyzico's Checkout Form. The operator
// creates a link for the office's pending ledger rows; the customer pays on iyzico's page;
// iyzico sends the browser to our callback with a token, and the result is read back from
// iyzico by token and verified (signature, amount, conversation id) before anything is
// marked paid. The browser redirect itself is never trusted.

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (status, message) => Object.assign(new Error(message), { status });
const num = (value) => Number(value ?? 0);

function text(value, label, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max)
    throw fail(400, `${label} ${min}–${max} karakter olmalıdır.`);
  return value.trim();
}
function buyerFrom(input, tenantId) {
  const b = input && typeof input === 'object' ? input : {};
  const email = text(b.email, 'E-posta', 5, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'E-posta geçersiz.');
  const identity = b.identityNumber === undefined || b.identityNumber === '' ? undefined : String(b.identityNumber).trim();
  if (identity !== undefined && !/^\d{10,11}$/.test(identity)) throw fail(400, 'TC kimlik veya vergi numarası 10–11 haneli olmalıdır.');
  const phone = b.gsmNumber === undefined || b.gsmNumber === '' ? undefined : String(b.gsmNumber).trim();
  if (phone !== undefined && !/^\+?\d{10,14}$/.test(phone)) throw fail(400, 'Telefon geçersiz.');
  return {
    id: tenantId,
    name: text(b.name, 'Ad', 1, 60),
    surname: text(b.surname, 'Soyad', 1, 60),
    email,
    identityNumber: identity,
    gsmNumber: phone,
    address: text(b.address, 'Adres', 5, 200),
    city: text(b.city, 'Şehir', 2, 60),
  };
}

// `iyzico` is a client from lib/iyzico.cjs; `callbackUrl` is where iyzico sends the browser.
async function createPaymentLink(pool, adminId, input, { iyzico, callbackUrl, clientIp }) {
  if (!iyzico) throw fail(412, 'Online ödeme henüz yapılandırılmadı (IYZICO_API_KEY ve IYZICO_SECRET_KEY).');
  if (typeof input.tenantId !== 'string' || !UUID.test(input.tenantId)) throw fail(404, 'Büro bulunamadı.');
  const tenantId = input.tenantId;
  const buyer = buyerFrom(input.buyer, tenantId);
  const payment = await inTransaction(pool, async (db) => {
    const office = await db.query('SELECT name, status FROM han_saas.tenants WHERE id = $1 FOR UPDATE', [tenantId]);
    if (!office.rows.length) throw fail(404, 'Büro bulunamadı.');
    if (office.rows[0].status === 'closed') throw fail(409, 'Kapatılmış büro için ödeme alınamaz.');
    const { rows } = await db.query(
      `SELECT s.id, s.amount_kurus::text AS net, ${VAT_SQL}::text AS vat
       FROM han_saas.sales s WHERE s.tenant_id = $1 AND s.status = 'pending' ORDER BY s.created_at, s.id FOR UPDATE`,
      [tenantId],
    );
    if (!rows.length) throw fail(409, 'Bu büronun bekleyen satışı yok.');
    if (rows.length > 100) throw fail(409, 'Bekleyen satış sayısı çok fazla; önce bir kısmını tahsil edin.');
    const amount = rows.reduce((sum, r) => sum + num(r.net) + num(r.vat), 0);
    if (amount < 100) throw fail(409, 'Bekleyen tutar çevrimiçi ödeme için çok düşük (en az 1,00 TL).');
    // Only the newest link can complete; older open ones are retired so one debt is not collected twice.
    await db.query("UPDATE han_saas.online_payments SET status = 'superseded' WHERE tenant_id = $1 AND status = 'initiated'", [tenantId]);
    const id = randomUUID();
    await db.query(
      'INSERT INTO han_saas.online_payments(id, tenant_id, amount_kurus, sale_ids, created_by) VALUES ($1, $2, $3, $4::uuid[], $5)',
      [id, tenantId, amount, rows.map((r) => r.id), adminId],
    );
    return { id, amount, officeName: office.rows[0].name };
  });
  try {
    const checkout = await iyzico.initializeCheckout({
      conversationId: payment.id,
      basketId: payment.id,
      amountKurus: payment.amount,
      description: `Hukuk Takip Platformu abonelik: ${payment.officeName}`.slice(0, 120),
      callbackUrl,
      buyer,
      ip: clientIp,
    });
    await pool.query('UPDATE han_saas.online_payments SET token = $2, payment_url = $3 WHERE id = $1', [payment.id, checkout.token, checkout.paymentPageUrl]);
    return { paymentId: payment.id, amountKurus: payment.amount, url: checkout.paymentPageUrl };
  } catch (error) {
    await pool.query("UPDATE han_saas.online_payments SET status = 'failed', note = $2 WHERE id = $1 AND status = 'initiated'", [
      payment.id,
      String(error.message).slice(0, 300),
    ]);
    throw error;
  }
}

// Called when iyzico sends the browser back. Idempotent: a second callback for the same token
// returns the stored outcome without touching the ledger again.
async function completePayment(pool, token, { iyzico }) {
  if (!iyzico) throw fail(503, 'Online ödeme yapılandırılmadı.');
  if (typeof token !== 'string' || token.length < 8 || token.length > 200) throw fail(404, 'Ödeme bulunamadı.');
  const { rows } = await pool.query('SELECT id, status, amount_kurus::text AS amount FROM han_saas.online_payments WHERE token = $1', [token]);
  if (!rows.length) throw fail(404, 'Ödeme bulunamadı.');
  const payment = { id: rows[0].id, status: rows[0].status, amountKurus: num(rows[0].amount) };
  // A superseded link can still be paid by a customer who kept the old page: that money must be seen.
  if (!['initiated', 'superseded'].includes(payment.status)) return { status: payment.status };

  const result = await iyzico.retrieveCheckout(token, payment.id);
  if (!result.paid) {
    const failedPayment = result.paymentStatus === 'FAILURE' && payment.status === 'initiated';
    if (failedPayment)
      await pool.query("UPDATE han_saas.online_payments SET status = 'failed', note = 'Ödeme başarısız (iyzico).' WHERE id = $1 AND status = 'initiated'", [payment.id]);
    return { status: failedPayment ? 'failed' : 'initiated' };
  }
  const exact = result.conversationId === payment.id && result.basketId === payment.id && result.currency === 'TRY' && result.paidKurus === payment.amountKurus;
  return inTransaction(pool, async (db) => {
    const { rows: locked } = await db.query('SELECT status, sale_ids, created_by, tenant_id FROM han_saas.online_payments WHERE id = $1 FOR UPDATE', [payment.id]);
    if (!['initiated', 'superseded'].includes(locked[0].status)) return { status: locked[0].status };
    const park = async (note) => {
      await db.query("UPDATE han_saas.online_payments SET status = 'review', note = $2, provider_payment_id = $3, completed_at = CURRENT_TIMESTAMP WHERE id = $1", [payment.id, note, result.paymentId]);
      await db.query('INSERT INTO han_saas.tenant_events(tenant_id, admin_id, action, detail) VALUES ($1, $2, $3, $4::jsonb)', [locked[0].tenant_id, locked[0].created_by, 'online_payment_review', JSON.stringify({ paymentId: payment.id, note })]);
      return { status: 'review' };
    };
    if (locked[0].status === 'superseded') return park('Yenisiyle değiştirilen eski bir linkle ödeme alındı; iyzico panelinden kontrol edin, gerekirse iade edin.');
    if (!exact) return park('Tahsil edilen tutar veya kayıt beklenenle eşleşmedi; iyzico panelinden kontrol edin.');
    const pending = await db.query(
      "SELECT count(*)::int AS n FROM han_saas.sales WHERE id = ANY($1::uuid[]) AND status = 'pending' AND tenant_id = $2",
      [locked[0].sale_ids, locked[0].tenant_id],
    );
    if (pending.rows[0].n !== locked[0].sale_ids.length) return park('Ödeme alındı ancak satış kayıtları bu arada değişmişti; elle kontrol edip gerekirse iade edin.');
    await db.query(
      "UPDATE han_saas.sales SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ANY($1::uuid[]) AND status = 'pending'",
      [locked[0].sale_ids],
    );
    await db.query("UPDATE han_saas.online_payments SET status = 'paid', provider_payment_id = $2, completed_at = CURRENT_TIMESTAMP WHERE id = $1", [payment.id, result.paymentId]);
    await db.query('INSERT INTO han_saas.tenant_events(tenant_id, admin_id, action, detail) VALUES ($1, $2, $3, $4::jsonb)', [
      locked[0].tenant_id,
      locked[0].created_by,
      'online_payment',
      JSON.stringify({ paymentId: payment.id, amount: payment.amountKurus, sales: locked[0].sale_ids.length }),
    ]);
    return { status: 'paid' };
  });
}

async function listPayments(pool, tenantId) {
  const { rows } = await pool.query(
    `SELECT id, status, amount_kurus::text AS amount, payment_url, note, created_at, completed_at
     FROM han_saas.online_payments WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [tenantId],
  );
  return rows.map((r) => ({ id: r.id, status: r.status, amountKurus: num(r.amount), url: r.status === 'initiated' ? r.payment_url : null, note: r.note, createdAt: r.created_at, completedAt: r.completed_at }));
}

module.exports = { createPaymentLink, completePayment, listPayments };
