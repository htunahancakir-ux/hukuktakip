const service = require('../../lib/external-out.cjs');
const { assertModuleAction } = require('../../lib/module-permissions.cjs');
async function handleExternalOut(ctx) {
  const { url, req, res, u, send, fail, body, allowed, options, ledgerBalance, persist } = ctx;
  if (!url.pathname.startsWith('/api/external-out')) return false;
  const mayRequest =
    allowed(u, 'cashOut') &&
    !u.readOnly &&
    (u.role === 'ceo' || u.modulePermissions?.accounting?.create !== false);
  if (req.method === 'GET' && url.pathname === '/api/external-out') {
    if (u.role !== 'ceo' && !allowed(u, 'cashOut'))
      throw fail(403, 'Harici çıkış taleplerini görme yetkiniz yok.');
    const offset = Number(url.searchParams.get('offset') || 0),
      status = url.searchParams.get('status') || '';
    if (!Number.isInteger(offset) || offset < 0 || !['', 'pending', 'approved', 'rejected'].includes(status))
      throw fail(400, 'Geçersiz talep filtresi.');
    const rows = service
      .requests(ctx.state)
      .filter((r) => (u.role === 'ceo' || r.requestedBy === u.id) && (!status || r.status === status))
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const accounts = ctx.state.data['hanhukuk-accounting-v1'].accounts;
    send(res, 200, {
      items: rows.slice(offset, offset + 50).map((r) => ({
        ...r,
        accountName: accounts.find((a) => a.id === r.accountId)?.name || 'Hesap bulunamadı',
        currentAccountName:
          ctx.state.currentAccountParties?.find((p) => p.id === r.currentAccountId)?.name || '',
      })),
      count: rows.length,
      more: offset + 50 < rows.length,
      mayRequest,
    });
    return true;
  }
  if (req.method !== 'POST') throw fail(405, 'İşlem desteklenmiyor.');
  if (u.readOnly) throw fail(403, 'Bu hesap salt okunur.');
  const input = await body(req);
  let result;
  if (url.pathname === '/api/external-out/request') {
    if (!mayRequest) throw fail(403, 'Harici çıkış talep etme yetkiniz yok.');
    assertModuleAction(u, 'accounting', 'create');
    result = service.request(ctx.state, input, u);
  } else if (url.pathname === '/api/external-out/decide') {
    result = service.decide(ctx.state, input, u, options.cashAccountBalances, ledgerBalance);
  } else throw fail(404, 'İşlem bulunamadı.');
  if (result.next) persist(result.next);
  send(res, 200, { ok: true, request: result.request });
  return true;
}
module.exports = { handleExternalOut };
