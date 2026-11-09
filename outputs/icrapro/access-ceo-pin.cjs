const pin = require('../../lib/ceo-pin.cjs');
const crypto = require('node:crypto');
const { sessionKey } = require('../../lib/session-policy.cjs');
async function handleCeoPin(ctx) {
  const { url, req, res, u, body, send, fail, persistMetadata, passwordOK } = ctx;
  if (!url.pathname.startsWith('/api/ceo-pin/')) return false;
  if (u?.role !== 'ceo' || u.readOnly) throw fail(403, 'CEO yetkisi gerekli.');
  const current = ctx.state.ceoPin;
  if (url.pathname === '/api/ceo-pin/status' && req.method === 'GET') {
    send(res, 200, { configured: !!current?.hash, scopes: current?.scopes || pin.scopes });
    return true;
  }
  if (req.method !== 'POST') throw fail(405, 'Yöntem desteklenmiyor.');
  const input = await body(req);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'Geçersiz PIN işlemi.');
  if (url.pathname === '/api/ceo-pin/config') {
    if (!(await passwordOK(input.currentPassword, u))) throw fail(403, 'Mevcut hesap şifresi doğrulanamadı.');
    if (typeof input.pin !== 'string' || !/^[0-9]{4}$/.test(input.pin))
      throw fail(400, 'PIN dört rakamdan oluşmalıdır.');
    if (!Array.isArray(input.scopes) || input.scopes.some((scope) => !pin.scopes.includes(scope)))
      throw fail(400, 'Korunacak alanları seçin.');
    const record = await pin.createPin(input.pin);
    const next = structuredClone(ctx.state);
    next.ceoPin = {
      ...record,
      proofKey: crypto.randomBytes(32).toString('hex'),
      scopes: [...new Set(input.scopes)],
    };
    persistMetadata(next);
    send(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/ceo-pin/verify') {
    if (!current?.hash || !current.scopes?.includes(input.scope))
      throw fail(400, 'PIN koruması yapılandırılmamış.');
    const checked = await pin.checkPin(input.pin, current);
    const next = structuredClone(ctx.state);
    next.ceoPin = checked.record;
    persistMetadata(next);
    // Failed attempts must commit in PostgreSQL as well as local storage.
    send(
      res,
      200,
      checked.ok
        ? { ok: true, proof: pin.issueProof(current, sessionKey(req), input.scope) }
        : {
            ok: false,
            error: checked.lockedUntil
              ? 'PIN denemeleri geçici olarak kilitlendi. 15 dakika sonra tekrar deneyin.'
              : 'PIN hatalı.',
          },
    );
    return true;
  }
  throw fail(404, 'İşlem bulunamadı.');
}
module.exports = { handleCeoPin };
