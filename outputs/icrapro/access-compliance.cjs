const conflictCheck = require('../../lib/conflict-check.cjs');

// KVKK and conflict-of-interest routes. Each write only leaves an audit entry, which
// lib/audit.cjs takes from res.hanAuditEvents in the same transaction as the request.
async function handleComplianceRoutes(ctx) {
  const { req, res, url, u, fail, body, send } = ctx;
  if (url.pathname === '/api/conflicts' && req.method === 'GET') {
    send(res, 200, conflictCheck.fromState(ctx.state, Object.fromEntries(url.searchParams), u));
    return true;
  }
  if (url.pathname === '/api/conflicts/ack' && req.method === 'POST') {
    // The user saw the conflict warning and chose to continue, giving a reason.
    const ack = conflictCheck.acknowledgement(await body(req));
    res.hanAuditEvents = [
      {
        action: 'conflict',
        area: 'Çakışma Kontrolü',
        ref: ack.name,
        fields: [
          { client: 'Müvekkil', debtor: 'Borçlu', guarantor: 'Kefil' }[ack.kind] + ' kaydı',
          ack.count + ' eşleşme',
          'Gerekçe: ' + ack.reason,
        ],
      },
    ];
    send(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/privacy/reveal' && req.method === 'POST') {
    // A user opened every masked personal value at once, or exported personal data to a file.
    const input = await body(req),
      area = typeof input?.area === 'string' ? input.area.trim().slice(0, 120) : '',
      count = Number.isSafeInteger(input?.count) && input.count > 0 && input.count < 100000 ? input.count : 0;
    if (!area) throw fail(400, 'Geçersiz istek.');
    const exported = input.kind === 'export';
    res.hanAuditEvents = [
      {
        action: exported ? 'download' : 'reveal',
        area: 'Gizli Kişisel Veriler',
        ref: area,
        fields: [count + (exported ? ' kayıt' : ' alan')],
      },
    ];
    send(res, 200, { ok: true });
    return true;
  }
  return false;
}
module.exports = { handleComplianceRoutes };
