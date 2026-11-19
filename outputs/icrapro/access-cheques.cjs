const service = require('../../lib/cheques.cjs');
const { accountingAllowed } = require('../../lib/accounting-access.cjs');
async function handleCheques(ctx) {
  const { url, req, res, u, send, fail, body, persist, allowed } = ctx;
  if (url.pathname !== '/api/cheques') return false;
  if (!accountingAllowed(u, ctx.state.data['icrapro-personnel-v1']))
    throw fail(403, 'Çek işlemleri için muhasebe yetkisi gerekli.');
  if (req.method === 'GET') {
    send(res, 200, service.list(ctx.state, Object.fromEntries(url.searchParams)));
    return true;
  }
  if (req.method !== 'POST') throw fail(405, 'İşlem desteklenmiyor.');
  if (u.readOnly) throw fail(403, 'Bu hesap salt okunur.');
  require('../../lib/module-permissions.cjs').assertModuleAction(u, 'accounting', 'create');
  const input = await body(req);
  if (!allowed(u, input.direction === 'received' ? 'cashIn' : 'cashOut'))
    throw fail(403, 'Çek para hareketi için yetkiniz yok.');
  const result = service.create(ctx.state, input, u);
  if (result.next) persist(result.next);
  send(res, 200, { ok: true, cheque: result.cheque, pendingApproval: result.cheque.direction === 'issued' });
  return true;
}
module.exports = { handleCheques };
