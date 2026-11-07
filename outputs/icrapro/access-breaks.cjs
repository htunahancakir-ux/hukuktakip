const { staffBreakStatus, changeStaffBreak } = require('../../lib/staff-breaks.cjs');
async function handleBreakRoutes(ctx) {
  const { req, res, url, u, send, fail, body, persist, userEnabled } = ctx;
  if (url.pathname !== '/api/staff-breaks') return false;
  if (u.role !== 'staff') throw fail(403, 'Mola düğmesi personel hesapları içindir.');
  if (req.method === 'GET') {
    send(res, 200, staffBreakStatus(ctx.state, u));
    return true;
  }
  if (req.method !== 'POST') throw fail(405, 'Yöntem desteklenmiyor.');
  const result = changeStaffBreak(ctx.state, u, await body(req), { userEnabled });
  if (result.next) (ctx.persistMetadata || persist)(result.next);
  send(res, 200, result.status);
  return true;
}
module.exports = { handleBreakRoutes };
