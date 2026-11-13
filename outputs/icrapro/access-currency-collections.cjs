const units = require('./receivable-units.js');
const ledger = require('../../lib/currency-collection.cjs');
const rates = require('../../lib/collection-rates.cjs');
const { businessDate, validDate } = require('../../lib/business-time.cjs');
async function handleCurrencyCollections(ctx) {
  const { url, req, u, allowed, fail, send, res, body, persist } = ctx;
  if (
    ![
      '/api/documents/currency-finance',
      '/api/documents/currency-quote',
      '/api/documents/currency-collection',
      '/api/documents/currency-report',
      '/api/documents/currency-terms',
    ].includes(url.pathname)
  )
    return false;
  if (!allowed(u, 'documents')) throw fail(403, 'Dosya hesabına erişim yetkiniz yok.');
  if (url.pathname === '/api/documents/currency-report') {
    if (req.method !== 'GET') throw fail(405, 'Bu işlem yöntemi desteklenmiyor.');
    if (!['ceo', 'admin'].includes(u.role)) throw fail(403, 'Yönetici yetkisi gerekli.');
    send(res, 200, ledger.report(ctx.state, Object.fromEntries(url.searchParams)));
    return true;
  }
  if (
    req.method === 'GET' &&
    ['/api/documents/currency-finance', '/api/documents/currency-quote'].includes(url.pathname)
  ) {
    const doc = ctx.state.data['icrapro-v1'].docs.find((d) => d.id === url.searchParams.get('documentId'));
    if (!doc) throw fail(404, 'Dosya bulunamadı.');
    const date = url.searchParams.get('date') || businessDate();
    if (!validDate(date) || date > businessDate()) throw fail(400, 'Geçerli bir işlem tarihi seçin.');
    const result = ledger.summary(ctx.state, doc, date);
    if (url.pathname.endsWith('currency-quote')) {
      const unit = units.currency(url.searchParams.get('currency'));
      if (!result.groups.some((g) => g.currency === unit))
        throw fail(400, 'Seçilen birimde alacak bulunamadı.');
      result.quote = await rates.quote(unit, date);
    }
    send(res, 200, result);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/documents/currency-collection') {
    const input = await body(req),
      old = ctx.state.data['hanhukuk-finance-v1'].find((e) => e.id === input.requestId);
    const quote = old ? null : await rates.quote(input.currency, input.date);
    const next = ledger.append(ctx.state, input, u, quote);
    if (next) persist(next);
    const doc = ctx.state.data['icrapro-v1'].docs.find((d) => d.id === input.documentId);
    const fields = ['id', 'status', 'closedDate', 'unitTerms', 'unitPrincipalCostTLMinor'];
    send(res, 200, {
      ok: true,
      ...ledger.summary(ctx.state, doc),
      record: Object.fromEntries(fields.filter((k) => Object.hasOwn(doc, k)).map((k) => [k, doc[k]])),
      payment: ctx.state.data['hanhukuk-finance-v1'].find((e) => e.id === input.requestId),
    });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/documents/currency-terms') {
    const input = await body(req),
      next = ledger.updateTerms(ctx.state, input, u);
    if (next) persist(next);
    const doc = ctx.state.data['icrapro-v1'].docs.find((d) => d.id === input.documentId);
    send(res, 200, {
      ok: true,
      ...ledger.summary(ctx.state, doc),
      record: {
        id: doc.id,
        status: doc.status,
        closedDate: doc.closedDate,
        unitTerms: doc.unitTerms,
        unitTermsHistory: doc.unitTermsHistory,
        unitPrincipalCostTLMinor: doc.unitPrincipalCostTLMinor,
      },
    });
    return true;
  }
  throw fail(405, 'Bu işlem yöntemi desteklenmiyor.');
}
module.exports = { handleCurrencyCollections };
