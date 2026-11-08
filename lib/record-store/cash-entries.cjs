const { actor } = require('./queries.cjs');
async function cashScope(db, request) {
  const u = await actor(db, request.req);
  let input;
  try {
    input = JSON.parse(request.raw);
  } catch {
    throw Object.assign(Error('Geçersiz işlem.'), { status: 400 });
  }
  if (!input?.id) return null; // Older clients retain their existing validation path.
  if (typeof input.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.id))
    throw Object.assign(Error('Geçersiz işlem numarası.'), { status: 400 });
  if (
    !['ceo', 'admin'].includes(u.role) &&
    !(u.permissions || []).some((p) => ['cashIn', 'cashOut'].includes(p))
  )
    throw Object.assign(Error('İşlem yetkiniz yok.'), { status: 403 });
  const ids = [input.accountId, ...(input.type === 'transfer' ? [input.destination] : [])];
  if (ids.some((id) => typeof id !== 'string' || !id || id.length > 200))
    throw Object.assign(Error('Geçersiz hesap.'), { status: 400 });
  await db.query(
    'SELECT id FROM han_data.accounts WHERE id=ANY($1::text[]) AND active ORDER BY id FOR UPDATE',
    [ids],
  );
  const {
    rows: [existing],
  } = await db.query('SELECT active FROM han_data.ledger_entries WHERE id=$1', [input.id]);
  if (existing && !existing.active)
    throw Object.assign(Error('Arşivlenmiş işlem numarası kullanılamaz.'), { status: 409 });
  return {
    tables: ['accounts', 'ledger_entries'],
    cashId: input.id,
    cashAccount: input.accountId,
    cashOutgoing: !['in', 'external'].includes(input.type),
  };
}
module.exports = { cashScope };
